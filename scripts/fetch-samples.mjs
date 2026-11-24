#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 测试素材准备:从 NASA Image and Video Library 下载真实图片/视频,并合成若干边界文件。
 *
 * 用法:
 *   node scripts/fetch-samples.mjs [--out /tmp/pgs-samples] [--images 10] [--videos 2]
 *                                  [--max-mb 25] [--offline]
 *
 * 产物(--out 目录):
 *   nasa/*.jpg|png|mp4        NASA 真实素材(带 EXIF 的 JPEG 优先),manifest.json 记录来源与 EXIF 摘要
 *   synth/exif-known.jpg      合成:已知 EXIF(Make/Model/ISO/光圈…),用于精确断言元数据
 *   synth/ai-a1111.png        合成:带 Stable Diffusion WebUI `parameters` 文本块的 PNG
 *   synth/fmt.{webp,gif,tif,bmp,avif}   合成:多格式
 *   synth/portrait-rotated.jpg          EXIF Orientation=6
 *   synth/corrupt.jpg         合成:内容是随机字节的"伪图片"(应被判为损坏)
 *   synth/中文 名字 (1).jpg   合成:含中文与空格的文件名
 *   synth/note.txt            非媒体文件(应被忽略/拒绝)
 *   synth/dup-source.jpg / dup-copy.jpg   内容相同,用于去重
 *   synth/tiny.mp4            ffmpeg 可用时合成的 2 秒测试视频(NASA 视频下载失败时的兜底)
 *
 * 幂等:已存在且大小一致的文件不会重复下载。--offline 时只生成合成素材。
 * 环境变量:FFMPEG_PATH(合成视频用,可选)。
 */
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import sharp from "sharp";
import exifr from "exifr";

const execFileP = promisify(execFile);
const { values: a } = parseArgs({
  options: {
    out: { type: "string", default: process.env.SAMPLES_DIR || "/tmp/pgs-samples" },
    images: { type: "string", default: "10" },
    videos: { type: "string", default: "2" },
    "max-mb": { type: "string", default: "25" },
    offline: { type: "boolean", default: false },
  },
});
const OUT = path.resolve(a.out);
const NASA = path.join(OUT, "nasa");
const SYN = path.join(OUT, "synth");
const MAX = Number(a["max-mb"]) * 1024 * 1024;
const WANT_IMG = Number(a.images);
const WANT_VID = Number(a.videos);
const UA = { "user-agent": "pgs-test-samples/1.0" };

await fs.mkdir(NASA, { recursive: true });
await fs.mkdir(SYN, { recursive: true });

async function jget(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
      if (r.ok) return await r.json();
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  return null;
}

async function head(url) {
  try {
    const r = await fetch(url, { method: "HEAD", headers: UA, signal: AbortSignal.timeout(20_000), redirect: "follow" });
    return r.ok ? Number(r.headers.get("content-length") || 0) : 0;
  } catch {
    return 0;
  }
}

async function download(url, file) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(180_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      await fs.writeFile(file, buf);
      return buf.length;
    } catch (e) {
      if (i === 2) console.warn(`  ! 下载失败 ${url}: ${e.message}`);
    }
  }
  return 0;
}

const manifest = { generatedAt: new Date().toISOString(), nasa: [], synth: [] };
if (a.offline) {
  // 离线模式只重生成合成素材,保留此前下载的 NASA 清单
  try {
    manifest.nasa = JSON.parse(await fs.readFile(path.join(OUT, "manifest.json"), "utf8")).nasa || [];
  } catch {
    /* 没有旧清单 */
  }
}

/** 在 NASA 搜索结果里挑出可用素材 */
async function pickNasa(kind, want, queries) {
  const got = [];
  const seen = new Set();
  for (const q of queries) {
    if (got.length >= want) break;
    const s = await jget(`https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=${kind}&page_size=12`);
    for (const it of s?.collection?.items || []) {
      if (got.length >= want) break;
      const nasaId = it.data?.[0]?.nasa_id;
      if (!nasaId || seen.has(nasaId)) continue;
      seen.add(nasaId);
      const assets = await jget(it.href);
      if (!Array.isArray(assets)) continue;
      const rank = kind === "image" ? ["~orig", "~large", "~medium"] : ["~medium", "~small", "~mobile", "~orig"];
      const okExt = kind === "image" ? /\.(jpe?g|png)$/i : /\.mp4$/i;
      const cands = [];
      for (const r of rank) for (const u of assets) if (u.includes(r) && okExt.test(u)) cands.push(u);
      for (const raw of cands) {
        const url = raw.replace(/^http:/, "https:");
        const len = await head(url);
        if (len > 2000 && len <= MAX) {
          got.push({ nasaId, url, title: it.data[0].title, center: it.data[0].center, dateCreated: it.data[0].date_created, size: len, kind });
          break;
        }
      }
    }
  }
  return got;
}

if (!a.offline) {
  console.log(`# 从 NASA 下载素材 → ${NASA}`);
  const imgs = await pickNasa("image", WANT_IMG, ["hubble nebula", "apollo 11", "earth from space", "mars rover", "jupiter", "international space station", "galaxy", "webb telescope"]);
  const vids = WANT_VID > 0 ? await pickNasa("video", WANT_VID, ["apollo 11 launch", "mars landing", "earth timelapse", "rocket launch"]) : [];
  for (const it of [...imgs, ...vids]) {
    const base = it.nasaId.replace(/[^\w.-]+/g, "_");
    const ext = path.extname(new URL(it.url).pathname).toLowerCase() || ".jpg";
    const file = path.join(NASA, base + ext);
    let size = 0;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      /* not there */
    }
    if (size !== it.size) {
      console.log(`  ↓ ${path.basename(file)} (${(it.size / 1048576).toFixed(1)} MB)`);
      size = await download(it.url, file);
    } else console.log(`  = ${path.basename(file)} 已存在`);
    if (!size) continue;
    let exif = null;
    if (/\.jpe?g$/i.test(file)) {
      try {
        const e = await exifr.parse(file, { tiff: true, exif: true, gps: true, xmp: false });
        exif = e ? { make: e.Make, model: e.Model, hasGps: e.latitude != null, hasDate: !!e.DateTimeOriginal } : null;
      } catch {
        /* ignore */
      }
    }
    const { url, ...rest } = it;
    manifest.nasa.push({ file: path.basename(file), url, ...rest, exif });
  }
  console.log(`  NASA 图片 ${manifest.nasa.filter((x) => x.kind === "image").length} / 视频 ${manifest.nasa.filter((x) => x.kind === "video").length}`);
}

/* ---------------- 合成素材 ---------------- */
console.log(`# 生成合成素材 → ${SYN}`);

async function baseImage(w = 800, h = 600) {
  // 渐变图,保证有内容
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = (x * 255) / w;
      raw[i + 1] = (y * 255) / h;
      raw[i + 2] = ((x + y) * 3) & 255;
    }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } });
}

const synth = async (name, buf, note) => {
  await fs.writeFile(path.join(SYN, name), buf);
  manifest.synth.push({ file: name, size: buf.length, note });
};

// 1) 已知 EXIF 的 JPEG
await synth(
  "exif-known.jpg",
  await (await baseImage(1200, 800))
    .withExif({
      IFD0: { Make: "PGS-Test", Model: "TestCam 9000", Software: "pgs-test-suite", Artist: "Test Artist", Copyright: "(c) pgs" },
      IFD2: { ISOSpeedRatings: "400", FNumber: "28/10", ExposureTime: "1/250", FocalLength: "50/1", DateTimeOriginal: "2021:07:20 12:34:56" },
    })
    .jpeg({ quality: 88 })
    .toBuffer(),
  "Make=PGS-Test Model=TestCam 9000 ISO=400 taken=2021-07-20",
);

// 2) 带 SD WebUI 参数文本块的 PNG
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
{
  const png = await (await baseImage(512, 512)).png().toBuffer();
  const text = Buffer.from(
    "parameters\0a red panda astronaut, masterpiece\nNegative prompt: lowres, blurry\nSteps: 28, Sampler: Euler a, CFG scale: 7, Seed: 123456789, Size: 512x512, Model: pgs-test-model",
    "latin1",
  );
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  await synth("ai-a1111.png", Buffer.concat([png.subarray(0, ihdrEnd), pngChunk("tEXt", text), png.subarray(ihdrEnd)]), "SD WebUI parameters: seed=123456789 steps=28");
}

// 3) 多格式
const b = await baseImage(640, 480);
await synth("fmt.webp", await b.clone().webp().toBuffer(), "webp");
await synth("fmt.gif", await b.clone().gif().toBuffer(), "gif");
await synth("fmt.tif", await b.clone().tiff().toBuffer(), "tiff");
{
  // sharp 不能写 bmp:手工写一个 24 位 BMP
  const { data, info } = await b.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rowSize = Math.ceil((info.width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + rowSize * info.height);
  out.write("BM", 0);
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(info.width, 18);
  out.writeInt32LE(info.height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(rowSize * info.height, 34);
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const s = (y * info.width + x) * 3;
      const d = 54 + (info.height - 1 - y) * rowSize + x * 3;
      out[d] = data[s + 2];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s];
    }
  await synth("fmt.bmp", out, "bmp");
}
try {
  await synth("fmt.avif", await b.clone().avif({ quality: 40, effort: 0 }).toBuffer(), "avif");
} catch (e) {
  console.warn("  ! avif 生成失败(跳过):", e.message);
}
await synth("portrait-rotated.jpg", await (await baseImage(600, 900)).withMetadata({ orientation: 6 }).jpeg().toBuffer(), "EXIF Orientation=6(旋转后应为 900x600)");

// 4) 损坏/非媒体/特殊名字/去重
await synth("corrupt.jpg", Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) & 255)), "随机字节伪装成 jpg");
await synth("note.txt", Buffer.from("not a media file\n"), "非媒体");
await synth("中文 名字 (1).jpg", await (await baseImage(320, 240)).jpeg().toBuffer(), "中文+空格+括号文件名");
await synth("dup-source.jpg", await (await baseImage(333, 222)).jpeg().toBuffer(), "用于去重测试(同内容 dup-copy.jpg)");
await fs.copyFile(path.join(SYN, "dup-source.jpg"), path.join(SYN, "dup-copy.jpg"));
manifest.synth.push({ file: "dup-copy.jpg", note: "与 dup-source.jpg 内容相同" });

// 5) 兜底视频
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
try {
  await execFileP(FFMPEG, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(SYN, "tiny.mp4")]);
  manifest.synth.push({ file: "tiny.mp4", note: "ffmpeg 合成 2 秒视频" });
} catch {
  console.warn("  ! 未找到 ffmpeg,跳过 tiny.mp4(可设 FFMPEG_PATH)");
}

await fs.writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
const n = (await fs.readdir(NASA)).length + (await fs.readdir(SYN)).length;
console.log(`完成:共 ${n} 个文件 → ${OUT}`);
