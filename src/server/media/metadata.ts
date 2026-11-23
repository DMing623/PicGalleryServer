// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import exifr from "exifr";
import { config } from "../config";
import { detectAi, type AiMeta } from "./ai";
import { readPngInfo, readStealthInfo } from "./png";

/**
 * 元数据提取。输出结构 MediaMeta 存入 pgs_media.meta(jsonb):
 *  summary: 固定字段集合(前端缺失显示 N/A),分 file/camera/exposure/time/gps/authoring 六组
 *  ai:      AI 生成参数(无则 null)
 *  video:   视频流信息(图片为 null)
 *  text:    PNG 文本块原文
 *  raw:     exifr 各段(IFD0/EXIF/GPS/XMP/IPTC/ICC/...)全部可读字段
 */

export type Scalar = string | number | null;

export interface MediaMeta {
  summary: {
    file: Record<string, Scalar>;
    camera: Record<string, Scalar>;
    exposure: Record<string, Scalar>;
    time: Record<string, Scalar>;
    gps: Record<string, Scalar>;
    authoring: Record<string, Scalar>;
  };
  ai: AiMeta | null;
  video: Record<string, Scalar> | null;
  text: Record<string, string>;
  raw: Record<string, Record<string, string>>;
}

export interface ImageFacts {
  format?: string;
  width: number;
  height: number;
  space?: string;
  depth?: string;
  hasAlpha?: boolean;
  density?: number;
  orientation?: number;
  channels?: number;
  isPng: boolean;
}

/* ---------- 值格式化 ---------- */

function fmt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  // XMP 的多语言字段是 { lang, value } 结构(dc:title / dc:description 等),取 value 而不是整段 JSON
  if (typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)) {
    const lang = (v as { lang?: unknown; value?: unknown }).value;
    if (typeof lang === "string") return fmt(lang);
  }
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") {
    const t = v.replace(/\u0000/g, "").trim();
    return t ? t.slice(0, 4000) : null;
  }
  if (v instanceof Uint8Array) return v.length > 64 ? `[binary ${v.length} bytes]` : null;
  if (Array.isArray(v)) {
    const parts = v.slice(0, 60).map((x) => fmt(x)).filter((x): x is string => !!x);
    return parts.length ? parts.join(", ").slice(0, 4000) : null;
  }
  if (typeof v === "object") {
    try {
      return JSON.stringify(v).slice(0, 4000);
    } catch {
      return null;
    }
  }
  return String(v);
}

type Seg = Record<string, unknown>;

/** 在多个段中不区分大小写地查找第一个存在的字段 */
function pick(segs: Seg[], ...names: string[]): unknown {
  const wanted = names.map((n) => n.toLowerCase());
  for (const seg of segs) {
    const lower = new Map<string, unknown>();
    for (const k of Object.keys(seg)) lower.set(k.toLowerCase(), seg[k]);
    for (const n of wanted) {
      const v = lower.get(n);
      if (v !== undefined && v !== null && v !== "") return v;
    }
  }
  return undefined;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

const dateStr = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return fmt(v);
};

function exposureTime(v: unknown): string | null {
  const n = num(v);
  if (n === null || n <= 0) return fmt(v);
  return n >= 1 ? `${Math.round(n * 10) / 10}s` : `1/${Math.round(1 / n)}s`;
}

/* ---------- 图片 ---------- */

export interface ImageMetaResult {
  meta: MediaMeta;
  takenAt: Date | null;
}

/** EXIF 解析的最大输入体积:超过则跳过 EXIF(避免整文件读入内存) */
const EXIF_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 判断 exifr 的返回值是否真的解析出了内容。
 * exifr 在缓冲区被截断时返回 `{ errors: [...] }` 这种"空壳"结果,
 * 旧实现用 `Object.keys(out).length` 判断成功,会把空壳当成功而停止放大读取,
 * 导致 TIFF(条带偏移表在文件后部)几乎全部丢元数据。
 */
function hasSegments(out: unknown): out is Record<string, Seg> {
  if (!out || typeof out !== "object") return false;
  for (const [k, v] of Object.entries(out as Record<string, unknown>)) {
    if (k === "errors") continue;
    if (v && typeof v === "object" && Object.keys(v as object).length) return true;
  }
  return false;
}

/**
 * 读取待解析的图片内容(issue §6.1)。
 * EXIF/XMP/IPTC/ICC 都在文件头部,只需读前面一段;读不到再按需放大到 8MB,
 * 避免每张图都把整文件(手机原片 3~8MB、扫描件几十 MB)读进内存。
 */
async function readExifInput(file: string, limit = config.exifReadBytes): Promise<Buffer | null> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > EXIF_MAX_BYTES) return null;
    const want = Math.min(st.size, limit);
    const fh = await fs.open(file, "r");
    try {
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** EXIF ColorSpace 码 → 人类可读名称(issue:详情页直接显示 "1" 难以理解) */
function colorSpaceName(v: unknown, fallback?: string): string | null {
  const raw = fmt(v);
  const map: Record<string, string> = { "1": "sRGB", "2": "Adobe RGB", "65535": "未校准", "65534": "未校准" };
  if (raw && map[raw]) return map[raw];
  return raw ?? fallback ?? null;
}

/** sharp 的位深表示 → 人类可读(uchar/ushort/float → 8-bit/16-bit/32-bit) */
function bitDepthName(v: unknown): string | null {
  const raw = fmt(v);
  const map: Record<string, string> = { uchar: "8-bit", ushort: "16-bit", short: "16-bit", uint: "32-bit", int: "32-bit", float: "32-bit", double: "64-bit" };
  if (raw && map[raw]) return map[raw];
  return raw;
}

export async function extractImageMeta(file: string, facts: ImageFacts): Promise<ImageMetaResult> {
  let parsed: Record<string, Seg> = {};
  const parseOpts = {
    tiff: true, ifd0: true, exif: true, gps: true, interop: true, xmp: true, iptc: true, icc: true,
    jfif: true, ihdr: true, makerNote: false, userComment: true, multiSegment: true,
    mergeOutput: false, translateKeys: true, translateValues: true, reviveValues: true,
    sanitize: true, chunked: true,
  } as unknown as Parameters<typeof exifr.parse>[1];
  try {
    // 先读文件头;解析不到任何段时逐级放大(部分格式的 XMP/ICC 位置靠后)。
    // TIFF 的条带偏移表等结构在文件后部,截断缓冲区会让 exifr 返回只含 errors 的空壳,
    // 因此 TIFF 直接读到整文件(仍受 EXIF_MAX_BYTES 约束)。
    const isTiff = /^tiff?$/i.test(facts.format ?? "") || /\.tiff?$/i.test(file);
    const limits = isTiff
      ? [config.exifReadBytes, 8 * 1024 * 1024, EXIF_MAX_BYTES]
      : [config.exifReadBytes, 8 * 1024 * 1024];
    for (const limit of limits) {
      const input = await readExifInput(file, limit);
      if (!input) break;
      const out = (await exifr.parse(input, parseOpts)) as Record<string, Seg> | undefined;
      if (hasSegments(out)) {
        parsed = out;
        break;
      }
      // 已经读到整文件(或到达上限)仍无内容:不必再放大
      if (input.length < limit) break;
    }
  } catch {
    /* 无元数据或格式不支持 */
  }

  // exifr 把 XMP 按命名空间拆成独立段(dc / photoshop / aux / crs ...),
  // 只读 parsed.xmp 会漏掉 dc:title、dc:subject、photoshop:DateCreated 等字段。
  const segOrder = ["ifd0", "exif", "gps", "iptc", "xmp", "dc", "photoshop", "aux", "interop", "icc", "jfif"];
  const segs: Seg[] = [];
  for (const k of segOrder) {
    const s = parsed[k];
    if (s && typeof s === "object") segs.push(s);
  }
  for (const [k, s] of Object.entries(parsed)) {
    if (segOrder.includes(k) || k === "errors" || k === "ihdr") continue;
    if (s && typeof s === "object") segs.push(s);
  }
  const g = (...n: string[]) => pick(segs, ...n);

  // PNG 文本块 + 可能的隐写
  let text: Record<string, string> = {};
  let colorType: number | null = null;
  if (facts.isPng) {
    try {
      const info = await readPngInfo(file);
      text = info.text;
      colorType = info.colorType;
    } catch {
      /* ignore */
    }
  }
  const comment = fmt(g("UserComment")) ?? fmt(g("ImageDescription"));
  let ai = detectAi(text, comment);
  if (!ai && facts.isPng && (colorType === 6 || colorType === 4)) {
    try {
      const stealth = await readStealthInfo(file, facts.width, facts.height);
      if (stealth) {
        text = { ...text, ...Object.fromEntries(Object.entries(stealth).map(([k, v]) => [`stealth:${k}`, v.slice(0, 20000)])) };
        ai = detectAi(stealth, null);
      }
    } catch {
      /* ignore */
    }
  }

  const taken = g("DateTimeOriginal", "CreateDate", "DateCreated");
  const takenAt = taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken : null;

  const lat = num(parsed.gps?.latitude ?? g("GPSLatitude"));
  const lon = num(parsed.gps?.longitude ?? g("GPSLongitude"));

  const kw = g("Keywords", "subject");
  const meta: MediaMeta = {
    summary: {
      file: {
        format: facts.format ?? null,
        width: facts.width,
        height: facts.height,
        megapixels: Math.round((facts.width * facts.height) / 1e4) / 100,
        colorSpace: colorSpaceName(g("ColorSpace"), facts.space),
        iccProfile: fmt(g("ProfileDescription", "DeviceModelDesc")),
        bitDepth: bitDepthName(facts.depth ?? g("BitsPerSample")),
        hasAlpha: facts.hasAlpha === undefined ? null : facts.hasAlpha ? "是" : "否",
        density: facts.density ? `${facts.density} DPI` : null,
        orientation: fmt(g("Orientation")) ?? (facts.orientation ? String(facts.orientation) : null),
      },
      camera: {
        make: fmt(g("Make")),
        model: fmt(g("Model")),
        lens: fmt(g("LensModel", "Lens")),
        lensMake: fmt(g("LensMake")),
        software: fmt(g("Software", "CreatorTool")),
        serial: fmt(g("BodySerialNumber", "SerialNumber")),
      },
      exposure: {
        exposureTime: exposureTime(g("ExposureTime")),
        fNumber: num(g("FNumber")) !== null ? `f/${num(g("FNumber"))}` : null,
        iso: fmt(g("ISO", "ISOSpeedRatings")),
        focalLength: num(g("FocalLength")) !== null ? `${num(g("FocalLength"))}mm` : null,
        focalLength35: num(g("FocalLengthIn35mmFormat")) !== null ? `${num(g("FocalLengthIn35mmFormat"))}mm` : null,
        exposureProgram: fmt(g("ExposureProgram")),
        exposureBias: fmt(g("ExposureCompensation", "ExposureBiasValue")),
        meteringMode: fmt(g("MeteringMode")),
        flash: fmt(g("Flash")),
        whiteBalance: fmt(g("WhiteBalance")),
        sceneType: fmt(g("SceneCaptureType")),
      },
      time: {
        taken: dateStr(g("DateTimeOriginal")),
        created: dateStr(g("CreateDate", "DateCreated")),
        modified: dateStr(g("ModifyDate", "DateTime")),
        timezone: fmt(g("OffsetTimeOriginal", "OffsetTime")),
      },
      gps: {
        latitude: lat,
        longitude: lon,
        altitude: num(g("GPSAltitude")) !== null ? `${Math.round(num(g("GPSAltitude"))! * 10) / 10} m` : null,
        direction: fmt(g("GPSImgDirection")),
      },
      authoring: {
        title: fmt(g("title", "ObjectName", "Headline")),
        description: fmt(g("ImageDescription", "description", "Caption", "Caption-Abstract")),
        artist: fmt(g("Artist", "creator", "By-line")),
        copyright: fmt(g("Copyright", "rights", "CopyrightNotice")),
        keywords: fmt(kw),
        rating: fmt(g("Rating")),
        userComment: fmt(g("UserComment")),
      },
    },
    ai,
    video: null,
    text,
    raw: {},
  };

  const sectionNames: Record<string, string> = {
    ifd0: "IFD0", exif: "EXIF", gps: "GPS", interop: "Interop", xmp: "XMP", iptc: "IPTC", icc: "ICC", jfif: "JFIF", ihdr: "PNG-IHDR",
    dc: "XMP-dc", photoshop: "XMP-photoshop", aux: "XMP-aux",
  };
  for (const [key, label] of Object.entries(sectionNames)) {
    const seg = parsed[key];
    if (!seg || typeof seg !== "object") continue;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(seg)) {
      const f = fmt(v);
      if (f !== null) out[k] = f;
    }
    if (Object.keys(out).length) meta.raw[label] = out;
  }

  return { meta, takenAt };
}

/* ---------- 视频 ---------- */

function run(cmd: string, args: string[], timeout = 30_000): Promise<{ stdout: string; ok: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      resolve({ stdout: String(stdout ?? ""), ok: !err }),
    );
  });
}

export interface VideoProbe {
  meta: MediaMeta;
  width: number | null;
  height: number | null;
  duration: number | null;
  takenAt: Date | null;
}

export async function probeVideo(file: string, mime: string, size: number): Promise<VideoProbe> {
  const empty: MediaMeta = {
    summary: { file: { format: mime, size }, camera: {}, exposure: {}, time: {}, gps: {}, authoring: {} },
    ai: null, video: null, text: {}, raw: {},
  };
  const { stdout, ok } = await run(config.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  if (!ok || !stdout) return { meta: empty, width: null, height: null, duration: null, takenAt: null };
  try {
    const j = JSON.parse(stdout) as {
      format?: { duration?: string; bit_rate?: string; format_long_name?: string; tags?: Record<string, string> };
      streams?: Array<Record<string, unknown> & { tags?: Record<string, string> }>;
    };
    const v = j.streams?.find((s) => s.codec_type === "video");
    const a = j.streams?.find((s) => s.codec_type === "audio");
    const tags = { ...(j.format?.tags ?? {}), ...(v?.tags ?? {}) };
    const lower = Object.fromEntries(Object.entries(tags).map(([k, val]) => [k.toLowerCase(), val]));
    const duration = num(j.format?.duration);
    let w = num(v?.width);
    let h = num(v?.height);
    const rot = num(lower["rotate"]) ?? num((v?.side_data_list as Array<{ rotation?: number }> | undefined)?.[0]?.rotation);
    if (rot !== null && Math.abs(Math.round(rot)) % 180 === 90 && w && h) [w, h] = [h, w];
    const fr = String(v?.avg_frame_rate ?? v?.r_frame_rate ?? "0/1").split("/");
    const fps = Number(fr[0]) / (Number(fr[1]) || 1);
    const created = lower["creation_time"] ?? lower["com.apple.quicktime.creationdate"];
    const takenAt = created && !Number.isNaN(Date.parse(created)) ? new Date(created) : null;
    const loc = lower["com.apple.quicktime.location.iso6709"] ?? lower["location"];
    const locMatch = loc ? /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(loc) : null;
    const video: Record<string, Scalar> = {
      container: j.format?.format_long_name ?? null,
      duration: duration !== null ? `${Math.round(duration * 100) / 100} s` : null,
      resolution: w && h ? `${w}x${h}` : null,
      videoCodec: v ? `${v.codec_name ?? ""}${v.profile ? ` (${v.profile})` : ""}` : null,
      frameRate: Number.isFinite(fps) && fps > 0 ? `${Math.round(fps * 100) / 100} fps` : null,
      pixelFormat: (v?.pix_fmt as string | undefined) ?? null,
      videoBitrate: num(v?.bit_rate) !== null ? `${Math.round(num(v?.bit_rate)! / 1000)} kbps` : null,
      totalBitrate: num(j.format?.bit_rate) !== null ? `${Math.round(num(j.format?.bit_rate)! / 1000)} kbps` : null,
      audioCodec: (a?.codec_name as string | undefined) ?? null,
      audioChannels: num(a?.channels),
      sampleRate: num(a?.sample_rate) !== null ? `${num(a?.sample_rate)} Hz` : null,
      createdAt: created ?? null,
      title: lower["title"] ?? null,
      encoder: lower["encoder"] ?? null,
      make: lower["com.apple.quicktime.make"] ?? lower["make"] ?? null,
      model: lower["com.apple.quicktime.model"] ?? lower["model"] ?? null,
      software: lower["com.apple.quicktime.software"] ?? null,
      latitude: locMatch ? Number(locMatch[1]) : null,
      longitude: locMatch ? Number(locMatch[2]) : null,
    };
    const meta: MediaMeta = {
      ...empty,
      summary: {
        ...empty.summary,
        file: { format: mime, size, width: w, height: h },
        camera: { make: video.make, model: video.model, software: video.software },
        time: { taken: created ?? null },
        gps: { latitude: video.latitude, longitude: video.longitude },
        authoring: { title: video.title },
      },
      video,
      raw: { "FFprobe-Tags": Object.fromEntries(Object.entries(tags).map(([k, val]) => [k, String(val).slice(0, 2000)])) },
    };
    return { meta, width: w, height: h, duration, takenAt };
  } catch {
    return { meta: empty, width: null, height: null, duration: null, takenAt: null };
  }
}

/** 用 ffmpeg 抽取一帧到 outPng(直接缩放,避免 4K 全分辨率 PNG 占内存)。失败抛错。 */
export async function grabVideoFrame(file: string, outPng: string, atSec: number): Promise<void> {
  const r = await run(
    config.ffmpeg,
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, atSec)),
      "-i", file, "-frames:v", "1", "-an", "-threads", "1",
      "-vf", `scale=${Math.min(config.previewWidth, 1600)}:-2`,
      "-y", outPng,
    ],
    60_000,
  );
  if (!r.ok) throw new Error("ffmpeg 抽帧失败(请确认已安装 ffmpeg 并配置 FFMPEG_PATH)");
}

/* ---------- 搜索文本 ---------- */

/**
 * 生成搜索文本。
 * 注意:这里**不包含管理员备注**——`GET /media?q=` 是公开接口,
 * 若把 note 拼进 search_text,游客就能用关键词逐字探测备注内容(issue §11.3)。
 * 备注搜索改由 listMedia 在登录用户查询时单独匹配 note 列。
 */
export function buildSearchText(filename: string, meta: MediaMeta | null): string {
  const parts: string[] = [filename];
  if (meta) {
    const s = meta.summary;
    parts.push(
      String(s.camera.make ?? ""), String(s.camera.model ?? ""), String(s.camera.lens ?? ""), String(s.camera.software ?? ""),
      String(s.authoring.title ?? ""), String(s.authoring.description ?? ""), String(s.authoring.artist ?? ""), String(s.authoring.keywords ?? ""),
    );
    if (meta.ai) parts.push(meta.ai.tool, meta.ai.prompt ?? "", meta.ai.model ?? "");
  }
  return parts.filter(Boolean).join("\n").slice(0, 8000).toLowerCase();
}
