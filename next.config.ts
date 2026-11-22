import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 原生/大体积依赖不参与打包
  serverExternalPackages: ["sharp", "exifr", "heic-convert", "busboy", "@aws-sdk/client-s3"],
  poweredByHeader: false,
};

export default nextConfig;
