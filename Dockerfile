FROM node:22-bookworm-slim AS build
WORKDIR /app

# ---- 构建期占位环境变量 ----
# Next.js 在构建阶段会加载路由模块并收集页面数据,而 src/db/index.ts 在模块加载时
# 强制校验 DATABASE_URL,缺失会直接抛错导致构建失败:
#   Error: Failed to collect page data for /api/v1/[[...path]]
#   [cause]: Error: DATABASE_URL is required
# 下列占位值【仅在构建阶段生效】,运行期的真实配置由 docker-compose 注入;
# 最终镜像的运行阶段是全新 FROM,不会携带这些变量,也不含任何真实凭据。
# 注:ADMIN_PASSWORD / SESSION_SECRET / ADMIN_USER 在 src/server/config.ts 中
# 均有默认值,构建期无需提供,此处刻意不声明,以免被镜像扫描工具误判为硬编码密钥。
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
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
# ffmpeg/ffprobe 用于视频封面与元数据(可选,不装则使用占位图)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app ./
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["npm", "start"]
