// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { lookup } from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirs, config } from "../config";
import { E } from "../http";
import { detectKind } from "./types";
import type { UploadedTmp } from "./upload";

/**
 * 直链上传:把远端 URL 的图片/视频下载到临时文件,再走正常的入库流程。
 *
 * 安全要点(SSRF):
 *  - 只允许 http/https;
 *  - 每一跳(含重定向)都解析域名并拒绝环回 / 私有 / 链路本地 / 组播地址;
 *  - 限制重定向次数、总时长与体积(MAX_UPLOAD_MB);
 *  - 只接受图片/视频(按扩展名或 Content-Type 判断)。
 */

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 120_000;

/** 补全协议头并转义空格等字符(用户常直接粘贴 images-assets.nasa.gov/... 这种裸域名) */
export function normalizeUrl(raw: string): string {
  let s = String(raw ?? "").trim();
  if (!s) throw E.badRequest("链接为空");
  // 去掉可能粘贴进来的引号/尖括号
  s = s.replace(/^[<"']+|[>"']+$/g, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  // 空格与中文字符需要编码,否则 URL 解析会失败
  s = s.replace(/ /g, "%20");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw E.badRequest(`链接格式无效:${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw E.badRequest("只支持 http/https 直链");
  return u.toString();
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true; // 组播 / 保留
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;
  if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return false;
}

async function assertPublicHost(u: URL): Promise<void> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw E.badRequest("不允许访问内网地址");
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw E.badRequest(`无法解析域名:${host}`);
  }
  if (!addrs.length) throw E.badRequest(`无法解析域名:${host}`);
  // 只有「全部解析结果都是内网地址」时才拒绝:
  // 某些代理/双栈环境会同时返回 ULA(fc00::/7)与公网 IPv4,一刀切会把正常域名误杀。
  if (addrs.every((a) => isPrivateAddress(a.address))) throw E.badRequest("不允许访问内网地址");
}

/** 从 URL / Content-Disposition 推断文件名 */
function guessName(u: URL, disposition: string | null): string {
  const cd = disposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition) : null;
  if (cd?.[1]) {
    try {
      return decodeURIComponent(cd[1]).replace(/[/\\]/g, "_");
    } catch {
      return cd[1].replace(/[/\\]/g, "_");
    }
  }
  const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    /* 保留原样 */
  }
  name = name.replace(/[/\\]/g, "_").trim();
  if (!name) name = `remote-${randomBytes(4).toString("hex")}`;
  if (!path.extname(name)) {
    // 没有扩展名时按 Content-Type 补一个
    name += ".bin";
  }
  return name;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
};

/** 下载远端文件到临时目录,返回与 multipart 上传一致的结构 */
export async function downloadToTmp(rawUrl: string): Promise<UploadedTmp> {
  let url = normalizeUrl(rawUrl);
  let res: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(url);
    await assertPublicHost(u);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": "PicGalleryServer/1.4 (+direct-link-import)", accept: "image/*,video/*,*/*;q=0.8" },
      });
    } catch (e) {
      throw E.badRequest(`下载失败:${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw E.badRequest("重定向缺少 Location");
      url = new URL(loc, url).toString();
      continue;
    }
    break;
  }
  if (!res) throw E.badRequest("下载失败");
  if (!res.ok) throw E.badRequest(`远端返回 HTTP ${res.status}`);
  if (!res.body) throw E.badRequest("远端响应为空");

  const ctype = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  let name = guessName(new URL(url), res.headers.get("content-disposition"));
  if (path.extname(name) === ".bin" && EXT_BY_MIME[ctype]) name = name.replace(/\.bin$/, EXT_BY_MIME[ctype]);
  const kind = detectKind(name);
  if (!kind) throw E.badRequest(`不是受支持的图片/视频:${name}`);
  if (ctype && !ctype.startsWith("image/") && !ctype.startsWith("video/") && ctype !== "application/octet-stream" && ctype !== "binary/octet-stream") {
    throw E.badRequest(`远端内容类型不是图片/视频(${ctype})`);
  }

  const limitBytes = config.maxUploadMb > 0 ? config.maxUploadMb * 1024 * 1024 : Infinity;
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limitBytes) throw E.payloadTooLarge("远端文件超过 MAX_UPLOAD_MB 限制");

  await fs.mkdir(dirs.tmp, { recursive: true });
  const tmp = path.join(dirs.tmp, `url-${randomBytes(8).toString("hex")}`);
  const hash = createHash("sha256");
  let size = 0;
  let truncated = false;

  const body = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
  const counter = new (await import("node:stream")).Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > limitBytes) {
        truncated = true;
        cb(new Error("超过体积上限"));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(body, counter, createWriteStream(tmp));
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    if (truncated) throw E.payloadTooLarge("远端文件超过 MAX_UPLOAD_MB 限制");
    throw E.badRequest(`下载中断:${(e as Error).message}`);
  }
  if (size === 0) {
    await fs.unlink(tmp).catch(() => undefined);
    throw E.badRequest("远端文件为空");
  }

  return { name, mime: kind.mime, tmp, size, hash: hash.digest("hex"), truncated: false };
}
