// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import type { MetadataRoute } from "next";
import { DEFAULT_SITE, getSite } from "@/server/settings";
import { ensureReady } from "@/server/ready";

export const dynamic = "force-dynamic";

/** PWA 清单:站点名与图标跟随「设置 → 外观」,可安装到手机主屏幕 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  let s = DEFAULT_SITE;
  try {
    await ensureReady();
    s = await getSite();
  } catch {
    /* 数据库不可用时使用默认值 */
  }
  const v = s.iconVersion;
  return {
    id: "/",
    name: s.siteName,
    short_name: s.siteName.length > 12 ? s.siteName.slice(0, 12) : s.siteName,
    description: "自托管图片与视频相册服务",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f0eee6",
    theme_color: s.theme.accent || "#d97757",
    lang: "zh-CN",
    categories: ["photo", "entertainment"],
    icons: [
      { src: `/pwa-icon/192.png?v=${v}`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `/pwa-icon/512.png?v=${v}`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `/pwa-icon/512-maskable.png?v=${v}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
