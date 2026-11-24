// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 最小 BMP 解码器(sharp / libvips 预编译版本不带 BMP 加载器,直接 sharp(bmp) 会报
 * "Input file contains unsupported image format")。
 * 支持:BI_RGB 的 1/4/8 位调色板、16 位(555)、24 位、32 位;BI_BITFIELDS 的 16/32 位;
 * 自底向上与自顶向下。不支持 RLE 压缩(抛错,文件会被判为无法处理)。
 * 输出 RGBA 原始像素,交给 sharp 的 raw 输入。
 */
export function isBmp(filename: string): boolean {
  return /\.bmp$/i.test(filename);
}

export function decodeBmp(buf: Buffer): { data: Buffer; width: number; height: number } {
  if (buf.length < 26 || buf.toString("latin1", 0, 2) !== "BM") throw new Error("不是有效的 BMP 文件");
  const dataOffset = buf.readUInt32LE(10);
  const hdrSize = buf.readUInt32LE(14);
  let width: number, height: number, bpp: number, compression = 0, colorsUsed = 0;
  if (hdrSize === 12) {
    width = buf.readUInt16LE(18);
    height = buf.readUInt16LE(20);
    bpp = buf.readUInt16LE(24);
  } else {
    width = buf.readInt32LE(18);
    height = buf.readInt32LE(22);
    bpp = buf.readUInt16LE(28);
    compression = buf.readUInt32LE(30);
    colorsUsed = buf.readUInt32LE(46);
  }
  const topDown = height < 0;
  height = Math.abs(height);
  if (!width || !height || width > 30000 || height > 30000) throw new Error("BMP 尺寸非法");
  if (compression !== 0 && compression !== 3) throw new Error(`不支持压缩的 BMP(compression=${compression})`);

  // 调色板
  let palette: Buffer | null = null;
  const palEntry = hdrSize === 12 ? 3 : 4;
  if (bpp <= 8) {
    const n = colorsUsed || 1 << bpp;
    const start = 14 + hdrSize;
    palette = buf.subarray(start, start + n * palEntry);
  }
  // BITFIELDS 掩码
  let masks = bpp === 16 ? [0x7c00, 0x03e0, 0x001f, 0] : [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000];
  if (compression === 3 && hdrSize >= 40) {
    masks = [buf.readUInt32LE(54), buf.readUInt32LE(58), buf.readUInt32LE(62), hdrSize >= 56 ? buf.readUInt32LE(66) : 0];
  }
  const shiftOf = (m: number) => (m ? Math.clz32(m & -m) ^ 31 : 0);
  const sizeOf = (m: number) => {
    if (!m) return 0;
    let v = m >>> shiftOf(m), n = 0;
    while (v & 1) { n++; v >>>= 1; }
    return n;
  };
  const chan = (v: number, m: number) => {
    if (!m) return 255;
    const bits = sizeOf(m);
    const x = (v & m) >>> shiftOf(m);
    return bits >= 8 ? x >>> (bits - 8) : Math.round((x * 255) / ((1 << bits) - 1));
  };

  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  if (dataOffset + rowSize * height > buf.length + 3) throw new Error("BMP 数据被截断");
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : height - 1 - y;
    const row = dataOffset + srcY * rowSize;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r = 0, g = 0, b = 0, a = 255;
      if (bpp === 24) {
        const p = row + x * 3;
        b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
      } else if (bpp === 32) {
        const v = buf.readUInt32LE(row + x * 4);
        r = chan(v, masks[0]); g = chan(v, masks[1]); b = chan(v, masks[2]);
        a = compression === 3 && masks[3] ? chan(v, masks[3]) : 255;
      } else if (bpp === 16) {
        const v = buf.readUInt16LE(row + x * 2);
        r = chan(v, masks[0]); g = chan(v, masks[1]); b = chan(v, masks[2]);
      } else if (palette) {
        let idx: number;
        if (bpp === 8) idx = buf[row + x];
        else if (bpp === 4) idx = (buf[row + (x >> 1)] >> (x & 1 ? 0 : 4)) & 0x0f;
        else idx = (buf[row + (x >> 3)] >> (7 - (x & 7))) & 1;
        const p = idx * palEntry;
        if (p + 2 < palette.length) { b = palette[p]; g = palette[p + 1]; r = palette[p + 2]; }
      } else throw new Error(`不支持的 BMP 位深 ${bpp}`);
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  return { data: out, width, height };
}
