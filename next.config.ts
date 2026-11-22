// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 原生/大体积依赖不参与打包
  serverExternalPackages: ["sharp", "exifr", "heic-convert", "busboy", "@aws-sdk/client-s3"],
  poweredByHeader: false,
  // 开发模式的 Next 悬浮球固定在左下角,底部毛玻璃栏会让出它的位置
  devIndicators: { position: "bottom-left" },
  async headers() {
    return [
      // Service Worker 必须每次校验更新
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }, { key: "Service-Worker-Allowed", value: "/" }] },
      // 高清预览:任何缓存层(浏览器 / CDN / Nginx)都不得保存
      { source: "/api/v1/media/:id/hd", headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }] },
      { source: "/api/v1/media/:id/hd-token", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    ];
  },
};

export default nextConfig;
