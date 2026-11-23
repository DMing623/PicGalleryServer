// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import os from "node:os";
import path from "node:path";
import { resolveSessionSecret } from "./secret";

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

function num(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function flag(name: string, def: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return def;
  return ["1", "true", "yes", "on"].includes(raw);
}

function enumOf<T extends string>(name: string, def: T, allowed: readonly T[]): T {
  const raw = process.env[name]?.trim().toLowerCase();
  return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : def;
}

/** 项目地址:来源水印使用它(域名会变,GitHub 地址不会变) */
export const PROJECT_URL = "github.com/DMing623/PicGalleryServer";

const adminPassword = process.env.ADMIN_PASSWORD?.trim() || "admin123456";
const dataDir = path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR?.trim() || "./data");
const isProduction = process.env.NODE_ENV === "production";
const isBuild = process.env.NEXT_PHASE === "phase-production-build";

const secret = resolveSessionSecret({
  explicit: process.env.SESSION_SECRET,
  dataDir,
  adminPassword,
  isProduction,
  isBuild,
});

/** 图片/视频/HEIC 分池并发:默认按 CPU 核数收敛,避免大批量导入时 OOM(issue §6.1) */
const cpu = Math.max(1, os.availableParallelism?.() ?? os.cpus().length ?? 1);

const s3Bucket = process.env.S3_BUCKET?.trim();

export const config = {
  appName: "PicGalleryServer",
  version: "1.3.1",
  adminUser: process.env.ADMIN_USER?.trim() || "admin",
  adminPassword,
  /** 会话/令牌签名密钥来源:env | file | generated | derived(见 secret.ts) */
  sessionSecret: secret.secret,
  sessionSecretSource: secret.source,
  sessionDays: int("SESSION_DAYS", 30, 1, 365),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  dataDir,
  /** 缩略图/预览图(图片)生成并发数 */
  thumbConcurrency: int("THUMB_CONCURRENCY", Math.min(4, cpu), 1, 128),
  /** 分池并发:视频(ffmpeg)与 HEIC 解码单独限流 */
  videoConcurrency: int("VIDEO_CONCURRENCY", 2, 1, 32),
  heicConcurrency: int("HEIC_CONCURRENCY", 1, 1, 16),
  thumbWidth: int("THUMB_WIDTH", 720, 120, 1600),
  previewWidth: int("PREVIEW_WIDTH", 1600, 640, 4096),
  /** EXIF 只读文件头的字节数(超出后按需放大,见 metadata.ts) */
  exifReadBytes: int("EXIF_READ_BYTES", 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
  /** 单文件上传上限(MB),0 = 不限 */
  maxUploadMb: int("MAX_UPLOAD_MB", 2048, 0, 1024 * 100),
  /** 上传前要求的最小剩余磁盘(MB),0 = 不检查 */
  minFreeDiskMb: int("MIN_FREE_DISK_MB", 1024, 0, 1024 * 1024),
  /** JSON 请求体上限(KB) */
  jsonBodyMaxKb: int("JSON_BODY_MAX_KB", 1024, 8, 64 * 1024),
  /** 允许挂载的根目录白名单,空 = 不限制(仅管理员可挂载) */
  mountRoots: list("ALLOWED_MOUNT_ROOTS").map((p) => path.resolve(/* turbopackIgnore: true */ p)),
  /** 自动重扫挂载相册的间隔(分钟),0 = 关闭 */
  scanIntervalMin: int("SCAN_INTERVAL_MIN", 0, 0, 60 * 24 * 7),
  /** 扫描熔断:一次扫描允许清理的最大消失比例(issue §2.1) */
  scanPruneMaxRatio: num("SCAN_PRUNE_MAX_RATIO", 0.3, 0, 1),
  /** 扫描熔断:已知记录数低于该值时不做比例熔断(小相册正常删文件) */
  scanPruneMinCount: int("SCAN_PRUNE_MIN_COUNT", 20, 1, 100_000),
  ffmpeg: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
  ffprobe: process.env.FFPROBE_PATH?.trim() || "ffprobe",
  /** 生成文件链接时使用的对外地址,空则使用请求来源 */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL?.trim() || "").replace(/\/+$/, ""),
  /** 允许用于生成链接/水印的 Host 白名单(空 = 取 PUBLIC_BASE_URL 的 host,再空 = 不校验) */
  allowedHosts: list("ALLOWED_HOSTS").map((h) => h.toLowerCase()),
  /** 信任几层反向代理(0 = 只信 X-Real-IP,由反代覆盖) */
  trustProxy: int("TRUST_PROXY", 0, 0, 10),
  /** 游客可见的元数据级别:full | basic | none */
  guestMeta: enumOf("GUEST_META", "basic", ["full", "basic", "none"] as const),
  /** 游客可见管理员备注(默认关闭,避免内部备注外泄) */
  guestNote: flag("GUEST_NOTE", false),
  /** 匿名搜索限流(每 IP 每分钟) */
  searchRatePerMin: int("SEARCH_RATE_PER_MIN", 60, 1, 100_000),
  /** 无效下载密钥限流(每 IP 每分钟),挡住未认证的 key 校验放大(issue §10.5) */
  keyRatePerMin: int("KEY_RATE_PER_MIN", 30, 1, 100_000),
  /** 数据库连接池 */
  db: {
    poolMax: int("DB_POOL_MAX", 10, 1, 200),
    statementTimeoutMs: int("DB_STATEMENT_TIMEOUT_MS", 20_000, 0, 600_000),
    connectionTimeoutMs: int("DB_CONNECT_TIMEOUT_MS", 5_000, 500, 60_000),
    ssl: flag("DATABASE_SSL", false),
  },
  /**
   * 高清预览(HD):按需生成、临时磁盘缓存、短期令牌、服务端水印、独立限流。
   * 全部可由 HD_* 环境变量配置,说明见 .env.example
   */
  hd: {
    /** 高清图最大宽度 */
    width: int("HD_WIDTH", 2560, 1024, 4096),
    /** 高清图最大高度(防止超长图消耗资源) */
    maxHeight: int("HD_MAX_HEIGHT", 4096, 1024, 8192),
    quality: int("HD_QUALITY", 82, 40, 95),
    /** 单张原图允许的最大输入像素(MP),超过将拒绝转换 */
    maxInputMp: int("HD_MAX_INPUT_MP", 200, 10, 1000),
    /** 同时进行的高清转换数 */
    concurrency: int("HD_CONCURRENCY", 3, 1, 32),
    cacheDir: path.resolve(/* turbopackIgnore: true */ process.env.HD_CACHE_DIR?.trim() || path.join(dataDir, "cache", "hd")),
    cacheMaxBytes: Math.round(num("HD_CACHE_MAX_MB", 2048, 16, 1024 * 1024) * 1024 * 1024),
    cacheTtlMs: Math.round(num("HD_CACHE_TTL_DAYS", 7, 0.01, 365) * 86_400_000),
    /** 高清访问令牌有效期(秒) */
    tokenTtlSec: int("HD_TOKEN_TTL_SEC", 90, 15, 3600),
    rate: {
      ipPerMin: int("HD_RATE_IP_PER_MIN", 30, 1, 100_000),
      userPerMin: int("HD_RATE_USER_PER_MIN", 40, 1, 100_000),
      /** 同一张图片每分钟总请求数 */
      mediaPerMin: int("HD_RATE_MEDIA_PER_MIN", 120, 1, 100_000),
      /** 申请令牌(授权)每 IP 每分钟 */
      tokenIpPerMin: int("HD_RATE_TOKEN_PER_MIN", 60, 1, 100_000),
      /** 异常批量访问:窗口内访问的不同图片数上限 */
      scanDistinct: int("HD_SCAN_DISTINCT", 150, 5, 100_000),
      scanWindowSec: int("HD_SCAN_WINDOW_SEC", 300, 30, 86_400),
      /** 触发异常检测后的封禁时长(秒) */
      blockSec: int("HD_SCAN_BLOCK_SEC", 300, 10, 86_400),
    },
    wm: {
      enabled: flag("HD_WM_ENABLED", true),
      /** 水印文字模板。宏: {host} 站点域名(随请求域名/PUBLIC_BASE_URL 变化)、{project} 项目地址 */
      text: process.env.HD_WM_TEXT?.trim() || "Source: {host} · {project}",
      opacity: num("HD_WM_OPACITY", 8, 1, 100),
      fontSize: int("HD_WM_FONT_SIZE", 16, 8, 96),
      angle: num("HD_WM_ANGLE", -30, -90, 90),
      /** 重复密度 1(稀疏)~5(密集) */
      density: int("HD_WM_DENSITY", 3, 1, 5),
      /** 为登录用户叠加动态标识(不可逆短码,不含 IP/用户名) */
      userMark: flag("HD_WM_USER", true),
      /** 水印字体文件(默认使用随依赖安装的 DejaVu Sans;需要中文水印请指定 CJK 字体) */
      fontFile: process.env.HD_WM_FONT_FILE?.trim() || "",
    },
  },
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
  /** 高清预览临时缓存(独立于永久派生图,不通过任何静态 URL 暴露) */
  hdCache: config.hd.cacheDir,
  logs: path.join(config.dataDir, "logs"),
};
