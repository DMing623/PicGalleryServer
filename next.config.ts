// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import type { NextConfig } from "next";

/** 全局安全响应头(issue §1.11):所有路由统一补齐,避免逐个接口遗漏 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  // 原生/大体积依赖不参与打包
  serverExternalPackages: ["sharp", "exifr", "heic-convert", "busboy", "@aws-sdk/client-s3"],
  poweredByHeader: false,
  // 开发模式的 Next 悬浮球固定在左下角,底部毛玻璃栏会让出它的位置
  devIndicators: { position: "bottom-left" },
  async headers() {
    return [
      // 全局安全头
      { source: "/:path*", headers: SECURITY_HEADERS },
      // Service Worker 必须每次校验更新
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }, { key: "Service-Worker-Allowed", value: "/" }] },
      // 高清预览:任何缓存层(浏览器 / CDN / Nginx)都不得保存
      { source: "/api/v1/media/:id/hd", headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }] },
      { source: "/api/v1/media/:id/hd-token", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      // 文件直链:不把带 key 的 URL 通过 Referer 泄给第三方(issue §1.5)
      { source: "/f/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Robots-Tag", value: "noindex, noimageindex" }] },
      // 派生图/原文件接口:禁止搜索引擎索引(issue §11.5)
      { source: "/api/v1/media/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, noimageindex" }] },
    ];
  },
};

export default nextConfig;
