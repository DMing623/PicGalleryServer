#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
#
# 在 InstaBox 测试机上:把运行中的容器更新为新镜像,并跑容器测试(test-docker.sh)。
#
# 用法:
#   export INSTABOX_API_URL=https://api.instabox.sh
#   export INSTABOX_API_KEY=ibk_...            # 只放环境变量,不要写入仓库
#   scripts/instabox-test.sh <机器名或ID> [镜像,默认 ghcr.io/dming623/picgalleryserver:latest] [-- 额外传给 test-docker.sh 的环境变量如 DRIVERS=sqlite]
#
# 做的事:
#   1. instabox exec 在机器里 docker pull 新镜像,并打印当前运行容器与镜像 digest(便于回滚)
#   2. 在机器里克隆/更新本仓库、npm ci,用新镜像跑 scripts/test-docker.sh(它自带独立容器与端口,不碰你原来的容器)
#   3. 可选 UPDATE_RUNNING=<容器名>:测试通过后,用同样的参数把该运行中的容器重建为新镜像(失败自动保留旧容器)
#
# 依赖:npx instabox(或已全局安装的 instabox CLI)。
set -euo pipefail
MACHINE="${1:?用法: $0 <机器名或ID> [镜像]}"
IMAGE="${2:-ghcr.io/dming623/picgalleryserver:latest}"
REPO="${REPO_URL:-https://github.com/DMing623/PicGalleryServer.git}"
BRANCH="${BRANCH:-main}"
: "${INSTABOX_API_KEY:?请先 export INSTABOX_API_KEY}"
IB="${INSTABOX:-npx --yes instabox@latest}"
RUN_AS="${RUN_AS:-1000}"            # InstaBox 默认以非 root 用户直接启动镜像(--user 1000:1000)
EXTRA_ENV="${EXTRA_ENV:-}"          # 例如 EXTRA_ENV="DRIVERS=sqlite MEM_LIMIT=1g"

rexec() { $IB exec "$MACHINE" -- bash -lc "$1"; }

echo "== 1. 机器环境与当前容器(自动兼容非 root 宿主机用户) =="
rexec 'DOCKER=docker; $DOCKER info >/dev/null 2>&1 || DOCKER="sudo -n docker"; echo "user=$(id -un)($(id -u)) docker_cmd=$DOCKER"; $DOCKER version --format "docker {{.Server.Version}}" && node -v || true; $DOCKER ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"'

echo "== 2. 拉取新镜像 $IMAGE =="
rexec "DOCKER=docker; \$DOCKER info >/dev/null 2>&1 || DOCKER='sudo -n docker'; \$DOCKER pull $IMAGE && \$DOCKER image inspect $IMAGE --format '{{.Id}} {{index .RepoDigests 0}}'"

echo "== 3. 同步测试脚本并执行静态检查 + 单测 + compose 校验 + test-docker.sh (RUN_AS=$RUN_AS) =="
rexec "set -e; DOCKER=docker; \$DOCKER info >/dev/null 2>&1 || DOCKER='sudo -n docker'; export DOCKER; D=\${HOME:-/tmp}/pgs-src; if [ -d \$D/.git ]; then cd \$D && git fetch -q origin $BRANCH && git checkout -q -B $BRANCH origin/$BRANCH; else git clone -q --depth 50 -b $BRANCH $REPO \$D && cd \$D; fi; (command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs; }); npm ci --no-audit --no-fund >/dev/null; node scripts/check-config.mjs; [ ! -f scripts/check-docs.mjs ] || node scripts/check-docs.mjs; node scripts/test-unit.mjs; scripts/test-compose.sh; RUN_AS=$RUN_AS $EXTRA_ENV scripts/test-docker.sh $IMAGE"

if [ -n "${UPDATE_RUNNING:-}" ]; then
  echo "== 4. 更新运行中的容器 $UPDATE_RUNNING → $IMAGE(保留旧容器为 ${UPDATE_RUNNING}-old)=="
  rexec "set -e; C=$UPDATE_RUNNING; docker inspect \$C >/dev/null; \
    CMD=\$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/nicholasgasior/runlike \$C 2>/dev/null || true); \
    echo \"旧容器 run 命令: \$CMD\"; \
    docker stop \$C && docker rename \$C \${C}-old; \
    if [ -n \"\$CMD\" ]; then eval \"\$(echo \"\$CMD\" | sed \"s#\$(docker inspect -f '{{.Config.Image}}' \${C}-old)#$IMAGE#\")\" ; else echo 'runlike 不可用:请手动用原参数 docker run 新镜像'; fi"
fi
echo "完成。回滚: docker stop <新容器> && docker rename <容器>-old <容器> && docker start <容器>"
