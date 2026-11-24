#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
#
# 容器镜像端到端测试:用 docker 起【真实发布镜像】(PostgreSQL 与 SQLite 各一轮),
# 在宿主机上跑 test-e2e / test-cli,再校验容器重启持久化、非 root 运行、ffmpeg/jemalloc 就绪、健康检查。
#
# 用法:
#   scripts/test-docker.sh [镜像]            # 默认 ghcr.io/dming623/picgalleryserver:latest
#   DRIVERS=sqlite scripts/test-docker.sh    # 只测 SQLite
#   SAMPLES_DIR=/tmp/pgs-samples PG_IMAGE=postgres:16 PORT_BASE=3200 scripts/test-docker.sh
#
# 要求:docker、node(≥22,宿主机跑测试脚本)、已执行过 npm ci(脚本依赖 sharp/exifr)。
# 挂载测试:宿主机目录 $T/mnt ↔ 容器 /photos(默认在白名单内),因此 MOUNT_HOST_DIR/MOUNT_SERVER_DIR 不同。
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE="${1:-${IMAGE:-ghcr.io/dming623/picgalleryserver:latest}}"
DRIVERS="${DRIVERS:-postgres sqlite}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
PORT_BASE="${PORT_BASE:-3200}"
SAMPLES_DIR="${SAMPLES_DIR:-/tmp/pgs-samples}"
PASS="test-pass-123"
FAILED=0
LOGS=()

command -v docker >/dev/null || { echo "未找到 docker;本脚本需要在有 Docker 的环境(如 InstaBox 测试机)运行"; exit 2; }
[ -f "$SAMPLES_DIR/manifest.json" ] || node scripts/fetch-samples.mjs --out "$SAMPLES_DIR" || exit 2

step() { echo; echo "######## $* ########"; }
check() { # check "描述" 命令...
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ✓ $d"; else echo "  ✗ FAIL $d"; FAILED=$((FAILED+1)); fi
}

docker pull "$IMAGE" >/dev/null 2>&1 || echo "(拉取失败,尝试使用本地已有镜像 $IMAGE)"
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "镜像不存在: $IMAGE"; exit 2; }

idx=0
for DRIVER in $DRIVERS; do
  PORT=$((PORT_BASE + idx)); idx=$((idx+1))
  T="$(mktemp -d /tmp/pgs-docker-$DRIVER-XXXXXX)"
  mkdir -p "$T/data" "$T/mnt"; chmod 777 "$T/data" "$T/mnt"
  NAME="pgs-test-$DRIVER"; PGNAME="pgs-test-pg-$DRIVER"; NET="pgs-test-net-$DRIVER"
  cleanup() { docker rm -f "$NAME" "$PGNAME" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
  cleanup
  step "$DRIVER:启动 $IMAGE (端口 $PORT)"
  ENVS=(-e ADMIN_PASSWORD="$PASS" -e SESSION_SECRET=test-secret -e MIN_FREE_DISK_MB=0 -e HD_SCAN_DISTINCT=9 -e DB_DRIVER="$DRIVER")
  if [ "$DRIVER" = postgres ]; then
    docker network create "$NET" >/dev/null
    docker run -d --name "$PGNAME" --network "$NET" -e POSTGRES_PASSWORD=pgs -e POSTGRES_DB=pgs "$PG_IMAGE" >/dev/null
    for i in $(seq 1 40); do docker exec "$PGNAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
    ENVS+=(-e DATABASE_URL="postgresql://postgres:pgs@$PGNAME:5432/pgs")
    NETARG=(--network "$NET")
  else
    ENVS+=(-e SQLITE_FILE=/app/data/pgs.sqlite)
    NETARG=()
  fi
  run_app() { docker run -d --name "$NAME" "${NETARG[@]}" -p "127.0.0.1:$PORT:3000" "${ENVS[@]}" -v "$T/data:/app/data" -v "$T/mnt:/photos" "$IMAGE" >/dev/null; }
  run_app
  BASE="http://127.0.0.1:$PORT"
  ready=0
  for i in $(seq 1 90); do curl -fs "$BASE/api/v1/health/ready" >/dev/null 2>&1 && { ready=1; break; }; sleep 1; done
  [ $ready = 1 ] || { echo "服务未就绪"; docker logs --tail 60 "$NAME"; FAILED=$((FAILED+1)); cleanup; continue; }

  step "$DRIVER:容器环境检查"
  # 注意:镜像没有 USER 指令,入口脚本以 root 启动、再用 setpriv 降权到 node(1000)。
  # 因此 `docker exec id -u` 恒为 0,不能据此判断;必须查应用进程(next-server)自身的 uid。
  check "应用进程非 root 运行(uid=1000)" bash -c "docker exec $NAME sh -c 'for p in /proc/[0-9]*; do case \"\$(cat \$p/comm 2>/dev/null)\" in next*) awk \"/^Uid:/{print \\\$2}\" \$p/status;; esac; done' | grep -qx 1000"
  check "容器内有 ffmpeg / ffprobe" docker exec "$NAME" sh -c 'ffmpeg -version && ffprobe -version'
  # jemalloc 由入口脚本 export LD_PRELOAD 后注入;镜像内无 ps/pgrep,且 root 读 uid1000 进程的
  # /proc/*/maps 会被 ptrace 权限拒绝,故以 -u 1000 遍历 /proc 检查 maps 中的 libjemalloc。
  check "jemalloc 已加载到应用进程" bash -c "docker exec -u 1000 $NAME sh -c 'for p in /proc/[0-9]*; do grep -qa libjemalloc \$p/maps 2>/dev/null && echo yes; done' | grep -q yes"
  check "/api/health 返回 200" curl -fs "$BASE/api/health"
  echo "  node: $(docker exec $NAME node -v)  时区: $(docker exec $NAME date +%Z)"

  step "$DRIVER:E2E(容器内 /photos ↔ 宿主 $T/mnt)"
  BASE="$BASE" ADMIN_PASSWORD="$PASS" SAMPLES_DIR="$SAMPLES_DIR" TEST_LABEL="docker-$DRIVER" \
    MOUNT_HOST_DIR="$T/mnt" MOUNT_SERVER_DIR=/photos node scripts/test-e2e.mjs || FAILED=$((FAILED+1))
  step "$DRIVER:CLI"
  BASE="$BASE" ADMIN_PASSWORD="$PASS" SAMPLES_DIR="$SAMPLES_DIR" TEST_LABEL="docker-$DRIVER" \
    MOUNT_HOST_DIR="$T/mnt" MOUNT_SERVER_DIR=/photos node scripts/test-cli.mjs || FAILED=$((FAILED+1))
  step "$DRIVER:HD(无 DATA_DIR 的黑盒部分)"
  BASE="$BASE" ADMIN_PASSWORD="$PASS" SESSION_SECRET=test-secret DATA_DIR="$T/data" HD_SCAN_DISTINCT=9 node scripts/test-hd.mjs || FAILED=$((FAILED+1))

  step "$DRIVER:重启容器后数据保持"
  BEFORE=$(curl -fs -u "admin:$PASS" "$BASE/api/v1/status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).data.counts;console.log(c.total+"/"+c.albums+"/"+c.users)})')
  docker restart "$NAME" >/dev/null
  for i in $(seq 1 90); do curl -fs "$BASE/api/v1/health/ready" >/dev/null 2>&1 && break; sleep 1; done
  AFTER=$(curl -fs -u "admin:$PASS" "$BASE/api/v1/status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).data.counts;console.log(c.total+"/"+c.albums+"/"+c.users)})')
  check "重启前后 媒体/相册/用户 数一致 ($BEFORE → $AFTER)" test "$BEFORE" = "$AFTER"
  check "容器 HEALTHCHECK 状态为 healthy(最多等 60s)" bash -c "for i in \$(seq 1 30); do [ \"\$(docker inspect -f '{{.State.Health.Status}}' $NAME)\" = healthy ] && exit 0; sleep 2; done; exit 1"
  LOGS+=("$DRIVER: docker logs $NAME")
  if docker logs "$NAME" 2>&1 | grep -E "unhandled error|SIGBUS|TypeError|Failed query" | head -5 | grep -q .; then
    echo "  ⚠ 容器日志含异常行:"; docker logs "$NAME" 2>&1 | grep -E "unhandled error|SIGBUS|TypeError|Failed query" | head -5
  fi
  cleanup
  rm -rf "$T" 2>/dev/null || true
done

echo; echo "==================== Docker 测试总结 ===================="
[ "$FAILED" = 0 ] && echo "全部通过" || echo "$FAILED 项失败"
exit "$FAILED"
