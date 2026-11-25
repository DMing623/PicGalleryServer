// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@/db";
import { media } from "@/db/schema";
import { config } from "../config";
import type { ProbeResult } from "../queue";
import { driverFor } from "../storage";
import { localHintFor } from "./derive";
import { isBmp } from "./bmp";
import { estimateMemory, limitMessage, pixelLimitMessage, type ProbeMeta } from "./estimate";
import { isHeic } from "./types";

/**
 * 解码前的轻量探测:只读文件头(KB 级),绝不解码整图,也绝不为探测去下载远程(S3)文件。
 *  - 本地 / 挂载(ext)图片:读前 256KB 交给 sharp().metadata()(从 Buffer 读,不 mmap 源文件)
 *  - BMP:读前 26 字节的头直接取宽高
 *  - HEIC:扫描 `ispe` box 取最大的宽高
 *  - 视频:不读像素,固定经验估算
 *  - 没有本地副本的 S3 文件:用数据库里已有的 width/height(重新处理时),否则按 size + mime 低置信度估算
 * 探测结果决定:类别(分池)、估算内存(预算准入)、是否超过硬限制(直接以 [LIMIT] 拒绝)。
 */

const HEAD_BYTES = 256 * 1024;

async function readHead(file: string, n: number): Promise<Buffer | null> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** BMP 头:偏移 18 宽(int32)、22 高(int32,负数表示自上而下) */
export function bmpDims(head: Buffer): { width: number; height: number } | null {
  if (head.length < 26 || head[0] !== 0x42 || head[1] !== 0x4d) return null;
  const width = head.readInt32LE(18);
  const height = Math.abs(head.readInt32LE(22));
  return width > 0 && height > 0 ? { width, height } : null;
}

/** HEIC:meta/iprp/ipco 里的 ispe box(size,'ispe',ver/flags,宽 u32,高 u32);取面积最大者(排除缩略图/瓦片) */
export function heicDims(head: Buffer): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null;
  let from = 0;
  for (;;) {
    const i = head.indexOf("ispe", from, "latin1");
    if (i < 0 || i + 16 > head.length) break;
    const width = head.readUInt32BE(i + 8);
    const height = head.readUInt32BE(i + 12);
    if (width > 0 && height > 0 && width < 200_000 && height < 200_000 && (!best || width * height > best.width * best.height)) best = { width, height };
    from = i + 4;
  }
  return best;
}

async function headerMeta(file: string, ext: boolean, filename: string): Promise<ProbeMeta | null> {
  const head = await readHead(file, HEAD_BYTES);
  if (!head || !head.length) return null;
  try {
    const m = await sharp(head, { failOn: "none", limitInputPixels: false }).metadata();
    if (m.width && m.height) {
      const swap = (m.orientation ?? 1) >= 5 && (m.orientation ?? 1) <= 8;
      return { format: m.format, width: swap ? m.height : m.width, height: swap ? m.width : m.height, progressive: !!m.isProgressive, depth: m.depth, space: m.space, channels: m.channels };
    }
  } catch {
    /* 头部不足以解析(例如 TIFF 的 IFD 在文件末尾)→ 下面按路径回退 */
  }
  // 路径回退:挂载目录(ext)只对 TIFF 这种不 mmap 的格式允许,避免外部截断引发 SIGBUS
  if (ext && !/\.tiff?$/i.test(filename)) return null;
  try {
    const m = await sharp(file, { failOn: "none", limitInputPixels: false }).metadata();
    if (m.width && m.height) {
      const swap = (m.orientation ?? 1) >= 5 && (m.orientation ?? 1) <= 8;
      return { format: m.format, width: swap ? m.height : m.width, height: swap ? m.width : m.height, progressive: !!m.isProgressive, depth: m.depth, space: m.space, channels: m.channels };
    }
  } catch {
    /* 损坏文件:交给 processMedia 报错 */
  }
  return null;
}

export interface ProbeRow {
  id: string;
  filename: string;
  mime: string;
  size: number;
  storage: string;
  storageKey: string;
  width: number | null;
  height: number | null;
}

/** 取得一行媒体的头部元信息(不解码、不下载远程文件);HD 与后台派生共用 */
export async function metaForRow(row: ProbeRow): Promise<{ meta: ProbeMeta; heic: boolean; bmp: boolean }> {
  const heic = isHeic(row.filename);
  const bmp = isBmp(row.filename);
  let local = localHintFor(row.id);
  if (!local) {
    try {
      local = (await driverFor(row.storage)).localPath(row.storageKey);
    } catch {
      local = null;
    }
  }

  let meta: ProbeMeta | null = null;
  if (local) {
    if (bmp || heic) {
      const head = await readHead(local, bmp ? 64 : 1024 * 1024);
      const d = head ? (bmp ? bmpDims(head) : heicDims(head)) : null;
      if (d) meta = { ...d, format: bmp ? "bmp" : "heif" };
    } else meta = await headerMeta(local, row.storage === "ext", row.filename);
  }
  if (!meta && row.width && row.height) meta = { width: row.width, height: row.height, format: bmp ? "bmp" : heic ? "heif" : undefined };
  if (!meta) meta = { sizeBytes: row.size, mime: row.mime };
  if (meta.sizeBytes === undefined) meta.sizeBytes = row.size;
  meta.mime = row.mime;
  return { meta, heic, bmp };
}

export async function probeMedia(id: string): Promise<ProbeResult | null> {
  const [row] = await db
    .select({ id: media.id, kind: media.kind, filename: media.filename, mime: media.mime, size: media.size, storage: media.storage, storageKey: media.storageKey, width: media.width, height: media.height })
    .from(media)
    .where(eq(media.id, id))
    .limit(1);
  if (!row) return null;

  if (row.kind === "video") {
    const e = estimateMemory({}, "video");
    return { cls: "video", estMB: e.estMB, confidence: e.confidence };
  }

  const { meta, heic, bmp } = await metaForRow(row);
  const est = estimateMemory(meta, heic ? "heic" : bmp ? "bmp" : "derive", { filename: row.filename });
  const cls = heic ? "heic" : "image";

  // 硬限制 1:输入像素上限(只在确实知道宽高时判断,不拿「按大小反推」的估计去误杀)
  if (meta.width && meta.height && (meta.width * meta.height) / 1e6 > config.media.maxInputMp) {
    return { cls, estMB: est.estMB, confidence: est.confidence, reject: pixelLimitMessage(meta.width, meta.height, config.media.maxInputMp) };
  }
  // 硬限制 2:单任务估算内存(「按文件大小反推」的低置信度估算同样适用:估算已 ×1.5,超限即拒绝)
  const hard = config.media.hardMaxMB;
  if (hard > 0 && est.estMB > hard) {
    return { cls, estMB: est.estMB, confidence: est.confidence, reject: limitMessage(est, hard) };
  }
  return { cls, estMB: est.estMB, confidence: est.confidence };
}
