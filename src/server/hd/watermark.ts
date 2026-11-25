// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { PROJECT_URL, config } from "../config";

/**
 * 服务端真实水印:文字直接合成进最终 WebP 像素,不是 CSS 覆盖。
 *  - 双层(白字 + 1px 黑色投影)低透明度,旋转后交错平铺;浅色/深色背景上都隐约可辨,不影响观感
 *  - 第一行类型:站点来源「Source: {host} · github.com/DMing623/PicGalleryServer」
 *    第二行类型:登录用户动态标识 U-XXXXXX(用户 id 的 HMAC 短码,不可逆,不含 IP/用户名)
 *  - 域名通过 {host} 宏在请求时填充(跟随 PUBLIC_BASE_URL / 请求域名),GitHub 地址固定
 *  - 水印文字使用打包的 DejaVu Sans 字体渲染(服务器无需安装任何系统字体)
 */

const DEFAULT_FONT = path.join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf", "DejaVuSans.ttf");

function fontFile(): string {
  const f = config.hd.wm.fontFile || DEFAULT_FONT;
  if (!fs.existsSync(f)) throw new Error(`水印字体不存在: ${f}(请检查 dejavu-fonts-ttf 依赖或 HD_WM_FONT_FILE)`);
  return f;
}

/** 登录用户的动态标识:HMAC(用户 id) 的 6 位大写短码,管理员可通过 /security/watermark 反查 */
export function userMarkCode(userId: string): string {
  const d = createHmac("sha256", config.sessionSecret).update(`wm|${userId}`).digest("base64url").replace(/[-_]/g, "").toUpperCase();
  return `U-${d.slice(0, 6)}`;
}

export function expandWatermarkText(host: string): string {
  return config.hd.wm.text.replaceAll("{host}", host).replaceAll("{project}", PROJECT_URL);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function textPng(text: string, size: number, color: string, alphaPct: number): Promise<Buffer> {
  return sharp({
    text: {
      text: `<span foreground="${color}" alpha="${Math.max(1, Math.round(alphaPct))}%">${esc(text)}</span>`,
      font: `DejaVu Sans ${size}`,
      fontfile: fontFile(),
      rgba: true,
      dpi: 72,
    },
  })
    .png()
    .toBuffer();
}

async function rotated(buf: Buffer, angle: number) {
  const out = await sharp(buf).rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer({ resolveWithObject: true });
  return { buf: out.data, w: out.info.width, h: out.info.height };
}

/** 水印层缓存(同样文字/尺寸/参数复用,避免每次请求重绘) */
const layerCache = new Map<string, Promise<Buffer>>();

async function buildLayer(W: number, H: number, siteText: string, userText: string | null): Promise<Buffer> {
  const wm = config.hd.wm;
  const size = Math.max(8, Math.round(wm.fontSize * Math.min(1.4, Math.max(0.7, W / 1920))));
  const siteImgs = await Promise.all([textPng(siteText, size, "#000000", wm.opacity * 0.55), textPng(siteText, size, "#ffffff", wm.opacity)]);
  const userImgs = userText ? await Promise.all([textPng(userText, size, "#000000", wm.opacity * 0.55), textPng(userText, size, "#ffffff", wm.opacity)]) : null;
  const sMeta = await sharp(siteImgs[1]).metadata();
  const tw = sMeta.width ?? 400;
  const th = sMeta.height ?? size;

  const angle = wm.angle;
  const rs = await Promise.all(siteImgs.map((b) => rotated(b, angle)));
  const ru = userImgs ? await Promise.all(userImgs.map((b) => rotated(b, angle))) : null;

  // 密度 1(稀疏) ~ 5(密集):决定水平/垂直间距
  const d = wm.density;
  const cw = tw * (1.65 - 0.28 * d) + tw;
  const ch = th * (9.2 - 1.5 * d);
  const pad = Math.ceil(Math.max(rs[0].w, rs[0].h, ru?.[0].w ?? 0, ru?.[0].h ?? 0)) + 4;
  const CW = W + pad * 2;
  const CH = H + pad * 2;
  const R = Math.hypot(W, H) / 2 + tw;
  const cos = Math.cos((angle * Math.PI) / 180);
  const sin = Math.sin((angle * Math.PI) / 180);

  const parts: OverlayOptions[] = [];
  const iMax = Math.ceil(R / cw) + 1;
  const jMax = Math.ceil(R / ch) + 1;
  for (let j = -jMax; j <= jMax; j++) {
    const odd = Math.abs(j) % 2 === 1;
    const set = odd && ru ? ru : rs;
    for (let i = -iMax; i <= iMax; i++) {
      const u = i * cw + (odd ? cw / 2 : 0);
      const v = j * ch;
      const cx = CW / 2 + u * cos - v * sin;
      const cy = CH / 2 + u * sin + v * cos;
      const left = Math.round(cx - set[0].w / 2);
      const top = Math.round(cy - set[0].h / 2);
      if (left < 1 || top < 1 || left + set[0].w + 1 > CW || top + set[0].h + 1 > CH) continue;
      // 坐标换算到「可见区域 W×H」的坐标系(减去 pad);完全落在可见区之外的瓦片不参与合成
      const vx = left - pad;
      const vy = top - pad;
      if (vx + set[0].w + 1 <= 0 || vy + set[0].h + 1 <= 0 || vx >= W || vy >= H) continue;
      parts.push({ input: set[0].buf, left: vx + 1, top: vy + 1 }); // 投影(下层)
      parts.push({ input: set[1].buf, left: vx, top: vy });
    }
  }
  // 直接在 W×H 画布上合成(瓦片允许负偏移,超出部分被裁剪),只编码一次 PNG:
  // 旧实现先建 (W+2pad)×(H+2pad) 画布(2560×1707 时约 9MP,面积是目标的 2 倍以上)编码成 PNG,
  // 再 extract 二次解码并再编码 PNG;两者像素结果完全一致(已用测试对比)。
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(parts)
    .png({ compressionLevel: 6 })
    .toBuffer();
}

function layerFor(W: number, H: number, siteText: string, userText: string | null): Promise<Buffer> {
  const wm = config.hd.wm;
  const key = [W, H, siteText, userText ?? "", wm.opacity, wm.fontSize, wm.angle, wm.density].join("|");
  let p = layerCache.get(key);
  if (!p) {
    p = buildLayer(W, H, siteText, userText);
    layerCache.set(key, p);
    p.catch(() => layerCache.delete(key));
    // 变体数量上限(被伪造 Host 刷时也只保留最近 24 个,而不是每次重建)
    while (layerCache.size > 24) {
      const oldest = layerCache.keys().next();
      if (oldest.done) break;
      layerCache.delete(oldest.value);
    }
  }
  return p;
}

export interface WatermarkOpts {
  host: string;
  /** 登录用户 id(为空表示游客,不叠加用户标识) */
  userId: string | null;
}

/** 把水印合成进 WebP,返回新的 WebP。失败时抛错(不会退回无水印图片) */
export async function applyWatermark(webp: Buffer, o: WatermarkOpts): Promise<Buffer> {
  const wm = config.hd.wm;
  const meta = await sharp(webp).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) throw new Error("无法读取高清图尺寸");
  const siteText = expandWatermarkText(o.host);
  const userText = wm.userMark && o.userId ? userMarkCode(o.userId) : null;
  const layer = await layerFor(W, H, siteText, userText);
  return sharp(webp)
    .composite([{ input: layer, blend: "over" }])
    .webp({ quality: Math.min(95, config.hd.quality + 3) })
    .toBuffer();
}
