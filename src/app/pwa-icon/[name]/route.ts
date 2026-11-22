// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { dirs } from "@/server/config";
import { DEFAULT_ICON } from "@/server/api/auth";
import { ensureReady } from "@/server/ready";
import { getSite } from "@/server/settings";

export const dynamic = "force-dynamic";

/** PWA 图标(PNG):由站点图标(自定义或内置)按需渲染。name: 192.png | 512.png | 512-maskable.png | 180.png */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const m = /^(\d{3})(-maskable)?\.png$/.exec(name);
  const size = m ? Number(m[1]) : 0;
  if (![180, 192, 512].includes(size)) return new Response("not found", { status: 404 });
  const maskable = !!m?.[2];
  try {
    await ensureReady();
    const site = await getSite();
    let src: Buffer = Buffer.from(DEFAULT_ICON);
    if (site.iconVersion > 0) {
      const b = await fs.readFile(path.join(dirs.branding, "icon")).catch(() => null);
      if (b) src = b;
    }
    // maskable 需要 ~20% 安全边距,并铺满不透明底色
    const inner = maskable ? Math.round(size * 0.66) : size;
    const icon = await sharp(src, { density: 384 })
      .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const out = maskable
      ? await sharp({ create: { width: size, height: size, channels: 4, background: { r: 217, g: 119, b: 87, alpha: 1 } } })
          .composite([{ input: icon, gravity: "centre" }])
          .png()
          .toBuffer()
      : icon;
    return new Response(new Uint8Array(out), { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" } });
  } catch {
    return new Response("icon error", { status: 500 });
  }
}
