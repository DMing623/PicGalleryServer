// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@/db";
import { media } from "@/db/schema";
import { can, signToken, verifyToken, type AuthUser } from "../auth";
import { config, dirs } from "../config";
import { ApiError, E } from "../http";
import { AdmissionAbortError, AdmissionTimeoutError } from "../admission";
import { bmpInput, heicToJpeg } from "../media/derive";
import { isBmp } from "../media/bmp";
import { estimateMemory, limitMessage } from "../media/estimate";
import { metaForRow } from "../media/probe";
import { baseUrl, canSee, hostTrusted } from "../media/service";
import { isHeic } from "../media/types";
import { getScheduler, limiter } from "../queue";
import { driverFor, materialize } from "../storage";
import { ID_RE, genOf, getCached, getCachedWm, hdStats, invalidateHd, putCached, putCachedWm } from "./cache";
import { guardHd, hdStrike } from "./guard";
import { applyWatermark, wmDependsOnHost, wmFingerprint } from "./watermark";

/**
 * 高清预览服务:令牌签发 → 权限校验 → 缓存/按需转换 → 水印 → 输出。
 * 与原图下载(/f/:id、?key=)完全分离:不接受下载密钥,不返回原文件,不暴露存储路径。
 */

/** HD 只需要这些列(不拉 meta jsonb / search_text 等大字段) */
const HD_COLS = {
  id: media.id, albumId: media.albumId, kind: media.kind, filename: media.filename, mime: media.mime, size: media.size,
  hash: media.hash, storage: media.storage, storageKey: media.storageKey, width: media.width, height: media.height, missingAt: media.missingAt,
};
type Row = Pick<typeof media.$inferSelect, "id" | "albumId" | "kind" | "filename" | "mime" | "size" | "hash" | "storage" | "storageKey" | "width" | "height" | "missingAt">;

/** 允许的输出宽度档位(客户端按屏幕分辨率选择,服务端吸附到档位以提高缓存命中) */
export function hdWidths(): number[] {
  const max = config.hd.width;
  return [...new Set([1280, 1600, 1920, 2560, 3840].filter((w) => w < max).concat(max))].sort((a, b) => a - b);
}

export function snapWidth(raw: string | null | undefined): number {
  const list = hdWidths();
  const want = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(want) || want <= 0) return list[list.length - 1];
  return list.find((w) => w >= want) ?? list[list.length - 1];
}

/* ---------- 令牌 ---------- */

interface HdTokenPayload {
  m: string;
  s: "hd";
  u: string | null;
  w: number;
  exp: number;
}

export function issueHdToken(mediaId: string, user: AuthUser | null, width: number) {
  const exp = Math.floor(Date.now() / 1000) + config.hd.tokenTtlSec;
  const payload: HdTokenPayload = { m: mediaId, s: "hd", u: user?.id ?? null, w: width, exp };
  return { token: signToken(payload as unknown as Record<string, unknown>), expiresIn: config.hd.tokenTtlSec, width };
}

type TokenCheck = { ok: true; payload: HdTokenPayload } | { ok: false; reason: string };

export function checkHdToken(token: string | null, mediaId: string, user: AuthUser | null): TokenCheck {
  if (!token) return { ok: false, reason: "missing_token" };
  const p = verifyToken<HdTokenPayload>(token); // 验签 + 过期
  if (!p) return { ok: false, reason: "bad_or_expired_token" };
  if (p.s !== "hd") return { ok: false, reason: "wrong_scope" };
  if (p.m !== mediaId) return { ok: false, reason: "cross_media_token" };
  if (p.u && p.u !== user?.id) return { ok: false, reason: "token_user_mismatch" };
  return { ok: true, payload: p };
}

/* ---------- 权限 ---------- */

async function loadVisibleImage(id: string, user: AuthUser | null): Promise<Row | null> {
  if (!ID_RE.test(id)) return null;
  const [row] = await db.select(HD_COLS).from(media).where(eq(media.id, id)).limit(1);
  if (!row) return null;
  // 挂载目录里已消失(宽限期内)的文件不再提供高清预览
  if (row.missingAt) return null;
  // 游客:仅公开相册;登录用户:需具备浏览权限
  if (!(await canSee(row.albumId, user))) return null;
  if (user && !can(user, "browse.private") && !(await canSee(row.albumId, null))) return null;
  return row;
}

/* ---------- 转换 ---------- */

const gate = limiter(config.hd.concurrency, "hd");
const inflight = new Map<string, Promise<Buffer>>();

async function convert(row: Row, width: number): Promise<Buffer> {
  hdStats.conversions++;
  const mat = await materialize(row.storage, row.storageKey); // 远程存储会下载到临时文件,finally 中必定清理
  // 挂载目录(ext)里的文件可能被外部程序原地截断;libvips 对 webp/heif 等格式会 mmap 源文件,
  // 读取途中被截断会让整个进程收到 SIGBUS。与派生图一致:先复制私有副本(支持 reflink 的文件系统上几乎零成本)
  let privateCopy: string | null = null;
  let bmpCleanup: (() => Promise<void>) | null = null;
  try {
    const heic = isHeic(row.filename);
    const bmp = isBmp(row.filename);
    let src = mat.path;
    if (row.storage === "ext" && !heic && !bmp) {
      await fs.mkdir(dirs.tmp, { recursive: true });
      privateCopy = path.join(dirs.tmp, `hd-${randomBytes(6).toString("hex")}`);
      await fs.copyFile(mat.path, privateCopy, fsConstants.COPYFILE_FICLONE);
      src = privateCopy;
    }
    let input: string | Buffer = src;
    if (heic) input = await heicToJpeg(mat.path, true);
    else if (bmp) {
      const b = await bmpInput(mat.path);
      input = b.input;
      bmpCleanup = b.cleanup;
    }
    return await sharp(input, { failOn: "none", limitInputPixels: config.hd.maxInputMp * 1_000_000 })
      .rotate()
      .resize({ width, height: config.hd.maxHeight, fit: "inside", withoutEnlargement: true })
      .webp({ quality: config.hd.quality }) // 不保留任何元数据(EXIF/XMP/ICC/GPS 全部剥离)
      .toBuffer();
  } finally {
    if (bmpCleanup) await bmpCleanup();
    if (privateCopy) await fs.unlink(privateCopy).catch(() => undefined);
    await mat.cleanup();
  }
}

/** HD 水印阶段的内存估算:按「输出尺寸」而不是原图尺寸 */
function wmEstimate(row: Row, width: number) {
  const ow = row.width && row.height ? Math.min(width, row.width) : width;
  const oh = row.width && row.height ? Math.min(config.hd.maxHeight, Math.round((ow * row.height) / row.width)) : Math.round(width * 0.75);
  return estimateMemory({ width: ow, height: oh }, "hd-wm");
}

/** 把准入控制的失败翻译成对客户端友好的响应 */
function admissionError(e: unknown): never {
  if (e instanceof AdmissionTimeoutError) throw new ApiError(503, "hd_busy", "服务器正忙(内存预算紧张),请稍后重试", { "retry-after": "5" });
  if (e instanceof AdmissionAbortError) throw new ApiError(499, "client_closed", "请求已取消");
  throw e;
}

async function versionOf(row: Row): Promise<string | null> {
  const driver = await driverFor(row.storage);
  const info = await driver.stat(row.storageKey);
  if (!info) return null;
  return createHash("sha1").update(`${row.hash ?? ""}|${row.size}|${info.size}|${Math.round(info.mtimeMs)}`).digest("hex").slice(0, 12);
}

/* ---------- 对外入口 ---------- */

export async function requestHdToken(req: Request, id: string, user: AuthUser | null, ip: string, widthRaw: string | null) {
  await guardHd({ ip, userId: user?.id ?? null, mediaId: id }, "token");
  const row = await loadVisibleImage(id, user);
  if (!row) {
    await hdStrike(ip, user?.id ?? null, id, "token_for_invisible_media");
    throw E.notFound("文件不存在");
  }
  if (row.kind !== "image") throw E.badRequest("仅图片支持高清预览");
  const width = snapWidth(widthRaw);
  void req;
  return { ...issueHdToken(row.id, user, width), id: row.id };
}

export async function serveHd(req: Request, id: string, user: AuthUser | null, ip: string): Promise<Response> {
  const url = new URL(req.url);
  const uid = user?.id ?? null;

  // 1) 令牌:绑定媒体 id / 访问范围 / 过期时间 / 用户
  const tk = checkHdToken(url.searchParams.get("t"), id, user);
  if (!tk.ok) {
    await hdStrike(ip, uid, id, tk.reason);
    throw new (await import("../http")).ApiError(403, "hd_token_invalid", "高清访问令牌无效或已过期,请重新打开图片");
  }
  // 2) 独立限流 + 异常检测(IP / 用户 / 媒体)
  await guardHd({ ip, userId: uid, mediaId: id }, "serve");
  // 3) 每次请求重新校验媒体与相册访问权限(缓存命中同样适用)
  const row = await loadVisibleImage(id, user);
  if (!row) {
    await hdStrike(ip, uid, id, "invisible_media");
    throw E.notFound("文件不存在");
  }
  if (row.kind !== "image") throw E.badRequest("仅图片支持高清预览");

  const width = snapWidth(url.searchParams.get("w") ?? String(tk.payload.w));
  // 失效代数必须在任何耗时操作之前取得:此后若该图被替换/删除/重处理,本次结果不得写入缓存
  const gen0 = genOf(row.id);
  const ver = await versionOf(row);
  if (!ver) {
    await invalidateHd(row.id); // 原文件已不存在:旧缓存立即失效
    throw E.notFound("原文件不存在或已被移除");
  }

  const sched = getScheduler();
  const wmOn = config.hd.wm.enabled;
  const host = (() => {
    try {
      return new URL(baseUrl(req)).host;
    } catch {
      return "unknown";
    }
  })();
  const signal = req.signal;
  const waitOpts = { signal, timeoutMs: 15_000 };
  const wmEst = wmOn ? wmEstimate(row, width).estMB : 1;
  const watermark = (buf: Buffer) => (wmOn ? gate(() => applyWatermark(buf, { host, userId: uid })) : Promise.resolve(buf));

  // 游客水印成品缓存(P1-4):游客水印不含用户标识,结果由「图 + 版本 + 宽度 + 水印指纹」唯一确定。
  // 登录用户带动态标识(U-XXXXXX),永不读写;水印文字含 {host} 而域名不可信(未配置 PUBLIC_BASE_URL / ALLOWED_HOSTS)时也不缓存。
  // 到这里令牌、限流、可见性、missingAt 都已校验完毕 —— 缓存的是处理结果,不是访问权限。
  type WmCache = "off" | "skip-user" | "untrusted-host" | "hit" | "miss";
  let wmCache: WmCache = !wmOn ? "off" : uid ? "skip-user" : wmDependsOnHost() && !hostTrusted(req) ? "untrusted-host" : "miss";
  const wmFp = wmCache === "miss" ? wmFingerprint(host) : null;

  // 预算按三路分流(绝不在查缓存/inflight 之前无条件申请「未命中」的全量预算):
  //  hit        缓存命中 → 只需申请水印阶段的轻量预算
  //  coalesced  同一张图已有请求在转换 → 先等它产出基图(期间不重复占预算),再申请水印阶段预算
  //  miss       覆盖「转换 + 水印 + 响应」整条流水线的一次预算;转换完成后收缩为水印阶段预算
  let state: "hit" | "miss" | "coalesced" = "miss";
  let out: Buffer | null = null;
  try {
    if (wmFp) {
      const done = await getCachedWm(row.id, ver, width, wmFp);
      if (done) {
        out = done;
        state = "hit";
        wmCache = "hit";
        hdStats.hits++;
      }
    }
    if (!out) {
      const key = `${row.id}.${ver}.${width}`;
      const cached = await getCached(row.id, ver, width);
      let base: Buffer | null = cached;
      state = "hit";
      if (cached) hdStats.hits++;
      else {
        const running = inflight.get(key);
        if (running) {
          hdStats.coalesced++;
          state = "coalesced";
          base = await running;
        }
      }
      if (base) {
        const b = base;
        out = await sched.withHd(wmEst, () => watermark(b), waitOpts);
      } else {
        state = "miss";
        hdStats.misses++;
        // 必须在任何 await 之前同步登记 inflight,否则并发请求会各自转换(合并失效)
        let settle!: { resolve: (b: Buffer) => void; reject: (e: unknown) => void };
        const shared = new Promise<Buffer>((resolve, reject) => (settle = { resolve, reject }));
        shared.catch(() => undefined); // 没有合并请求时不产生未处理的 rejection
        inflight.set(key, shared);
        try {
          // 估算:优先用数据库里已有的宽高;S3 原图绝不为估算而提前下载
          const { meta, heic, bmp } = await metaForRow(row);
          const est = estimateMemory(meta, heic ? "heic" : bmp ? "bmp" : "hd-miss", { filename: row.filename });
          const hard = config.media.hardMaxMB;
          if (hard > 0 && est.estMB > hard) throw new ApiError(413, "hd_too_large", limitMessage(est, hard));
          out = await sched.withHd(
            Math.max(est.estMB, wmEst),
            async (res) => {
              const buf = await gate(() => convert(row, width));
              await putCached(row.id, ver, width, buf, gen0).catch((e) => console.error("[hd] cache write failed", e));
              settle.resolve(buf);
              res.adjust(wmEst); // 解码工作集已释放,只需保留水印阶段所需
              return watermark(buf);
            },
            waitOpts,
          );
        } catch (e) {
          settle.reject(e);
          throw e;
        } finally {
          inflight.delete(key);
        }
      }
      // 游客成品写入缓存(异步、失败不影响响应;转换期间若图被失效,gen0 不匹配会被丢弃)
      if (wmFp) void putCachedWm(row.id, ver, width, wmFp, out, gen0).catch((e) => console.error("[hd] wm cache write failed", e));
    }
  } catch (e) {
    admissionError(e);
  }
  if (!out) throw new ApiError(500, "hd_failed", "高清图生成失败");

  return new Response(out as unknown as BodyInit, {
    headers: {
      "content-type": "image/webp",
      "content-length": String(out.length),
      "content-disposition": `inline; filename="${row.id}-hd.webp"`,
      // 禁止浏览器/CDN/Nginx 等任何缓存层保存,保证每次都回源做权限校验
      "cache-control": "private, no-store, max-age=0",
      pragma: "no-cache",
      vary: "Cookie, Authorization",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, noimageindex",
      "cross-origin-resource-policy": "same-origin",
      "x-pgs-cache": state,
      "x-pgs-wm-cache": wmCache,
      "x-pgs-wm": wmOn ? "1" : "0",
      "x-pgs-hd-width": String(width),
    },
  });
}
