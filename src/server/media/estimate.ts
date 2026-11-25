// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 媒体处理内存估算(纯函数,无项目内依赖,可单测)。
 *
 * 估算 = 固定开销 + 每百万像素开销 × 像素量(MB);随「格式布局」变化约 1~25 倍:
 *   stream    基线 JPEG / 非隔行 PNG / TIFF / 16-bit PNG … 流式解码
 *   buffered  渐进 JPEG / 隔行 PNG … 需要整图缓冲(同像素量约为流式的 1.5~2.5 倍)
 *   cmyk      CMYK 色彩空间转换(最重,约为流式的 7~25 倍)
 *
 * 系数来源与置信度(每格必须标注):
 *   measured-synthetic  scripts/bench 在合成素材上实测(置信度 medium;真实素材复测后可升为 high)
 *   calculated          按数据流推算(置信度 low)
 *   guess               没有数据(置信度 low)
 * low 置信度的估算自动 ×1.5(宁可保守);/status 暴露 lowConfidenceCount 提示该补测哪一格。
 * **这些系数是起点,不是定稿**:用真实素材(尤其 HEIC)重跑 scripts/bench 后更新本表。
 */

export type EstStage = "derive" | "hd-miss" | "hd-wm" | "heic" | "bmp" | "video";
export type Confidence = "high" | "medium" | "low";
export type Layout = "stream" | "buffered" | "cmyk";

export interface ProbeMeta {
  format?: string;
  width?: number;
  height?: number;
  progressive?: boolean;
  /** 位深,sharp 的 depth 字段:uchar / ushort / ... */
  depth?: string;
  space?: string;
  channels?: number;
  sizeBytes?: number;
  mime?: string;
}

export interface MediaMemoryEstimate {
  estMB: number;
  confidence: Confidence;
  layout: Layout | "video" | "heic" | "bmp" | "unknown";
  megapixels: number;
  /** 系数来源 */
  source: "measured-synthetic" | "calculated" | "guess";
  /** 人类可读的依据,用于日志 / [LIMIT] 错误信息 / 调试 */
  reason: string;
}

interface Coef {
  fixed: number;
  perMp: number;
  source: MediaMemoryEstimate["source"];
  confidence: Confidence;
}

/** 系数表:stage → layout */
export const COEFS: Record<"derive" | "hd-miss", Record<Layout, Coef>> = {
  derive: {
    stream: { fixed: 15, perMp: 2.2, source: "measured-synthetic", confidence: "medium" },
    buffered: { fixed: 19, perMp: 3.8, source: "measured-synthetic", confidence: "medium" },
    cmyk: { fixed: 15, perMp: 15, source: "measured-synthetic", confidence: "medium" },
  },
  "hd-miss": {
    stream: { fixed: 30, perMp: 1.3, source: "measured-synthetic", confidence: "medium" },
    buffered: { fixed: 37, perMp: 3.2, source: "measured-synthetic", confidence: "medium" },
    cmyk: { fixed: 30, perMp: 30, source: "measured-synthetic", confidence: "medium" },
  },
};
/** HD 水印合成阶段(基图 + 水印层 + 合成 + 编码):以 2560×1707 约 54MB 的观测为参照,按 12 B/px 外推 */
export const WM_COEF: Coef = { fixed: 8, perMp: 12, source: "calculated", confidence: "medium" };
/** HEIC:heic-convert(wasm)整图 RGBA + JPEG 编码 + sharp 再解码;无实测 */
export const HEIC_COEF: Coef = { fixed: 40, perMp: 14, source: "guess", confidence: "low" };
/** BMP:整文件 Buffer + RGBA + PNG Buffer + sharp 解码 ≈ 10 B/px(推算) */
export const BMP_COEF: Coef = { fixed: 20, perMp: 10, source: "calculated", confidence: "low" };
/** 视频:ffmpeg 子进程抽帧(不走 libvips),按固定经验值 */
export const VIDEO_COEF: Coef = { fixed: 100, perMp: 0, source: "guess", confidence: "low" };

/** 16-bit 等高位深在流式基础上的保守放大(逐像素部分) */
const DEEP_BIT_FACTOR = 1.4;
/** 低置信度的保守系数 */
export const LOW_CONFIDENCE_FACTOR = 1.5;

/** 仅知道文件大小时,按格式的典型压缩率反推像素量(MP);只用于没有本地副本的远程文件,置信度 low */
export function megapixelsFromSize(sizeBytes: number, mime: string | undefined, filename = ""): number {
  const m = (mime ?? "").toLowerCase();
  const n = filename.toLowerCase();
  // 每像素字节数(典型值)
  let bpp = 1;
  if (/jpe?g/.test(m) || /\.jpe?g$/.test(n)) bpp = 0.4;
  else if (/png/.test(m) || /\.png$/.test(n)) bpp = 2.5;
  else if (/tiff?/.test(m) || /\.tiff?$/.test(n) || /bmp/.test(m) || /\.bmp$/.test(n)) bpp = 3;
  else if (/webp|avif/.test(m)) bpp = 0.5;
  else if (/heic|heif/.test(m) || /\.(heic|heif|hif)$/.test(n)) bpp = 0.2;
  return Math.max(0.1, sizeBytes / bpp / 1e6);
}

const round = (n: number) => Math.max(1, Math.ceil(n));

function pack(c: Coef, mp: number, layout: MediaMemoryEstimate["layout"], reason: string, deep = false): MediaMemoryEstimate {
  const variable = c.perMp * mp * (deep ? DEEP_BIT_FACTOR : 1);
  let est = c.fixed + variable;
  if (c.confidence === "low") est *= LOW_CONFIDENCE_FACTOR;
  return { estMB: round(est), confidence: c.confidence, layout, megapixels: Math.round(mp * 10) / 10, source: c.source, reason };
}

export function layoutOf(m: ProbeMeta): Layout {
  const space = (m.space ?? "").toLowerCase();
  if (space === "cmyk" || (m.channels === 4 && space === "cmyk")) return "cmyk";
  if (m.progressive) return "buffered";
  return "stream";
}

export function estimateMemory(meta: ProbeMeta, stage: EstStage, opts: { filename?: string } = {}): MediaMemoryEstimate {
  const known = !!(meta.width && meta.height);
  const mp = known ? (meta.width! * meta.height!) / 1e6 : megapixelsFromSize(meta.sizeBytes ?? 0, meta.mime, opts.filename);
  const dims = known ? `${meta.width}×${meta.height}` : `约 ${mp.toFixed(1)}MP(按文件大小反推)`;

  if (stage === "video") return pack(VIDEO_COEF, 0, "video", "视频按 ffmpeg 子进程固定经验值估算");
  if (stage === "hd-wm") return pack(WM_COEF, mp, "stream", `水印合成 ${dims}`);
  if (stage === "heic") return pack(HEIC_COEF, mp, "heic", `HEIC ${dims}(无实测,保守估算)`);
  if (stage === "bmp") return pack(BMP_COEF, mp, "bmp", `BMP ${dims}`);

  const layout = layoutOf(meta);
  const coef = { ...COEFS[stage][layout] };
  let reason = `${meta.format ?? "image"} ${dims} ${layout === "buffered" ? "渐进/隔行(整图缓冲)" : layout === "cmyk" ? "CMYK(色彩空间转换)" : "流式解码"}`;
  const deep = !!meta.depth && /^(ushort|short|uint|int|float|double)/.test(meta.depth);
  // 没有尺寸只靠文件大小反推 → 一律按低置信度处理
  if (!known) {
    coef.confidence = "low";
    coef.source = "guess";
  } else if (meta.format && !/^(jpeg|jpg|png|tiff?|webp|gif|heif|avif|svg)$/.test(meta.format)) {
    coef.confidence = "low";
    coef.source = "guess";
  } else if (/^(webp|gif|avif|heif)$/.test(meta.format ?? "")) {
    // 未实测的格式:沿用流式系数,但置信度降为 low(自动 ×1.5)
    coef.confidence = "low";
    coef.source = "guess";
  }
  if (deep) reason += `、${meta.depth} 高位深`;
  return pack(coef, mp, layout, reason, deep);
}

/** 硬限制拒绝时的说明(写入 media.error,前缀 [LIMIT] 固定,corrupt.ts 据此绝不自动清理) */
export function limitMessage(est: MediaMemoryEstimate, hardMaxMB: number): string {
  return `[LIMIT] 超出内存上限:${est.reason},估算需要约 ${est.estMB}MB,超过上限 ${hardMaxMB}MB(可调大 MEDIA_MAX_EST_MB 或容器内存后点击「重新处理」)`;
}

export function pixelLimitMessage(width: number, height: number, maxMp: number): string {
  return `[LIMIT] 图片 ${width}×${height}(${((width * height) / 1e6).toFixed(0)}MP)超过输入像素上限 ${maxMp}MP(可调大 MEDIA_MAX_INPUT_MP 后点击「重新处理」)`;
}

/** error 前缀:非损坏类失败,绝不进入「疑似损坏文件」自动物理删除流程 */
export const NON_CORRUPT_ERROR_PREFIXES = ["[LIMIT]", "[INTERRUPTED]"] as const;
