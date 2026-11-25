// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@/db";
import { media } from "@/db/schema";
import { can, signToken, verifyToken, type AuthUser } from "../auth";
import { config } from "../config";
import { E } from "../http";
import { heicToJpeg } from "../media/derive";
import { baseUrl, canSee } from "../media/service";
import { isHeic } from "../media/types";
import { limiter } from "../queue";
import { driverFor, materialize } from "../storage";
import { ID_RE, genOf, getCached, hdStats, invalidateHd, putCached } from "./cache";
import { guardHd, hdStrike } from "./guard";
import { applyWatermark } from "./watermark";

/**
 * 高清预览服务:令牌签发 → 权限校验 → 缓存/按需转换 → 水印 → 输出。
 * 与原图下载(/f/:id、?key=)完全分离:不接受下载密钥,不返回原文件,不暴露存储路径。
 */

type Row = typeof media.$inferSelect;

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
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
  if (!row) return null;
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
  try {
    const input: string | Buffer = isHeic(row.filename) ? await heicToJpeg(mat.path) : mat.path;
    return await sharp(input, { failOn: "none", limitInputPixels: config.hd.maxInputMp * 1_000_000 })
      .rotate()
      .resize({ width, height: config.hd.maxHeight, fit: "inside", withoutEnlargement: true })
      .webp({ quality: config.hd.quality }) // 不保留任何元数据(EXIF/XMP/ICC/GPS 全部剥离)
      .toBuffer();
  } finally {
    await mat.cleanup();
  }
}

async function versionOf(row: Row): Promise<string | null> {
  const driver = await driverFor(row.storage);
  const info = await driver.stat(row.storageKey);
  if (!info) return null;
  return createHash("sha1").update(`${row.hash ?? ""}|${row.size}|${info.size}|${Math.round(info.mtimeMs)}`).digest("hex").slice(0, 12);
}

async function getBase(row: Row, ver: string, width: number): Promise<{ buf: Buffer; state: "hit" | "miss" | "coalesced" }> {
  const hit = await getCached(row.id, ver, width);
  if (hit) {
    hdStats.hits++;
    return { buf: hit, state: "hit" };
  }
  const key = `${row.id}.${ver}.${width}`;
  const running = inflight.get(key);
  if (running) {
    hdStats.coalesced++;
    return { buf: await running, state: "coalesced" };
  }
  hdStats.misses++;
  const gen = genOf(row.id);
  const p = gate(() => convert(row, width)).then(async (buf) => {
    await putCached(row.id, ver, width, buf, gen).catch((e) => console.error("[hd] cache write failed", e));
    return buf;
  });
  inflight.set(key, p);
  try {
    return { buf: await p, state: "miss" };
  } finally {
    inflight.delete(key);
  }
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
  const ver = await versionOf(row);
  if (!ver) {
    await invalidateHd(row.id); // 原文件已不存在:旧缓存立即失效
    throw E.notFound("原文件不存在或已被移除");
  }

  const { buf, state } = await getBase(row, ver, width);

  let out = buf;
  let wmOn = false;
  if (config.hd.wm.enabled) {
    const host = (() => {
      try {
        return new URL(baseUrl(req)).host;
      } catch {
        return "unknown";
      }
    })();
    out = await gate(() => applyWatermark(buf, { host, userId: uid }));
    wmOn = true;
  }

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
      "x-pgs-wm": wmOn ? "1" : "0",
      "x-pgs-hd-width": String(width),
    },
  });
}
