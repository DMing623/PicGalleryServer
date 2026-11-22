// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import fs from "node:fs/promises";
import { gunzipSync, inflateSync } from "node:zlib";
import sharp from "sharp";

/** PNG 文本块(tEXt/zTXt/iTXt)读取,以及 NovelAI 隐写(alpha 通道 LSB)元数据提取。 */

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_CHUNK = 16 * 1024 * 1024;
const MAX_VALUE = 200_000;

export async function readPngInfo(file: string): Promise<{ text: Record<string, string>; colorType: number | null }> {
  const text: Record<string, string> = {};
  let colorType: number | null = null;
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(8);
    await fh.read(head, 0, 8, 0);
    if (!head.equals(SIG)) return { text, colorType };
    let pos = 8;
    const hdr = Buffer.alloc(8);
    while (pos + 12 <= size) {
      await fh.read(hdr, 0, 8, pos);
      const len = hdr.readUInt32BE(0);
      const type = hdr.toString("latin1", 4, 8);
      if (type === "IEND") break;
      if (type === "IHDR") {
        const b = Buffer.alloc(13);
        await fh.read(b, 0, 13, pos + 8);
        colorType = b[9];
      } else if ((type === "tEXt" || type === "zTXt" || type === "iTXt") && len <= MAX_CHUNK) {
        const data = Buffer.alloc(len);
        await fh.read(data, 0, len, pos + 8);
        try {
          const kv = parseTextChunk(type, data);
          if (kv && !(kv[0] in text)) text[kv[0]] = kv[1].slice(0, MAX_VALUE);
        } catch {
          /* 忽略损坏的块 */
        }
      }
      pos += 12 + len;
    }
  } finally {
    await fh.close();
  }
  return { text, colorType };
}

function parseTextChunk(type: string, data: Buffer): [string, string] | null {
  const nul = data.indexOf(0);
  if (nul <= 0) return null;
  const key = data.toString("latin1", 0, nul);
  if (type === "tEXt") return [key, data.toString("latin1", nul + 1)];
  if (type === "zTXt") return [key, inflateSync(data.subarray(nul + 2)).toString("utf8")];
  // iTXt: keyword\0 flag method lang\0 translated\0 text
  const flag = data[nul + 1];
  let p = nul + 3;
  p = data.indexOf(0, p) + 1;
  p = data.indexOf(0, p) + 1;
  const body = data.subarray(p);
  return [key, (flag ? inflateSync(body) : body).toString("utf8")];
}

/** 读取 NovelAI 隐写信息(仅限带 alpha 的 PNG)。失败返回 null。 */
export async function readStealthInfo(file: string, width: number, height: number): Promise<Record<string, string> | null> {
  if (width * height > 16_000_000 || width < 8 || height < 8) return null;
  const { data } = await sharp(file, { failOn: "none" })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  // 列优先遍历 alpha 最低位
  let idx = 0;
  const total = width * height;
  const nextBit = () => {
    if (idx >= total) return -1;
    const x = Math.floor(idx / height);
    const y = idx % height;
    idx++;
    return data[y * width + x] & 1;
  };
  const readBytes = (n: number): Buffer | null => {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let b = 0; b < 8; b++) {
        const bit = nextBit();
        if (bit < 0) return null;
        v = (v << 1) | bit;
      }
      out[i] = v;
    }
    return out;
  };
  const magic = readBytes(15);
  if (!magic) return null;
  const m = magic.toString("latin1");
  if (m !== "stealth_pngcomp" && m !== "stealth_pnginfo") return null;
  const lenBuf = readBytes(4);
  if (!lenBuf) return null;
  const bytes = Math.floor(lenBuf.readUInt32BE(0) / 8);
  if (bytes <= 0 || bytes > 8 * 1024 * 1024 || bytes * 8 > total) return null;
  const payload = readBytes(bytes);
  if (!payload) return null;
  const raw = m === "stealth_pngcomp" ? gunzipSync(payload) : payload;
  const obj = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  return out;
}
