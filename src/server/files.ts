// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { can, verifyStreamToken, type AuthUser } from "./auth";
import { config } from "./config";
import { ApiError, E } from "./http";
import { verifyKey } from "./keys";
import { derivedPath, type Variant } from "./media/derive";
import { canSee } from "./media/service";
import { count, overLimit } from "./rate";
import { clientIp } from "./router";
import { driverFor } from "./storage";
import { db } from "@/db";
import { media } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * 文件输出与原文件保护:
 *  thumb / preview : 派生图(webp),按相册可见性放行
 *  file (/f/:id)   : 带有效 ?key= 或登录用户具备 original 权限 → 原文件;否则 → 预览图(视频为封面图)
 *  stream          : 视频在线播放。需要原文件授权,或 [可见 + 短时播放令牌 + 浏览器 <video> 请求特征]
 */

const PLACEHOLDER = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#d9d4c5"/><text x="240" y="165" fill="#83827d" font-size="20" text-anchor="middle" font-family="sans-serif">processing…</text></svg>`,
);

function toWeb(stream: Readable): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream;
}

const cd = (name: string, attach: boolean) =>
  `${attach ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name).replace(/['()]/g, escape)}`;

function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (size === 0 || start > end || start >= size) return "invalid";
  return { start, end };
}

async function serveDerived(req: Request, id: string, variant: Variant, filename: string, publicCache: boolean, inlineName?: string) {
  const p = derivedPath(id, variant);
  const st = await fs.stat(p).catch(() => null);
  if (!st) {
    return new Response(new Uint8Array(PLACEHOLDER), {
      headers: { "content-type": "image/svg+xml", "cache-control": "no-store", "x-pgs-state": "processing" },
    });
  }
  const etag = `"${id}-${variant}-${st.mtimeMs.toString(36)}-${st.size}"`;
  const headers: Record<string, string> = {
    etag,
    "content-type": "image/webp",
    // 5 分钟:内容变化后很快失效,同时保留 ETag/304 回源校验(issue §11.6)
    "cache-control": publicCache ? "public, max-age=300" : "private, max-age=300",
    "x-content-type-options": "nosniff",
    // 自托管相册不应被搜索引擎索引(issue §11.5)
    "x-robots-tag": "noindex, noimageindex",
    "referrer-policy": "no-referrer",
  };
  if (inlineName) headers["content-disposition"] = cd(inlineName, false);
  void filename;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  headers["content-length"] = String(st.size);
  return new Response(toWeb(createReadStream(p)), { headers });
}

interface FileRow {
  storage: string;
  storageKey: string;
  mime: string;
  filename: string;
}

async function serveOriginal(req: Request, row: FileRow, attach: boolean) {
  const driver = await driverFor(row.storage);
  const info = await driver.stat(row.storageKey);
  if (!info) throw E.notFound("原文件不存在或已被移除");
  const range = parseRange(req.headers.get("range"), info.size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${info.size}` } });
  }
  const headers: Record<string, string> = {
    "content-type": row.mime,
    "accept-ranges": "bytes",
    "content-disposition": cd(row.filename, attach),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, noimageindex",
    "referrer-policy": "no-referrer",
  };
  const out = await driver.open(row.storageKey, range ?? undefined);
  if (range) {
    headers["content-range"] = `bytes ${range.start}-${range.end}/${info.size}`;
    headers["content-length"] = String(range.end - range.start + 1);
    return new Response(toWeb(out.stream), { status: 206, headers });
  }
  headers["content-length"] = String(info.size);
  return new Response(toWeb(out.stream), { headers });
}

function looksLikeMediaElement(req: Request): boolean {
  const dest = req.headers.get("sec-fetch-dest");
  if (dest) return dest === "video" || dest === "audio";
  const ref = req.headers.get("referer");
  const host = req.headers.get("host");
  try {
    return !!ref && !!host && new URL(ref).host === host;
  } catch {
    return false;
  }
}

/** 文件输出只需要这几列:避免每次缩略图请求都 select 整行(含大 jsonb meta),见 issue §6.2 */
const FILE_COLS = {
  id: media.id,
  albumId: media.albumId,
  kind: media.kind,
  mime: media.mime,
  filename: media.filename,
  storage: media.storage,
  storageKey: media.storageKey,
  missingAt: media.missingAt,
};

export async function serveMedia(
  req: Request,
  id: string,
  variant: "thumb" | "preview" | "file" | "stream",
  user: AuthUser | null,
): Promise<Response> {
  const url = new URL(req.url);
  const [row] = await db.select(FILE_COLS).from(media).where(eq(media.id, id)).limit(1);
  if (!row || row.missingAt) throw E.notFound("文件不存在");

  const key = url.searchParams.get("key");
  const rangeStart = /^bytes=(\d+)-/.exec(req.headers.get("range") ?? "");
  let keyOk = false;
  if (key) {
    // 无效密钥限流:只对「校验失败」计数,正常带 key 下载不受影响(issue §10.5)
    const ip = clientIp(req);
    if (overLimit(`key:${ip}`, config.keyRatePerMin)) {
      throw E.tooMany("密钥校验失败次数过多,请稍后再试", 60);
    }
    keyOk = await verifyKey(key, !rangeStart || rangeStart[1] === "0");
    if (!keyOk) {
      count(`key:${ip}`);
      throw new ApiError(403, "invalid_key", "下载密钥无效或已过期");
    }
  }
  const privileged = can(user, "original");
  const visible = keyOk || (await canSee(row.albumId, user));
  if (!visible) throw E.notFound("文件不存在");
  const publicCache = !user && !keyOk;

  if (variant === "thumb" || variant === "preview") {
    return serveDerived(req, id, variant, row.filename, publicCache);
  }
  if (variant === "file") {
    if (keyOk || privileged) return serveOriginal(req, row, url.searchParams.get("dl") === "1");
    const stem = row.filename.replace(/\.[^.]+$/, "");
    return serveDerived(req, id, "preview", row.filename, publicCache, `${stem}.webp`);
  }
  // stream
  if (row.kind !== "video") throw E.badRequest("仅视频支持在线播放接口");
  if (keyOk || privileged) return serveOriginal(req, row, false);
  if (verifyStreamToken(url.searchParams.get("t"), id) && looksLikeMediaElement(req)) return serveOriginal(req, row, false);
  throw new ApiError(403, "stream_forbidden", "视频仅支持在页面内播放;下载原视频需要下载密钥");
}
