#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
#
# 容器镜像端到端测试:用 docker 起【真实发布镜像】(PostgreSQL 与 SQLite 各一轮),
# 在宿主机上跑 test-e2e / test-cli / test-hd,再校验:非 root 运行、ffmpeg/jemalloc、cgroup 观测、
# 环境变量是否真正传进容器并生效、媒体内存治理(test-media)、容器重启持久化、HEALTHCHECK。
#
# 用法:
#   scripts/test-docker.sh [镜像]                 # 默认 ghcr.io/dming623/picgalleryserver:latest
#   DRIVERS=sqlite scripts/test-docker.sh         # 只测 SQLite
#   RUN_AS=1000 scripts/test-docker.sh            # 以 docker run --user 1000:1000 直接非 root 启动(InstaBox 等平台的方式)
#   RUN_AS=12345 scripts/test-docker.sh           # 任意非 root uid(验证镜像不依赖 uid=1000)
#   MEM_LIMIT=1g CPUS=1 scripts/test-docker.sh    # 带 cgroup 内存/CPU 限制运行(同时校验 /status 的 cgroup 与预算推导)
#   SAMPLES_DIR=/tmp/pgs-samples PG_IMAGE=postgres:16 PORT_BASE=3200 scripts/test-docker.sh
#
# 环境变量:
#   RUN_AS     entry(默认)= 按镜像默认方式启动(入口脚本以 root 起、修正数据目录属主后 setpriv 降权到 uid 1000);
#              数字 uid[:gid] = docker run --user,容器从第一条指令起就是非 root(入口脚本的 root 分支不会执行)
#   DOCKER     docker 命令(默认 docker;宿主机用户不在 docker 组时用 DOCKER="sudo docker")
#   TEST_TMP   临时目录根(默认 $TMPDIR 或 /tmp)
#   SKIP_MEDIA=1 跳过 test-media 阶段
#
# 要求:docker、node(≥22,宿主机跑测试脚本)、已执行过 npm ci(脚本依赖 sharp/exifr)、curl。**不需要 root**(见 DOCKER)。
# 挂载测试:宿主机目录 $T/mnt ↔ 容器 /photos(默认在白名单内),因此 MOUNT_HOST_DIR/MOUNT_SERVER_DIR 不同。
# 退出码:0 全部通过;N>0 = N 项失败;2 = 环境不满足(无 docker / 无镜像 / 无素材)。
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE="${1:-${IMAGE:-ghcr.io/dming623/picgalleryserver:latest}}"
DOCKER="${DOCKER:-docker}"
DRIVERS="${DRIVERS:-postgres sqlite}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
PORT_BASE="${PORT_BASE:-3200}"
SAMPLES_DIR="${SAMPLES_DIR:-/tmp/pgs-samples}"
RUN_AS="${RUN_AS:-entry}"
MEM_LIMIT="${MEM_LIMIT:-}"
CPUS="${CPUS:-}"
TMP_ROOT="${TEST_TMP:-${TMPDIR:-/tmp}}"
PASS="test-pass-123"
FAILED=0

# ---- 环境前置检查(给出可操作的提示,而不是一串 docker 报错)----
command -v "${DOCKER%% *}" >/dev/null 2>&1 || { echo "未找到 docker;本脚本需要在有 Docker 的环境(如 InstaBox 测试机)运行"; exit 2; }
if ! $DOCKER info >/dev/null 2>&1; then
  echo "无法连接 Docker 守护进程。当前用户 $(id -un)(uid $(id -u))可能不在 docker 组;可用: DOCKER=\"sudo docker\" $0 ..."
  exit 2
fi
command -v curl >/dev/null 2>&1 || { echo "需要 curl"; exit 2; }
command -v node >/dev/null 2>&1 || { echo "需要 node(≥22)在宿主机运行测试脚本"; exit 2; }
[ -d node_modules/sharp ] || { echo "请先在仓库根目录执行 npm ci(测试脚本依赖 sharp / exifr)"; exit 2; }
[ -f "$SAMPLES_DIR/manifest.json" ] || node scripts/fetch-samples.mjs --out "$SAMPLES_DIR" || exit 2

# ---- 运行身份 ----
USER_ARGS=()
EXPECT_UID=1000
case "$RUN_AS" in
  entry) ;;
  *[!0-9:]* | "") echo "RUN_AS 只能是 entry 或 数字 uid[:gid],收到: $RUN_AS"; exit 2 ;;
  *) UID_PART="${RUN_AS%%:*}"; GID_PART="${RUN_AS#*:}"; [ "$GID_PART" = "$RUN_AS" ] && GID_PART="$UID_PART"
     [ "$UID_PART" != "0" ] || { echo "RUN_AS=0 不是非 root 场景;要测默认(root 入口降权)请用 RUN_AS=entry"; exit 2; }
     USER_ARGS=(--user "$UID_PART:$GID_PART"); EXPECT_UID="$UID_PART" ;;
esac
LIMIT_ARGS=()
[ -n "$MEM_LIMIT" ] && LIMIT_ARGS+=(--memory "$MEM_LIMIT")
[ -n "$CPUS" ] && LIMIT_ARGS+=(--cpus "$CPUS")

step() { echo; echo "######## $* ########"; }
check() { # check "描述" 命令...
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ✓ $d"; else echo "  ✗ FAIL $d"; FAILED=$((FAILED+1)); fi
}
# 宿主机上读 /status 的某个字段(点路径),失败输出空
sfield() { # sfield BASE "config.thumbConcurrency"
  curl -fs -u "admin:$PASS" "$1/api/v1/status" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s).data);console.log(v===undefined?"":typeof v==="object"?JSON.stringify(v):v)}catch{console.log("")}})' "$2"
}
wait_ready() { for _ in $(seq 1 90); do curl -fs "$1/api/v1/health/ready" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
# 容器写入的文件属主可能是 uid 1000/任意 uid,宿主机普通用户删不掉:用一次性 root 容器清理
rm_tree() {
  [ -n "$1" ] && [ -d "$1" ] || return 0
  $DOCKER run --rm -v "$1:/t" --entrypoint sh --user 0:0 "$IMAGE" -c 'rm -rf /t/* /t/.[!.]* 2>/dev/null; true' >/dev/null 2>&1
  rm -rf "$1" 2>/dev/null || true
}

$DOCKER pull "$IMAGE" >/dev/null 2>&1 || echo "(拉取失败,尝试使用本地已有镜像 $IMAGE)"
$DOCKER image inspect "$IMAGE" >/dev/null 2>&1 || { echo "镜像不存在: $IMAGE"; exit 2; }
echo "镜像: $IMAGE   运行身份: RUN_AS=$RUN_AS(期望应用 uid=$EXPECT_UID)   限制: mem=${MEM_LIMIT:-无} cpus=${CPUS:-无}   宿主机用户: $(id -un)($(id -u))"

TMPS=()
NAMES=()
cleanup_all() {
  for n in ${NAMES[@]+"${NAMES[@]}"}; do [ -n "$n" ] && $DOCKER rm -f "$n" >/dev/null 2>&1; done
  for d in ${TMPS[@]+"${TMPS[@]}"}; do rm_tree "$d"; done
  for d in postgres sqlite; do $DOCKER network rm "pgs-test-net-$d" >/dev/null 2>&1; done
}
trap cleanup_all EXIT
trap 'echo; echo "被中断,清理容器…"; exit 130' INT TERM

app_uid_ok() { # 应用进程(next-server)自身的 uid:镜像无 ps/pgrep,遍历 /proc;docker exec 默认用户可能是 root,故以进程 status 为准
  $DOCKER exec "$1" sh -c 'for p in /proc/[0-9]*; do case "$(cat $p/comm 2>/dev/null)" in next*) awk "/^Uid:/{print \$2}" $p/status;; esac; done' 2>/dev/null | grep -qx "$EXPECT_UID"
}

idx=0
for DRIVER in $DRIVERS; do
  PORT=$((PORT_BASE + idx)); idx=$((idx+1))
  T="$(mktemp -d "$TMP_ROOT/pgs-docker-$DRIVER-XXXXXX")"; TMPS+=("$T")
  mkdir -p "$T/data" "$T/mnt"; chmod 777 "$T/data" "$T/mnt"   # 任意 uid 的容器都要能写
  NAME="pgs-test-$DRIVER"; PGNAME="pgs-test-pg-$DRIVER"; NET="pgs-test-net-$DRIVER"; NAMES+=("$NAME" "$PGNAME")
  $DOCKER rm -f "$NAME" "$PGNAME" >/dev/null 2>&1; $DOCKER network rm "$NET" >/dev/null 2>&1
  step "$DRIVER:启动 $IMAGE (端口 $PORT)"
  # 并发/内存相关变量用「无前缀名」直接传:验证容器内确实按这些值生效(见下方「环境变量生效」检查)
  ENVS=(-e ADMIN_PASSWORD="$PASS" -e SESSION_SECRET=test-secret -e MIN_FREE_DISK_MB=0 -e HD_SCAN_DISTINCT=9
        -e ALLOWED_HOSTS="127.0.0.1:$PORT,127.0.0.1" -e DB_DRIVER="$DRIVER"
        -e THUMB_CONCURRENCY=2 -e HD_CONCURRENCY=1 -e SHARP_CONCURRENCY=1 -e HEIC_CONCURRENCY=1)
  NETARG=()
  if [ "$DRIVER" = postgres ]; then
    $DOCKER network create "$NET" >/dev/null
    $DOCKER run -d --name "$PGNAME" --network "$NET" -e POSTGRES_PASSWORD=pgs -e POSTGRES_DB=pgs "$PG_IMAGE" >/dev/null
    for _ in $(seq 1 40); do $DOCKER exec "$PGNAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
    ENVS+=(-e DATABASE_URL="postgresql://postgres:pgs@$PGNAME:5432/pgs")
    NETARG=(--network "$NET")
  else
    ENVS+=(-e SQLITE_FILE=/app/data/pgs.sqlite)
  fi
  $DOCKER run -d --name "$NAME" ${NETARG[@]+"${NETARG[@]}"} ${USER_ARGS[@]+"${USER_ARGS[@]}"} ${LIMIT_ARGS[@]+"${LIMIT_ARGS[@]}"} -p "127.0.0.1:$PORT:3000" "${ENVS[@]}" \
    -v "$T/data:/app/data" -v "$T/mnt:/photos" "$IMAGE" >/dev/null
  BASE="http://127.0.0.1:$PORT"
  if ! wait_ready "$BASE"; then
    echo "服务未就绪"; $DOCKER logs --tail 60 "$NAME"; FAILED=$((FAILED+1)); continue
  fi

  step "$DRIVER:容器环境检查"
  # 注意:RUN_AS=entry 时 `docker exec id -u` 恒为 0(入口脚本以 root 启动再降权),不能据此判断,必须查应用进程自身的 uid。
  check "应用进程以 uid=$EXPECT_UID 运行(非 root)" app_uid_ok "$NAME"
  check "容器内有 ffmpeg / ffprobe" $DOCKER exec "$NAME" sh -c 'ffmpeg -version && ffprobe -version'
  # jemalloc 由入口脚本 export LD_PRELOAD 注入;镜像内无 ps/pgrep,且 root 读其它 uid 进程的 /proc/*/maps 可能被拒,
  # 故以应用自身 uid 遍历 /proc 检查 maps 中的 libjemalloc。
  check "jemalloc 已加载到应用进程" bash -c "$DOCKER exec -u $EXPECT_UID $NAME sh -c 'for p in /proc/[0-9]*; do grep -qa libjemalloc \$p/maps 2>/dev/null && echo yes; done' | grep -q yes"
  check "/api/health 返回 200" curl -fs "$BASE/api/health"
  check "数据目录对应用可写(health/ready 的 dataDir 检查)" bash -c "curl -fs '$BASE/api/v1/health/ready' | grep -q '\"dataDir\":{\"ok\":true'"
  check "容器内 /app/data 内建的子目录属主为应用 uid(不是 root,否则非 root 无法写)" bash -c "[ \"\$($DOCKER exec $NAME sh -c 'stat -c %u /app/data/albums 2>/dev/null || stat -c %u /app/data')\" != 0 ]"
  echo "  node: $($DOCKER exec "$NAME" node -v)  时区: $($DOCKER exec "$NAME" date +%Z)"

  step "$DRIVER:配置传递与观测(无前缀环境变量必须真正生效)"
  check "容器 printenv 含 THUMB_CONCURRENCY=2 / HD_CONCURRENCY=1" bash -c "$DOCKER exec $NAME printenv | grep -qx 'THUMB_CONCURRENCY=2' && $DOCKER exec $NAME printenv | grep -qx 'HD_CONCURRENCY=1'"
  check "/status config.thumbConcurrency = 2" test "$(sfield "$BASE" config.thumbConcurrency)" = 2
  check "/status config.hdConcurrency = 1" test "$(sfield "$BASE" config.hdConcurrency)" = 1
  check "/status config.sharpConcurrency = 1" test "$(sfield "$BASE" config.sharpConcurrency)" = 1
  check "/status 暴露 memory.external / arrayBuffers / sharp / eventLoop / queue.admission" bash -c "[ -n \"$(sfield "$BASE" memory.external)\" ] && [ -n \"$(sfield "$BASE" memory.arrayBuffers)\" ] && [ -n \"$(sfield "$BASE" sharp.concurrency)\" ] && [ -n \"$(sfield "$BASE" eventLoop.p99Ms)\" ] && [ -n \"$(sfield "$BASE" queue.admission.budgetMB)\" ]"
  CGMAX="$(sfield "$BASE" memory.cgroup.max)"
  if [ -n "$MEM_LIMIT" ]; then
    check "容器内读到 cgroup 内存上限(memory.cgroup.max 非空,anon 可读)" bash -c "[ -n '$CGMAX' ] && [ -n \"$(sfield "$BASE" memory.cgroup.anon)\" ]"
    LIMMB="$(sfield "$BASE" config.mediaBudget.derivation.limitMb)"
    echo "  cgroup.max=$CGMAX  推导上限=${LIMMB}MB  媒体预算=$(sfield "$BASE" config.mediaBudget.budgetMB)MB  硬限制=$(sfield "$BASE" config.mediaBudget.hardMaxMB)MB"
    check "预算推导采用了容器内存上限(limitMb 在 --memory $MEM_LIMIT 的 ±5% 内)" node -e "
      const m='$MEM_LIMIT'.toLowerCase(); const mult={k:1/1024,m:1,g:1024}[m.slice(-1)]||1/1048576;
      const want=parseFloat(m)*mult, got=Number('$LIMMB'); process.exit(Math.abs(got-want)<=want*0.05?0:1)"
  else
    echo "  cgroup.max=${CGMAX:-null}(未指定 MEM_LIMIT;带限制运行请设 MEM_LIMIT=1g)"
  fi

  step "$DRIVER:E2E(容器内 /photos ↔ 宿主 $T/mnt)"
  BASE="$BASE" ADMIN_PASSWORD="$PASS" SAMPLES_DIR="$SAMPLES_DIR" TEST_LABEL="docker-$DRIVER" \
    MOUNT_HOST_DIR="$T/mnt" MOUNT_SERVER_DIR=/photos node scripts/test-e2e.mjs || FAILED=$((FAILED+1))
  step "$DRIVER:CLI"
  BASE="$BASE" ADMIN_PASSWORD="$PASS" SAMPLES_DIR="$SAMPLES_DIR" TEST_LABEL="docker-$DRIVER" \
    MOUNT_HOST_DIR="$T/mnt" MOUNT_SERVER_DIR=/photos node scripts/test-cli.mjs || FAILED=$((FAILED+1))
  step "$DRIVER:HD(含游客水印成品缓存;DATA_DIR 指向宿主机上的数据卷)"
  BASE="$BASE" ADMIN_PASSWORD="$PASS" SESSION_SECRET=test-secret DATA_DIR="$T/data" HD_SCAN_DISTINCT=9 node scripts/test-hd.mjs || FAILED=$((FAILED+1))

  step "$DRIVER:重启容器后数据保持"
  counts() { sfield "$BASE" counts | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c=JSON.parse(s);console.log(c.total+"/"+c.albums+"/"+c.users)}catch{console.log("?")}})'; }
  BEFORE="$(counts)"
  $DOCKER restart "$NAME" >/dev/null
  wait_ready "$BASE" || true
  AFTER="$(counts)"
  check "重启前后 媒体/相册/用户 数一致 ($BEFORE → $AFTER)" test "$BEFORE" = "$AFTER" -a "$BEFORE" != "?"
  check "容器重启后应用仍以 uid=$EXPECT_UID 运行" app_uid_ok "$NAME"
  check "容器 HEALTHCHECK 状态为 healthy(最多等 60s)" bash -c "for _ in \$(seq 1 30); do [ \"\$($DOCKER inspect -f '{{.State.Health.Status}}' $NAME)\" = healthy ] && exit 0; sleep 2; done; exit 1"
  if $DOCKER logs "$NAME" 2>&1 | grep -E "unhandled error|SIGBUS|TypeError|Failed query|EACCES" | head -5 | grep -q .; then
    echo "  ⚠ 容器日志含异常行:"; $DOCKER logs "$NAME" 2>&1 | grep -E "unhandled error|SIGBUS|TypeError|Failed query|EACCES" | head -5
    [ "$RUN_AS" != entry ] && echo "    (非 root 直接启动时出现 EACCES 通常表示某个目录对该 uid 不可写,请把完整日志发给开发者)"
  fi
  $DOCKER rm -f "$NAME" "$PGNAME" >/dev/null 2>&1; $DOCKER network rm "$NET" >/dev/null 2>&1
  rm_tree "$T"
done

# ---- 媒体内存治理(test-media):单独起一个 MEDIA_MAX_INPUT_MP=10 的 SQLite 容器 ----
if [ "${SKIP_MEDIA:-0}" != 1 ]; then
  step "媒体内存治理(MEDIA_MAX_INPUT_MP=10, SHARP_CONCURRENCY=1)"
  MP=$((PORT_BASE + 20)); MT="$(mktemp -d "$TMP_ROOT/pgs-docker-media-XXXXXX")"; TMPS+=("$MT"); chmod 777 "$MT"; mkdir -p "$MT/data"; chmod 777 "$MT/data"
  MNAME="pgs-test-media"; NAMES+=("$MNAME"); $DOCKER rm -f "$MNAME" >/dev/null 2>&1
  $DOCKER run -d --name "$MNAME" ${USER_ARGS[@]+"${USER_ARGS[@]}"} ${LIMIT_ARGS[@]+"${LIMIT_ARGS[@]}"} -p "127.0.0.1:$MP:3000" \
    -e ADMIN_PASSWORD="$PASS" -e SESSION_SECRET=test-secret -e MIN_FREE_DISK_MB=0 -e DB_DRIVER=sqlite -e SQLITE_FILE=/app/data/pgs.sqlite \
    -e MEDIA_MAX_INPUT_MP=10 -e SHARP_CONCURRENCY=1 -v "$MT/data:/app/data" "$IMAGE" >/dev/null
  if wait_ready "http://127.0.0.1:$MP"; then
    BASE="http://127.0.0.1:$MP" ADMIN_PASSWORD="$PASS" DATA_DIR="$MT/data" EXPECT_MAX_INPUT_MP=10 node scripts/test-media.mjs || FAILED=$((FAILED+1))
  else
    echo "media 容器未就绪"; $DOCKER logs --tail 40 "$MNAME"; FAILED=$((FAILED+1))
  fi
fi

echo; echo "==================== Docker 测试总结(RUN_AS=$RUN_AS) ===================="
[ "$FAILED" = 0 ] && echo "全部通过" || echo "$FAILED 项失败"
exit "$FAILED"
