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
import { isHeic } from "./types";

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
  await Promise.all((["thumb", "preview"] as Variant[]).map((v) => fs.unlink(derivedPath(id, v)).catch(() => undefined)));
}

/** 上传到远程存储时保留的本地副本路径,避免再下载一次;处理后删除 */
const localHints = new Map<string, string>();
export function hintLocalCopy(id: string, file: string) {
  localHints.set(id, file);
}

async function writeAtomic(dst: string, buf: Buffer) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, dst);
}

async function makeDerived(id: string, input: string | Buffer) {
  const previewBuf = await sharp(input, { failOn: "none" })
    .rotate()
    .resize({ width: config.previewWidth, height: config.previewWidth, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const thumbBuf = await sharp(previewBuf)
    .resize({ width: config.thumbWidth, height: config.thumbWidth * 2, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
  const px = await sharp(thumbBuf).resize(1, 1, { fit: "cover" }).removeAlpha().raw().toBuffer();
  const color = `#${[px[0], px[1], px[2]].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  await Promise.all([writeAtomic(derivedPath(id, "preview"), previewBuf), writeAtomic(derivedPath(id, "thumb"), thumbBuf)]);
  return color;
}

async function heicToJpeg(file: string): Promise<Buffer> {
  const convert = (await import("heic-convert")).default;
  const input = await fs.readFile(file);
  const out = await convert({ buffer: input as unknown as ArrayBufferLike, format: "JPEG", quality: 0.92 } as never);
  return Buffer.from(out as unknown as ArrayBuffer);
}

const PLACEHOLDER = (label: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#2b2a28"/><circle cx="320" cy="180" r="58" fill="none" stroke="#d97757" stroke-width="6"/><path d="M302 148 L352 180 L302 212 Z" fill="#d97757"/><text x="320" y="300" fill="#a8a69b" font-size="22" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`,
  );

export async function processMedia(id: string): Promise<void> {
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
  if (!row) return;
  const hint = localHints.get(id);
  let mat: { path: string; cleanup: () => Promise<void> } | null = null;
  try {
    mat = hint
      ? { path: hint, cleanup: () => fs.unlink(hint).then(() => void localHints.delete(id), () => void localHints.delete(id)) }
      : await materialize(row.storage, row.storageKey);
    const file = mat.path;
    const patch: Partial<typeof media.$inferInsert> = {};
    let meta: MediaMeta;
    let takenAt: Date | null = null;

    if (row.kind === "image") {
      const input: string | Buffer = isHeic(row.filename) ? await heicToJpeg(file) : file;
      const m = await sharp(input, { failOn: "none" }).metadata();
      const swap = (m.orientation ?? 1) >= 5 && (m.orientation ?? 1) <= 8;
      const width = (swap ? m.height : m.width) ?? 0;
      const height = (swap ? m.width : m.height) ?? 0;
      patch.width = width;
      patch.height = height;
      patch.color = await makeDerived(id, input);
      const r = await extractImageMeta(file, {
        format: isHeic(row.filename) ? "heic" : m.format,
        width, height, space: m.space, depth: m.depth, hasAlpha: m.hasAlpha, density: m.density,
        orientation: m.orientation, channels: m.channels, isPng: m.format === "png",
      });
      meta = r.meta;
      takenAt = r.takenAt;
    } else {
      const p = await probeVideo(file, row.mime, row.size);
      meta = p.meta;
      takenAt = p.takenAt;
      patch.width = p.width;
      patch.height = p.height;
      patch.duration = p.duration;
      const tmpPng = path.join(dirs.tmp, `frame-${randomBytes(6).toString("hex")}.png`);
      try {
        await fs.mkdir(dirs.tmp, { recursive: true });
        await grabVideoFrame(file, tmpPng, p.duration ? Math.min(1, p.duration / 2) : 0);
        patch.color = await makeDerived(id, tmpPng);
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
      .set({ ...patch, meta, status: "ready", error: null, searchText: buildSearchText(row.filename, row.note, meta) })
      .where(eq(media.id, id));
  } catch (e) {
    await db
      .update(media)
      .set({ status: "failed", error: String((e as Error)?.message ?? e).slice(0, 500) })
      .where(eq(media.id, id));
    throw e;
  } finally {
    if (mat) await mat.cleanup();
  }
}
