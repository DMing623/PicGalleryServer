#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 合成基准素材(需要已执行 npm ci 的 sharp;不需要 root、不联网)。
 * 内容是「渐变 + 轻噪声」,压缩特性接近真实照片,但它【是合成素材】——结论需用真实素材复核。
 *
 *   node scripts/bench/generate-images.mjs [--out /tmp/pgs-bench] [--quick]
 *   --quick  像素量缩小为 1/4(CI/小机器冒烟用)
 *
 * 输出 manifest.json(名称/格式/像素/特性),bench-memory.mjs 读取它。
 * HEIC(iPhone 样张)无法合成:请把真实 .heic 放进 <out>/real/ 目录,bench 会自动纳入。
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = path.resolve(opt("--out", "/tmp/pgs-bench"));
const QUICK = args.includes("--quick");
fs.mkdirSync(OUT, { recursive: true });

/** 目标像素 → 近似 4:3 的宽高 */
const dims = (mp) => {
  const px = (mp * 1e6) / (QUICK ? 4 : 1);
  const h = Math.round(Math.sqrt((px * 3) / 4));
  return { w: Math.round((px) / h), h };
};

/** 生成原始像素 Buffer(最大约 200MB:50MP×3 或 24MP×3×2,generator 一次只处理一张) */
function rawPixels(w, h, channels, bytesPerSample = 1) {
  const buf = Buffer.alloc(w * h * channels * bytesPerSample);
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        const base = ((x * 255) / w + (y * 255) / h + c * 40) % 256;
        const v = Math.max(0, Math.min(255, Math.round(base + ((x * 7 + y * 13 + c) % 9) - 4)));
        if (bytesPerSample === 2) {
          buf.writeUInt16LE(v * 257, o);
          o += 2;
        } else buf[o++] = v;
      }
    }
  }
  return buf;
}

async function make(name, mp, channels, depth, build, note) {
  const { w, h } = dims(mp);
  const file = path.join(OUT, name);
  const raw = { width: w, height: h, channels, ...(depth === 16 ? { depth: "ushort" } : {}) };
  const img = sharp(rawPixels(w, h, channels, depth === 16 ? 2 : 1), { raw, limitInputPixels: false });
  await build(img).toFile(file);
  return { name, file, width: w, height: h, megapixels: Math.round((w * h) / 1e5) / 10, bytes: fs.statSync(file).size, note };
}

const items = [];
const jobs = [
  ["jpeg-24mp-baseline.jpg", 24, 3, 8, (i) => i.jpeg({ quality: 90, progressive: false }), "基线 JPEG(流式解码)"],
  ["jpeg-24mp-progressive.jpg", 24, 3, 8, (i) => i.jpeg({ quality: 90, progressive: true }), "渐进 JPEG(需整图缓冲)"],
  ["jpeg-48mp-progressive.jpg", 48, 3, 8, (i) => i.jpeg({ quality: 90, progressive: true }), "48MP 渐进 JPEG"],
  ["png-50mp-flat.png", 50, 3, 8, (i) => i.png({ compressionLevel: 1, progressive: false }), "非隔行 PNG(流式)"],
  ["png-50mp-interlaced.png", 50, 3, 8, (i) => i.png({ compressionLevel: 1, progressive: true }), "隔行 PNG(整图缓冲)"],
  ["png16-24mp.png", 24, 3, 16, (i) => i.png({ compressionLevel: 1 }), "16-bit PNG"],
  ["tiff-40mp.tif", 40, 3, 8, (i) => i.tiff({ compression: "deflate" }), "TIFF deflate"],
  ["tiff-cmyk-24mp.tif", 24, 4, 8, (i) => i.tiff({ compression: "deflate" }), "CMYK TIFF"],
];
for (const j of jobs) {
  process.stdout.write(`生成 ${j[0]} ... `);
  try {
    const r = await make(...j);
    items.push(r);
    console.log(`${r.width}x${r.height} ${(r.bytes / 1048576).toFixed(1)}MB`);
  } catch (e) {
    console.log(`失败:${e.message}`);
  }
}

// BMP:自带 24-bit 写出器(sharp 预编译版不含 BMP 编码/解码,项目用 media/bmp.ts 解码)
{
  const { w, h } = dims(24);
  const file = path.join(OUT, "bmp-24mp.bmp");
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const head = Buffer.alloc(54);
  head.write("BM", 0);
  head.writeUInt32LE(54 + rowSize * h, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(w, 18);
  head.writeInt32LE(h, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(rowSize * h, 34);
  const fd = fs.openSync(file, "w");
  fs.writeSync(fd, head);
  const row = Buffer.alloc(rowSize);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      row[x * 3] = (x * 255) / w;
      row[x * 3 + 1] = (y * 255) / h;
      row[x * 3 + 2] = (x + y) % 256;
    }
    fs.writeSync(fd, row);
  }
  fs.closeSync(fd);
  items.push({ name: "bmp-24mp.bmp", file, width: w, height: h, megapixels: Math.round((w * h) / 1e5) / 10, bytes: fs.statSync(file).size, note: "24-bit BMP(走内置解码器)" });
  console.log(`生成 bmp-24mp.bmp ${w}x${h}`);
}

// 用户放入 real/ 的真实素材(HEIC、相机 JPEG 等)
const realDir = path.join(OUT, "real");
if (fs.existsSync(realDir)) {
  for (const f of fs.readdirSync(realDir)) {
    if (!/\.(heic|heif|jpe?g|png|tiff?|webp|bmp)$/i.test(f)) continue;
    const file = path.join(realDir, f);
    let meta = {};
    try {
      meta = /\.(heic|heif|bmp)$/i.test(f) ? {} : await sharp(file).metadata();
    } catch {}
    items.push({ name: `real/${f}`, file, width: meta.width ?? null, height: meta.height ?? null, megapixels: meta.width ? Math.round((meta.width * meta.height) / 1e5) / 10 : null, bytes: fs.statSync(file).size, note: "真实素材", real: true });
  }
} else {
  console.log(`(提示)把真实 HEIC / 相机原图放进 ${realDir} 后重跑本脚本,可纳入基准`);
}

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ quick: QUICK, createdAt: new Date().toISOString(), items }, null, 2));
console.log(`\n完成:${items.length} 个素材 → ${OUT}/manifest.json`);
