#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
#
# docker-compose.yml 的「变量传递」校验:不启动任何容器、不需要 root、不需要守护进程(只要 docker compose CLI)。
# 用 `docker compose config --format json` 解析 compose 对不同 .env 的展开结果,验证:
#   · 无前缀名直接生效(THUMB_CONCURRENCY=2 → 容器收到 2)
#   · 旧名 PGS_* 仍兼容;两者都写时无前缀优先
#   · 都不写 → 传空串,把默认值交还 config.ts(按 CPU 自适应;不再被 compose 写死成 4)
#   · 性能/内存/安全类变量(HD_CONCURRENCY / MEDIA_BUDGET_MB / COOKIE_SECURE / S3_* …)能进容器
#   · 必填项缺失时 compose 直接报错,不会用弱默认密码启动
#   · 静态校验 scripts/check-config.mjs(代码读取的每个变量都已映射或登记「不映射」)
#
# 用法:  scripts/test-compose.sh            默认使用仓库根的 docker-compose.yml
#        COMPOSE_FILE=/path/docker-compose.yml DOCKER="sudo docker" scripts/test-compose.sh
# 退出码:0 全部通过;N>0 = N 项失败;2 = 环境不满足(无 docker compose)。
set -uo pipefail
cd "$(dirname "$0")/.."

DOCKER="${DOCKER:-docker}"
COMPOSE_FILE="${COMPOSE_FILE:-$PWD/docker-compose.yml}"
FAILED=0

command -v "${DOCKER%% *}" >/dev/null 2>&1 || { echo "未找到 docker CLI(只需要 docker compose 子命令,不需要守护进程可连)"; exit 2; }
$DOCKER compose version >/dev/null 2>&1 || { echo "未找到 docker compose v2 插件"; exit 2; }
command -v node >/dev/null 2>&1 || { echo "需要 node 解析 compose 输出"; exit 2; }
[ -f "$COMPOSE_FILE" ] || { echo "找不到 $COMPOSE_FILE"; exit 2; }

# 临时目录:放 .env 副本,不改动仓库(只读检出也能跑)
W="$(mktemp -d "${TEST_TMP:-${TMPDIR:-/tmp}}/pgs-compose-XXXXXX")"
trap 'rm -rf "$W"' EXIT
cp "$COMPOSE_FILE" "$W/docker-compose.yml"

REQUIRED='PGS_DB_PASSWORD=dbpass
PGS_ADMIN_PASSWORD=adminpass
PGS_SESSION_SECRET=sessionsecret'

# env_of "<.env 内容>" 变量名 → 打印 app.environment 中该变量的值;变量不存在输出 __MISSING__;compose 失败输出 __ERROR__
env_of() {
  printf '%s\n%s\n' "$REQUIRED" "$1" > "$W/.env"
  $DOCKER compose --project-directory "$W" -f "$W/docker-compose.yml" --env-file "$W/.env" config --format json 2>"$W/err" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const e=JSON.parse(s).services.app.environment;const v=e[process.argv[1]];console.log(v===undefined||v===null?"__MISSING__":v)}catch{console.log("__ERROR__")}})' "$2"
}
expect() { # expect "描述" "实际" "期望"
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ FAIL $1 (实际「$2」,期望「$3」)"; FAILED=$((FAILED+1)); fi
}

# 「传空串」在不同 compose 版本的 config 输出里可能表现为 "" 或被省略,两者对容器的效果相同(变量未设置/为空 → config.ts 用默认值)
expect_empty() {
  case "$2" in ""|__MISSING__) echo "  ✓ $1" ;; *) echo "  ✗ FAIL $1 (实际「$2」,期望空)"; FAILED=$((FAILED+1)) ;; esac
}

echo "## 1. 无前缀名直接生效"
expect "THUMB_CONCURRENCY=2 → 容器 2" "$(env_of 'THUMB_CONCURRENCY=2' THUMB_CONCURRENCY)" 2
expect "HD_CONCURRENCY=1 → 容器 1" "$(env_of 'HD_CONCURRENCY=1' HD_CONCURRENCY)" 1
expect "HD_CACHE_MAX_MB=256 → 容器 256" "$(env_of 'HD_CACHE_MAX_MB=256' HD_CACHE_MAX_MB)" 256
expect "COOKIE_SECURE=true → 容器 true" "$(env_of 'COOKIE_SECURE=true' COOKIE_SECURE)" true
expect "MEDIA_BUDGET_MB=300 → 容器 300" "$(env_of 'MEDIA_BUDGET_MB=300' MEDIA_BUDGET_MB)" 300
expect "SHARP_CONCURRENCY=1 → 容器 1" "$(env_of 'SHARP_CONCURRENCY=1' SHARP_CONCURRENCY)" 1
expect "MEDIA_MAX_INPUT_MP=100 → 容器 100" "$(env_of 'MEDIA_MAX_INPUT_MP=100' MEDIA_MAX_INPUT_MP)" 100
expect "UV_THREADPOOL_SIZE=4 → 容器 4" "$(env_of 'UV_THREADPOOL_SIZE=4' UV_THREADPOOL_SIZE)" 4
expect "S3_BUCKET=b1 → 容器 b1" "$(env_of 'S3_BUCKET=b1' S3_BUCKET)" b1
expect "PUBLIC_BASE_URL 传入" "$(env_of 'PUBLIC_BASE_URL=https://pics.example.com' PUBLIC_BASE_URL)" https://pics.example.com
expect "ALLOWED_HOSTS 传入" "$(env_of 'ALLOWED_HOSTS=pics.example.com' ALLOWED_HOSTS)" pics.example.com

echo "## 2. 旧名 PGS_* 兼容,且无前缀优先"
expect "仅 PGS_THUMB_CONCURRENCY=3 → 3" "$(env_of 'PGS_THUMB_CONCURRENCY=3' THUMB_CONCURRENCY)" 3
expect "仅 PGS_VIDEO_CONCURRENCY=1 → 1" "$(env_of 'PGS_VIDEO_CONCURRENCY=1' VIDEO_CONCURRENCY)" 1
expect "仅 PGS_HEIC_CONCURRENCY=2 → 2" "$(env_of 'PGS_HEIC_CONCURRENCY=2' HEIC_CONCURRENCY)" 2
expect "仅 PGS_TRUST_PROXY=1 → 1" "$(env_of 'PGS_TRUST_PROXY=1' TRUST_PROXY)" 1
expect "两者都写时无前缀优先(2 vs 3 → 2)" "$(env_of $'THUMB_CONCURRENCY=2\nPGS_THUMB_CONCURRENCY=3' THUMB_CONCURRENCY)" 2

echo "## 3. 不设置 → 传空串,默认值交还 config.ts(不再被写死)"
expect_empty "THUMB_CONCURRENCY 未设 → 空串" "$(env_of '' THUMB_CONCURRENCY)"
expect_empty "HD_CONCURRENCY 未设 → 空串" "$(env_of '' HD_CONCURRENCY)"
expect_empty "MEDIA_BUDGET_MB 未设 → 空串(按容器内存自动推导)" "$(env_of '' MEDIA_BUDGET_MB)"
expect_empty "COOKIE_SECURE 未设 → 空串" "$(env_of '' COOKIE_SECURE)"
expect "DB_DRIVER 默认 postgres" "$(env_of '' DB_DRIVER)" postgres
expect "旧名 PGS_DB_DRIVER=sqlite 仍兼容" "$(env_of 'PGS_DB_DRIVER=sqlite' DB_DRIVER)" sqlite

echo "## 4. 镜像标签默认值 = package.json 版本"
VER="$(node -p "require('./package.json').version")"
printf '%s\n' "$REQUIRED" > "$W/.env"
IMG="$($DOCKER compose --project-directory "$W" -f "$W/docker-compose.yml" --env-file "$W/.env" config --format json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).services.app.image)}catch{console.log("")}})')"
expect "app 镜像默认 tag" "$IMG" "ghcr.io/dming623/picgalleryserver:$VER"

echo "## 5. 必填项缺失时 compose 直接报错(不会用弱默认值启动)"
for miss in PGS_DB_PASSWORD PGS_ADMIN_PASSWORD PGS_SESSION_SECRET; do
  grep -v "^$miss=" <<<"$REQUIRED" > "$W/.env"
  if $DOCKER compose --project-directory "$W" -f "$W/docker-compose.yml" --env-file "$W/.env" config >/dev/null 2>&1; then
    echo "  ✗ FAIL 缺少 $miss 时 compose 仍然成功"; FAILED=$((FAILED+1))
  else echo "  ✓ 缺少 $miss → compose 报错"; fi
done

echo "## 6. 静态一致性(代码读取的变量 ↔ compose 映射 ↔ .env.example ↔ 数据库自举)"
if node scripts/check-config.mjs; then echo "  ✓ check-config 通过"; else echo "  ✗ FAIL check-config"; FAILED=$((FAILED+1)); fi

echo; [ "$FAILED" = 0 ] && echo "全部通过" || echo "$FAILED 项失败"
exit "$FAILED"
