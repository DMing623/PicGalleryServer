// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import Busboy from "busboy";
import { config, dirs } from "../config";
import { ApiError, E } from "../http";

/** 流式解析 multipart:文件边接收边写入临时文件并计算 SHA-256,不占用内存。 */

export interface UploadedTmp {
  name: string;
  mime: string;
  tmp: string;
  size: number;
  hash: string;
  truncated: boolean;
}

export async function parseUpload(req: Request, maxBytesOverride?: number): Promise<{ files: UploadedTmp[]; fields: Record<string, string> }> {
  const ct = req.headers.get("content-type") ?? "";
  if (!req.body || !ct.toLowerCase().startsWith("multipart/form-data")) {
    throw E.badRequest("需要 multipart/form-data 请求体");
  }
  await fs.mkdir(dirs.tmp, { recursive: true });
  const maxBytes = maxBytesOverride ?? (config.maxUploadMb > 0 ? config.maxUploadMb * 1024 * 1024 : undefined);

  // 上传前检查剩余磁盘空间,避免 uploader 一次写满磁盘(issue §1.8)
  if (config.minFreeDiskMb > 0) {
    const st = await fs.statfs(dirs.tmp).catch(() => null);
    if (st) {
      const freeMb = (Number(st.bavail) * Number(st.bsize)) / 1048576;
      if (freeMb < config.minFreeDiskMb) {
        throw new ApiError(507, "insufficient_storage", `服务器剩余空间不足(${Math.round(freeMb)}MB),已拒绝上传`);
      }
    }
  }

  return new Promise((resolve, reject) => {
    const files: UploadedTmp[] = [];
    const fields: Record<string, string> = {};
    const pending: Promise<void>[] = [];
    let failed = false;
    const bb = Busboy({ headers: { "content-type": ct }, defParamCharset: "utf8", limits: { fileSize: maxBytes, files: 5000, fields: 50 } });

    const cleanupAll = () => files.forEach((f) => void fs.unlink(f.tmp).catch(() => undefined));
    const abort = (err: unknown) => {
      if (failed) return;
      failed = true;
      cleanupAll();
      reject(err);
    };

    bb.on("field", (name, value) => {
      fields[name] = value;
    });
    bb.on("file", (_field, stream, info) => {
      if (!info.filename) {
        stream.resume();
        return;
      }
      const filename = info.filename;
      const tmp = path.join(dirs.tmp, `up-${randomBytes(8).toString("hex")}`);
      const ws = createWriteStream(tmp);
      const hash = createHash("sha256");
      let size = 0;
      let truncated = false;
      stream.on("data", (c: Buffer) => {
        hash.update(c);
        size += c.length;
      });
      stream.on("limit", () => {
        truncated = true;
      });
      pending.push(
        new Promise<void>((res, rej) => {
          ws.on("close", () => {
            files.push({ name: filename, mime: info.mimeType, tmp, size, hash: hash.digest("hex"), truncated });
            res();
          });
          ws.on("error", rej);
        }),
      );
      stream.pipe(ws);
    });
    bb.on("error", abort);
    bb.on("close", () => {
      Promise.all(pending).then(() => {
        if (failed) return;
        resolve({ files, fields });
      }, abort);
    });
    Readable.fromWeb(req.body as never).on("error", abort).pipe(bb);
  });
}
