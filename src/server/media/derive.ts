// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@/db";
import { media } from "@/db/schema";
import { config, dirs } from "../config";
import { materialize } from "../storage";
import { buildSearchText, extractImageMeta, grabVideoFrame, probeVideo, type MediaMeta } from "./metadata";
import { invalidateHd } from "../hd/cache";
import { getSite } from "../settings";
import { decodeBmp, isBmp } from "./bmp";
import { isHeic } from "./types";
import { limiter } from "../queue";

/**
 * 派生图生成与元数据入库。由 queue 调度,并发受 THUMB_CONCURRENCY 限制。
 * 产物: DATA_DIR/derived/<id前2位>/<id>.thumb.webp 与 <id>.preview.webp
 */

sharp.cache(false);
sharp.concurrency(2); // 每个 sharp 任务内部线程数;总并行度由队列控制

export type Variant = "thumb" | "preview";

export function derivedPath(id: string, variant: Variant): string {
  return path.join(dirs.derived, id.slice(0, 2), `${id}.${variant}.webp`);
}

export async function removeDerived(id: string) {
  await invalidateHd(id);
  await Promise.all((["thumb", "preview"] as Variant[]).map((v) => fs.unlink(derivedPath(id, v)).catch(() => undefined)));
}

/** 上传到远程存储时保留的本地副本路径,避免再下载一次;处理后删除 */
const localHints = new Map<string, string>();
export function hintLocalCopy(id: string, file: string) {
  localHints.set(id, file);
}
/** 丢弃本地副本提示(记录已被删除时调用,避免 Map 与临时文件泄漏,见 issue §2.7) */
export async function dropLocalHint(id: string) {
  const p = localHints.get(id);
  localHints.delete(id);
  if (p) await fs.unlink(p).catch(() => undefined);
}

async function writeAtomic(dst: string, buf: Buffer) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, dst);
}

/** 解压炸弹防护 + 顺序读(降低内存峰值);不要从原图 clone 两次,见 issue §10.3 */
const INPUT_OPTS = { failOn: "none" as const, limitInputPixels: 268_000_000, sequentialRead: true };

async function makeDerived(id: string, input: string | Buffer) {
  const previewBuf = await sharp(input, INPUT_OPTS)
    .rotate()
    .resize({ width: config.previewWidth, height: config.previewWidth, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 84 }) // 不调用 keepMetadata/withMetadata:输出不含 EXIF/XMP/ICC 等元数据
    .toBuffer();
  const thumbBuf = await sharp(previewBuf, INPUT_OPTS)
    .resize({ width: config.thumbWidth, height: config.thumbWidth * 2, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 84 })
    .toBuffer();
  const px = await sharp(thumbBuf).resize(1, 1, { fit: "cover" }).removeAlpha().raw().toBuffer();
  const color = `#${[px[0], px[1], px[2]].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  await Promise.all([writeAtomic(derivedPath(id, "preview"), previewBuf), writeAtomic(derivedPath(id, "thumb"), thumbBuf)]);
  return color;
}

/** HEIC 解码是最吃内存/CPU 的路径,单独限流(issue §6.1) */
const heicGate = limiter(config.heicConcurrency, "heic");
/** 视频探测/抽帧(ffmpeg 子进程)单独限流 */
const videoGate = limiter(config.videoConcurrency, "video");

/** BMP:libvips 预编译版没有加载器,先用内置解码器转成 PNG 再交给 sharp */
async function bmpToPng(file: string): Promise<Buffer> {
  const d = decodeBmp(await fs.readFile(file));
  return sharp(d.data, { raw: { width: d.width, height: d.height, channels: 4 } }).png().toBuffer();
}

export async function heicToJpeg(file: string): Promise<Buffer> {
  return heicGate(async () => {
    const convert = (await import("heic-convert")).default;
    const input = await fs.readFile(file);
    const out = await convert({ buffer: input as unknown as ArrayBufferLike, format: "JPEG", quality: 0.92 } as never);
    return Buffer.from(out as unknown as ArrayBuffer);
  });
}

const PLACEHOLDER = (label: string) =>  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#2b2a28"/><circle cx="320" cy="180" r="58" fill="none" stroke="#d97757" stroke-width="6"/><path d="M302 148 L352 180 L302 212 Z" fill="#d97757"/><text x="320" y="300" fill="#a8a69b" font-size="22" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`,
  );

/**
 * 判断抽出的帧是否接近纯色(片头黑场/白场)。
 * 用 1x1 缩放取不到方差,改用极小尺寸的统计量:标准差极低即视为纯色。
 */
async function isBlankFrame(file: string): Promise<boolean> {
  try {
    const st = await sharp(file).resize(64, 64, { fit: "inside" }).stats();
    const maxStd = Math.max(...st.channels.slice(0, 3).map((c) => c.stdev));
    const maxMean = Math.max(...st.channels.slice(0, 3).map((c) => c.mean));
    const minMean = Math.min(...st.channels.slice(0, 3).map((c) => c.mean));
    return maxStd < 3 || (maxMean < 8 && minMean < 8);
  } catch {
    return false;
  }
}

export async function processMedia(id: string): Promise<void> {
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
  if (!row) {
    // 记录已被删除:清掉本地副本与 Map 条目,避免泄漏(issue §2.7)
    await dropLocalHint(id);
    return;
  }
  await invalidateHd(id); // 重新处理 = 原文件可能已变化,旧高清缓存作废
  const hint = localHints.get(id);
  let mat: { path: string; cleanup: () => Promise<void> } | null = null;
  // 挂载目录(ext)里的文件可能被外部程序(同步工具、用户)原地覆盖/截断。libvips 对 webp/heif 等格式
  // 会 mmap 源文件,文件在读取途中被截断会让整个 Node 进程收到 SIGBUS 直接崩溃,
  // 所以 ext 图片先复制一份私有副本再交给 sharp(支持 reflink 的文件系统上几乎零成本)。
  let privateCopy: string | null = null;
  try {
    mat = hint
      ? { path: hint, cleanup: () => fs.unlink(hint).then(() => void localHints.delete(id), () => void localHints.delete(id)) }
      : await materialize(row.storage, row.storageKey);
    const file = mat.path;
    const patch: Partial<typeof media.$inferInsert> = {};
    let meta: MediaMeta;
    let takenAt: Date | null = null;

    if (row.kind === "image") {
      let src = file;
      if (row.storage === "ext" && !isHeic(row.filename) && !isBmp(row.filename)) {
        await fs.mkdir(dirs.tmp, { recursive: true });
        privateCopy = path.join(dirs.tmp, `src-${randomBytes(6).toString("hex")}`);
        await fs.copyFile(file, privateCopy, fsConstants.COPYFILE_FICLONE);
        src = privateCopy;
      }
      const input: string | Buffer = isHeic(row.filename) ? await heicToJpeg(file) : isBmp(row.filename) ? await bmpToPng(file) : src;
      const m = await sharp(input, INPUT_OPTS).metadata();
      const swap = (m.orientation ?? 1) >= 5 && (m.orientation ?? 1) <= 8;
      const width = (swap ? m.height : m.width) ?? 0;
      const height = (swap ? m.width : m.height) ?? 0;
      patch.width = width;
      patch.height = height;
      patch.color = await makeDerived(id, input);
      const r = await extractImageMeta(file, {
        format: isHeic(row.filename) ? "heic" : isBmp(row.filename) ? "bmp" : m.format,
        width, height, space: m.space, depth: m.depth, hasAlpha: m.hasAlpha, density: m.density,
        orientation: m.orientation, channels: m.channels, isPng: m.format === "png" && !isBmp(row.filename),
      }, (await getSite()).timezone);
      meta = r.meta;
      takenAt = r.takenAt;
    } else {
      const p = await videoGate(() => probeVideo(file, row.mime, row.size));
      // ffprobe 失败(伪造/损坏的视频)时不应标记 ready:没有时长、没有分辨率,
      // 封面也只是占位图,对用户是"看起来正常但打不开"的坏数据
      if (p.width === null && p.height === null && p.duration === null) {
        throw new Error("无法解析视频(ffprobe 失败,文件可能已损坏或不是有效视频)");
      }
      meta = p.meta;
      takenAt = p.takenAt;
      patch.width = p.width;
      patch.height = p.height;
      patch.duration = p.duration;
      const tmpPng = path.join(dirs.tmp, `frame-${randomBytes(6).toString("hex")}.png`);
      try {
        await fs.mkdir(dirs.tmp, { recursive: true });
        // 取第 1 秒的帧可能正好是黑场(片头黑帧),检测到纯黑就换时间点重试
        const candidates = [p.duration ? Math.min(1, p.duration / 2) : 0, 0];
        if (p.duration && p.duration > 4) candidates.push(p.duration * 0.25, p.duration * 0.75);
        let got = false;
        for (const at of candidates) {
          await videoGate(() => grabVideoFrame(file, tmpPng, at));
          if (!(await isBlankFrame(tmpPng))) {
            got = true;
            break;
          }
        }
        patch.color = await makeDerived(id, got ? tmpPng : PLACEHOLDER("VIDEO"));
      } catch {
        patch.color = await makeDerived(id, PLACEHOLDER("VIDEO"));
      } finally {
        await fs.unlink(tmpPng).catch(() => undefined);
      }
    }

    if (takenAt && takenAt.getFullYear() >= 1990 && takenAt.getTime() < Date.now() + 86_400_000) {
      patch.takenAt = takenAt;
      patch.sortAt = takenAt;
    }
    await db
      .update(media)
      .set({ ...patch, meta, status: "ready", error: null, searchText: buildSearchText(row.filename, meta) })
      .where(eq(media.id, id));
  } catch (e) {
    await db
      .update(media)
      .set({ status: "failed", error: String((e as Error)?.message ?? e).slice(0, 500) })
      .where(eq(media.id, id));
    throw e;
  } finally {
    if (privateCopy) await fs.unlink(privateCopy).catch(() => undefined);
    if (mat) await mat.cleanup();
  }
}
