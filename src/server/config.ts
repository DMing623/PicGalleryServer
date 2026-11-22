// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import path from "node:path";

/** 环境变量统一解析入口。其它模块只允许从这里读取配置。 */

function int(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const adminPassword = process.env.ADMIN_PASSWORD?.trim() || "admin123456";

const s3Bucket = process.env.S3_BUCKET?.trim();

export const config = {
  appName: "PicGalleryServer",
  version: "1.0.0",
  adminUser: process.env.ADMIN_USER?.trim() || "admin",
  adminPassword,
  /** 会话/令牌签名密钥,未配置时由管理员密码派生(更换密码会使旧会话失效) */
  sessionSecret: process.env.SESSION_SECRET?.trim() || `pgs-derived:${adminPassword}`,
  sessionDays: int("SESSION_DAYS", 30, 1, 365),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  dataDir: path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR?.trim() || "./data"),
  /** 缩略图/预览图生成并发数 */
  thumbConcurrency: int("THUMB_CONCURRENCY", 15, 1, 128),
  thumbWidth: int("THUMB_WIDTH", 480, 120, 1200),
  previewWidth: int("PREVIEW_WIDTH", 1600, 640, 4096),
  /** 单文件上传上限(MB),0 = 不限 */
  maxUploadMb: int("MAX_UPLOAD_MB", 0, 0, 1024 * 100),
  /** 允许挂载的根目录白名单,空 = 不限制(仅管理员可挂载) */
  mountRoots: list("ALLOWED_MOUNT_ROOTS").map((p) => path.resolve(/* turbopackIgnore: true */ p)),
  /** 自动重扫挂载相册的间隔(分钟),0 = 关闭 */
  scanIntervalMin: int("SCAN_INTERVAL_MIN", 0, 0, 60 * 24 * 7),
  ffmpeg: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
  ffprobe: process.env.FFPROBE_PATH?.trim() || "ffprobe",
  /** 生成文件链接时使用的对外地址,空则使用请求来源 */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL?.trim() || "").replace(/\/+$/, ""),
  s3: s3Bucket
    ? {
        bucket: s3Bucket,
        region: process.env.S3_REGION?.trim() || "us-east-1",
        endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
        accessKeyId: process.env.S3_ACCESS_KEY?.trim() || "",
        secretAccessKey: process.env.S3_SECRET_KEY?.trim() || "",
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
        prefix: (process.env.S3_PREFIX?.trim() || "").replace(/^\/+|\/+$/g, ""),
      }
    : null,
} as const;

export const dirs = {
  albums: path.join(config.dataDir, "albums"),
  derived: path.join(config.dataDir, "derived"),
  tmp: path.join(config.dataDir, "tmp"),
  branding: path.join(config.dataDir, "branding"),
};
