#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
#
# 在【真实镜像】里跑内存/耗时基准(最接近线上:jemalloc + MALLOC_ARENA_MAX=2 + cgroup 内存/CPU 限制 + 非 root),
# 可按 1G / 2G / 4G 三档各跑一遍,把结果落到宿主机目录。**不需要 root**;docker 命令见 DOCKER。
#
# 用法:
#   scripts/bench-docker.sh [镜像]                          # 默认 ghcr.io/dming623/picgalleryserver:latest,档位 1g 2g 4g,套件 memory hd queue
#   TIERS="1g" SUITES="hd queue" scripts/bench-docker.sh    # 只跑 1G 档的 hd 与 queue
#   RUN_AS=12345 scripts/bench-docker.sh                    # 以任意非 root uid 运行(默认 1000;InstaBox 一类平台)
#   REAL_DIR=/path/with/heic scripts/bench-docker.sh        # 目录里放真实 .heic,队列基准会额外跑「HEIC + JPEG 混合」
#   OUT=$PWD/bench-out QUICK=0 scripts/bench-docker.sh      # 结果目录、是否全量(默认 QUICK=1:像素缩小,约十几分钟)
#
# 档位 → 推荐配置(与 README「资源建议」一致):1g: 1 核/堆 320MB/UV 4/SHARP 1/THUMB 2/HD 1;
#                                              2g: 2 核/堆 600MB/UV 8/SHARP 2/THUMB 3/HD 2;4g: 2 核/堆 1200MB/UV 8/SHARP 2/THUMB 3/HD 2。
#
# 输出:$OUT/<档位>/{memory,hd,queue}.json 与 .md(Markdown 表)。对比不同版本时必须「同档位、同素材、同 QUICK」。
# 退出码:0 完成;2 = 环境不满足。个别套件失败不会中止其它套件,最后汇总。
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE="${1:-${IMAGE:-ghcr.io/dming623/picgalleryserver:latest}}"
DOCKER="${DOCKER:-docker}"
TIERS="${TIERS:-1g 2g 4g}"
SUITES="${SUITES:-memory hd queue}"
RUN_AS="${RUN_AS:-1000}"
QUICK="${QUICK:-1}"
OUT="${OUT:-$PWD/bench-out}"
REAL_DIR="${REAL_DIR:-}"
FAILED=0

command -v "${DOCKER%% *}" >/dev/null 2>&1 || { echo "未找到 docker"; exit 2; }
$DOCKER info >/dev/null 2>&1 || { echo "无法连接 Docker 守护进程(当前用户 $(id -un) 可能不在 docker 组;可用 DOCKER=\"sudo docker\")"; exit 2; }
case "$RUN_AS" in ""|*[!0-9:]*) echo "RUN_AS 必须是数字 uid[:gid]"; exit 2 ;; esac
[ "${RUN_AS%%:*}" != 0 ] || { echo "基准以非 root 运行(与线上一致),RUN_AS 不能是 0"; exit 2; }
[ "${RUN_AS#*:}" = "$RUN_AS" ] && RUN_AS="$RUN_AS:$RUN_AS"
$DOCKER pull "$IMAGE" >/dev/null 2>&1 || echo "(拉取失败,尝试使用本地已有镜像)"
$DOCKER image inspect "$IMAGE" >/dev/null 2>&1 || { echo "镜像不存在: $IMAGE"; exit 2; }
# 镜像里必须有 scripts/bench 与 .next(.dockerignore 未排除 scripts/;若是旧镜像没有则提示)
$DOCKER run --rm --entrypoint sh "$IMAGE" -c 'test -f /app/scripts/bench/lib.mjs && test -d /app/.next' \
  || { echo "该镜像不含 scripts/bench/lib.mjs 或 .next:请使用包含本脚本版本的镜像(或把仓库挂进去: 见 scripts/bench/README.md)"; exit 2; }
[ -z "$REAL_DIR" ] || [ -d "$REAL_DIR" ] || { echo "REAL_DIR 不存在: $REAL_DIR"; exit 2; }

mkdir -p "$OUT"; chmod 777 "$OUT" 2>/dev/null || true
Q=""; [ "$QUICK" = 1 ] && Q="--quick"

# 档位参数:cpus heap uv sharp thumb hd
tier_params() {
  case "$1" in
    1g) echo "1.0 320 4 1 2 1" ;;
    2g) echo "2.0 600 8 2 3 2" ;;
    4g) echo "2.0 1200 8 2 3 2" ;;
    *)  echo "2.0 600 8 2 3 2" ;;   # 其它值(如 512m / 8g)用 2g 档的并发,内存上限照用户给的
  esac
}

run_in_container() { # run_in_container <mem> <cpus> <heap> <uv> <sharp> <thumb> <hd> <tierdir> <命令字符串>
  local mem="$1" cpus="$2" heap="$3" uv="$4" sharp="$5" thumb="$6" hd="$7" dir="$8" cmd="$9"
  local mounts=(-v "$dir:/bench")
  [ -n "$REAL_DIR" ] && mounts+=(-v "$(cd "$REAL_DIR" && pwd):/real:ro")
  # 绕过 pgs-entrypoint(它在 root 下才会 setpriv),但复刻它的 jemalloc 探测;HOME 指向可写目录,避免非 root 写 ~/.cache 失败
  $DOCKER run --rm --user "$RUN_AS" --memory "$mem" --cpus "$cpus" --entrypoint sh \
    -e HOME=/tmp -e MALLOC_ARENA_MAX=2 -e UV_THREADPOOL_SIZE="$uv" -e NODE_OPTIONS="--max-old-space-size=$heap" \
    -e THUMB_CONCURRENCY="$thumb" -e HD_CONCURRENCY="$hd" -e SHARP_CONCURRENCY="$sharp" -e TEST_TMP=/bench/tmp \
    "${mounts[@]}" "$IMAGE" -c '
      for p in /usr/lib/x86_64-linux-gnu/libjemalloc.so.2 /usr/lib/aarch64-linux-gnu/libjemalloc.so.2 /usr/lib/libjemalloc.so.2; do
        [ -f "$p" ] && { export LD_PRELOAD="$p"; break; }
      done
      mkdir -p /bench/tmp && cd /app && '"$cmd"
}

for T in $TIERS; do
  read -r CPUS HEAP UV SHARP THUMB HDC <<<"$(tier_params "$T")"
  D="$OUT/$T"; mkdir -p "$D"; chmod 777 "$D" 2>/dev/null || true
  echo; echo "######## 档位 $T(cpus=$CPUS heap=${HEAP}MB uv=$UV sharp=$SHARP thumb=$THUMB hd=$HDC;RUN_AS=$RUN_AS;QUICK=$QUICK)########"
  for S in $SUITES; do
    echo "---- $S ----"
    case "$S" in
      memory)
        CMD="node scripts/bench/generate-images.mjs --out /bench/images $Q >/dev/null && node scripts/bench/bench-memory.mjs --dir /bench/images --settle 10 --sharp-concurrency $SHARP --save /bench/memory.json" ;;
      hd)
        CMD="node scripts/bench/bench-hd.mjs $Q --settle 10 --work /bench/run-hd --save /bench/hd.json" ;;
      queue)
        R=""; [ -n "$REAL_DIR" ] && R="--real /real"
        CMD="node scripts/bench/bench-queue.mjs $Q $R --work /bench/run-queue --save /bench/queue.json" ;;
      scan)
        CMD="node scripts/bench/bench-scan.mjs --files ${SCAN_FILES:-20000} --work /bench/scan --save /bench/scan.json" ;;
      *) echo "未知套件 $S(可选 memory hd queue scan)"; FAILED=$((FAILED+1)); continue ;;
    esac
    run_in_container "$T" "$CPUS" "$HEAP" "$UV" "$SHARP" "$THUMB" "$HDC" "$D" "$CMD" 2>&1 | tee "$D/$S.md"
    rc="${PIPESTATUS[0]}"
    [ "$rc" = 0 ] || { echo "  ✗ $T/$S 失败(退出码 $rc,见 $D/$S.md)"; FAILED=$((FAILED+1)); }
    # 容器内写出的文件属主是 RUN_AS,宿主机普通用户可能读不了:放开读权限
    $DOCKER run --rm --user 0:0 -v "$D:/b" --entrypoint sh "$IMAGE" -c 'chmod -R a+rX /b 2>/dev/null; rm -rf /b/images /b/run-* /b/scan /b/tmp 2>/dev/null; true' >/dev/null 2>&1
  done
done

echo; echo "结果目录: $OUT"; ls -1 "$OUT"/* 2>/dev/null | head -30
[ "$FAILED" = 0 ] && echo "基准完成" || echo "$FAILED 个套件失败"
exit 0
