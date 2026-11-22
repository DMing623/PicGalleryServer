// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/** 媒体类型识别与文件名工具。 */

export const IMAGE_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  heic: "image/heic", heif: "image/heif", hif: "image/heif",
};

export const VIDEO_EXT: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mkv: "video/x-matroska", avi: "video/x-msvideo", wmv: "video/x-ms-wmv", flv: "video/x-flv",
  "3gp": "video/3gpp", mpg: "video/mpeg", mpeg: "video/mpeg", ts: "video/mp2t",
};

export type MediaKind = "image" | "video";

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function detectKind(filename: string): { kind: MediaKind; mime: string } | null {
  const ext = extOf(filename);
  if (IMAGE_EXT[ext]) return { kind: "image", mime: IMAGE_EXT[ext] };
  if (VIDEO_EXT[ext]) return { kind: "video", mime: VIDEO_EXT[ext] };
  return null;
}

export function isHeic(filename: string): boolean {
  return ["heic", "heif", "hif"].includes(extOf(filename));
}

/** 清洗文件名:去路径、去控制字符、限制长度,保留中文等 Unicode */
export function safeName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "file";
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+/, "").trim();
  const out = cleaned.length > 180 ? cleaned.slice(-180) : cleaned;
  return out || "file";
}

export function randomId(len = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}
