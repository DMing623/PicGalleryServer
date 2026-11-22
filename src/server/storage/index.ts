// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { config, dirs } from "../config";
import { E } from "../http";

/**
 * 存储抽象。存储代码(storage code)是仅用于标识字节存放位置的字符串:
 *   local = DATA_DIR 内(key 为相对路径)
 *   s3    = 对象存储(key 为对象键)
 *   ext   = 挂载的服务器绝对路径(key 为绝对路径文件)
 */
export type StorageCode = "local" | "s3" | "ext";
export const STORAGE_CODES: StorageCode[] = ["local", "s3", "ext"];

export function isStorageCode(v: unknown): v is StorageCode {
  return typeof v === "string" && (STORAGE_CODES as string[]).includes(v);
}

export interface OpenResult {
  stream: Readable;
  size: number;
  start: number;
  end: number;
}

export interface StorageDriver {
  put(key: string, srcPath: string, mime: string): Promise<void>;
  open(key: string, range?: { start: number; end: number }): Promise<OpenResult>;
  stat(key: string): Promise<{ size: number; mtimeMs: number } | null>;
  remove(key: string): Promise<void>;
  localPath(key: string): string | null;
}

export async function moveFile(src: string, dst: string): Promise<void> {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fs.rename(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await pipeline(createReadStream(src), createWriteStream(dst));
    await fs.unlink(src);
  }
}

function fsDriver(resolve: (key: string) => string): StorageDriver {
  return {
    async put(key, srcPath) {
      await moveFile(srcPath, resolve(key));
    },
    async open(key, range) {
      const p = resolve(key);
      const st = await fs.stat(p).catch(() => null);
      if (!st || !st.isFile()) throw E.notFound("原文件不存在或已被移除");
      const start = range?.start ?? 0;
      const end = Math.min(range?.end ?? st.size - 1, st.size - 1);
      const stream = st.size === 0 ? createReadStream(p, { start: 0, end: -1 }) : createReadStream(p, { start, end });
      return { stream, size: st.size, start, end };
    },
    async stat(key) {
      const st = await fs.stat(resolve(key)).catch(() => null);
      return st && st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
    },
    async remove(key) {
      await fs.unlink(resolve(key)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
    },
    localPath: (key) => resolve(key),
  };
}

/** local: 防止 key 穿越出 DATA_DIR */
const localDriver = fsDriver((key) => {
  const abs = path.resolve(config.dataDir, key);
  if (abs !== config.dataDir && !abs.startsWith(config.dataDir + path.sep)) throw E.badRequest("非法存储路径");
  return abs;
});

const extDriver = fsDriver((key) => {
  if (!path.isAbsolute(key)) throw E.badRequest("ext 存储要求绝对路径");
  return path.resolve(key);
});

let s3Driver: StorageDriver | null = null;

async function getS3(): Promise<StorageDriver> {
  if (s3Driver) return s3Driver;
  if (!config.s3) throw E.badRequest("未配置对象存储(S3_BUCKET 等环境变量)", "s3_not_configured");
  const cfg = config.s3;
  const sdk = await import("@aws-sdk/client-s3");
  const client = new sdk.S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: cfg.accessKeyId ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } : undefined,
  });
  const full = (key: string) => (cfg.prefix ? `${cfg.prefix}/${key}` : key);
  s3Driver = {
    async put(key, srcPath, mime) {
      const st = await fs.stat(srcPath);
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: cfg.bucket,
          Key: full(key),
          Body: createReadStream(srcPath),
          ContentLength: st.size,
          ContentType: mime,
        }),
      );
      // 注意: s3 驱动不删除源文件,由调用方决定(便于复用本地副本生成缩略图)
    },
    async open(key, range) {
      const head = await this.stat(key);
      if (!head) throw E.notFound("原文件不存在于对象存储");
      const start = range?.start ?? 0;
      const end = Math.min(range?.end ?? head.size - 1, head.size - 1);
      const out = await client.send(
        new sdk.GetObjectCommand({
          Bucket: cfg.bucket,
          Key: full(key),
          Range: range ? `bytes=${start}-${end}` : undefined,
        }),
      );
      return { stream: out.Body as Readable, size: head.size, start, end };
    },
    async stat(key) {
      try {
        const h = await client.send(new sdk.HeadObjectCommand({ Bucket: cfg.bucket, Key: full(key) }));
        return { size: Number(h.ContentLength ?? 0), mtimeMs: h.LastModified?.getTime() ?? 0 };
      } catch {
        return null;
      }
    },
    async remove(key) {
      await client.send(new sdk.DeleteObjectCommand({ Bucket: cfg.bucket, Key: full(key) }));
    },
    localPath: () => null,
  };
  return s3Driver;
}

export async function driverFor(code: string): Promise<StorageDriver> {
  if (code === "local") return localDriver;
  if (code === "ext") return extDriver;
  if (code === "s3") return getS3();
  throw E.badRequest(`未知存储代码: ${code}`);
}

export function s3Available(): boolean {
  return !!config.s3;
}

/** 取得可供 sharp/ffmpeg 读取的本地文件路径;远程存储会下载到临时目录 */
export async function materialize(
  code: string,
  key: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const d = await driverFor(code);
  const local = d.localPath(key);
  if (local) return { path: local, cleanup: async () => undefined };
  await fs.mkdir(dirs.tmp, { recursive: true });
  const tmp = path.join(dirs.tmp, `dl-${randomBytes(6).toString("hex")}${path.extname(key)}`);
  const { stream } = await d.open(key);
  await pipeline(stream, createWriteStream(tmp));
  return { path: tmp, cleanup: () => fs.unlink(tmp).catch(() => undefined) };
}
