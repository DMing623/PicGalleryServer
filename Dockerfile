FROM node:22-bookworm-slim AS build
WORKDIR /app

# ---- 构建期占位环境变量 ----
# Next.js 在构建阶段会加载路由模块并收集页面数据。src/db/index.ts 已改为惰性创建连接池,
# 不再强制要求 DATABASE_URL;这里仍给出占位值,仅为兼容任何构建期探测。
# 下列占位值【仅在构建阶段生效】,运行期的真实配置由 docker-compose 注入;
# 最终镜像的运行阶段是全新 FROM,不会携带这些变量,也不含任何真实凭据。
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build

COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build
# 裁剪仅开发期依赖(eslint/typescript/drizzle-kit 等),减小最终镜像体积;
# next / pg / drizzle-orm / sharp 均在 dependencies 中,不受影响
RUN npm prune --omit=dev

FROM node:22-bookworm-slim
# tini 负责 PID 1 的信号转发与僵尸进程回收;jemalloc 缓解 glibc 内存碎片(issue §5.1/§6.1)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini libjemalloc2 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    UV_THREADPOOL_SIZE=12 \
    MALLOC_ARENA_MAX=2 \
    NEXT_TELEMETRY_DISABLED=1

# libjemalloc 路径随架构不同(amd64 / arm64),用入口脚本探测后设置 LD_PRELOAD
RUN printf '%s\n' \
  '#!/bin/sh' \
  'for p in /usr/lib/x86_64-linux-gnu/libjemalloc.so.2 /usr/lib/aarch64-linux-gnu/libjemalloc.so.2 /usr/lib/libjemalloc.so.2; do' \
  '  if [ -f "$p" ]; then export LD_PRELOAD="$p"; break; fi' \
  'done' \
  'exec "$@"' > /usr/local/bin/pgs-entrypoint \
 && chmod +x /usr/local/bin/pgs-entrypoint

WORKDIR /app
COPY --from=build /app ./
# 以非 root 运行(issue §5.1):数据目录交给 node 用户
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

VOLUME ["/app/data"]
EXPOSE 3000

# 健康检查走 liveness 接口(不依赖数据库,避免数据库短暂抖动导致容器被判死)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pgs-entrypoint"]
# 直接用 node 启动 next,避免 npm → sh -c → node 的信号转发链(issue §5.1/§10.2)
CMD ["node", "node_modules/next/dist/bin/next", "start"]
