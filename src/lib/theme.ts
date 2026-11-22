// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/** 主题预设与 CSS 变量生成。服务端(layout)与客户端(设置页实时预览)共用。 */

export interface Palette {
  bg: string;
  bg2: string;
  surface: string;
  fg: string;
  muted: string;
  accent: string;
  accentFg: string;
  border: string;
}

export interface ThemeSetting {
  preset: string;
  mode: "light" | "dark" | "auto";
  /** 自定义主色(覆盖预设),空串表示不覆盖 */
  accent: string;
  /** 自定义背景色(覆盖预设),空串表示不覆盖 */
  background: string;
}

export const PRESETS: Record<string, { label: string; light: Palette; dark: Palette }> = {
  claude: {
    label: "Claude 经典",
    light: { bg: "#F0EEE6", bg2: "#E6DFCF", surface: "#FAF9F5", fg: "#3D3929", muted: "#83827D", accent: "#D97757", accentFg: "#FFFFFF", border: "#D9D4C5" },
    dark: { bg: "#262624", bg2: "#1D1C1A", surface: "#30302E", fg: "#FAF9F5", muted: "#A8A69B", accent: "#D97757", accentFg: "#FFFFFF", border: "#4A4945" },
  },
  ocean: {
    label: "海洋蓝",
    light: { bg: "#E8F1F8", bg2: "#CFE2F2", surface: "#F8FBFE", fg: "#1D3045", muted: "#6B8197", accent: "#2F7DD1", accentFg: "#FFFFFF", border: "#C5D7E8" },
    dark: { bg: "#0F1B2A", bg2: "#0A121C", surface: "#192A3F", fg: "#E8F1F8", muted: "#8DA4BA", accent: "#5AA9F0", accentFg: "#07131F", border: "#294463" },
  },
  forest: {
    label: "森林绿",
    light: { bg: "#EAF0E6", bg2: "#D3E2CB", surface: "#F8FBF6", fg: "#22331F", muted: "#73856E", accent: "#4C8B5A", accentFg: "#FFFFFF", border: "#CBDAC4" },
    dark: { bg: "#141F18", bg2: "#0E1611", surface: "#1E2E24", fg: "#E7F2E9", muted: "#8EA894", accent: "#6CC083", accentFg: "#08140C", border: "#2E4637" },
  },
  rose: {
    label: "玫瑰粉",
    light: { bg: "#F8ECEF", bg2: "#F0D3DB", surface: "#FEF8F9", fg: "#44212B", muted: "#9A7782", accent: "#D45C7E", accentFg: "#FFFFFF", border: "#EBCDD5" },
    dark: { bg: "#26151B", bg2: "#1A0D12", surface: "#35202A", fg: "#FBEAEE", muted: "#BB95A1", accent: "#F07C9C", accentFg: "#2A0C16", border: "#523140" },
  },
  violet: {
    label: "暮光紫",
    light: { bg: "#EEEAF8", bg2: "#DAD2F1", surface: "#FAF8FF", fg: "#2B2345", muted: "#7E75A0", accent: "#7A5AF0", accentFg: "#FFFFFF", border: "#D3CBEA" },
    dark: { bg: "#17142A", bg2: "#100E1D", surface: "#241F3E", fg: "#EEEAFB", muted: "#A39BC8", accent: "#9C84FF", accentFg: "#150F33", border: "#3B3366" },
  },
  mono: {
    label: "极简灰",
    light: { bg: "#EEEEEE", bg2: "#DADADA", surface: "#FAFAFA", fg: "#1C1C1C", muted: "#777777", accent: "#2B2B2B", accentFg: "#FFFFFF", border: "#D2D2D2" },
    dark: { bg: "#111111", bg2: "#0A0A0A", surface: "#1C1C1C", fg: "#EEEEEE", muted: "#999999", accent: "#EEEEEE", accentFg: "#111111", border: "#333333" },
  },
};

export const DEFAULT_THEME: ThemeSetting = { preset: "claude", mode: "auto", accent: "", background: "" };

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

function palette(t: ThemeSetting, dark: boolean): Palette {
  const p = PRESETS[t.preset] ?? PRESETS.claude;
  const base = { ...(dark ? p.dark : p.light) };
  if (isHex(t.accent)) base.accent = t.accent;
  if (isHex(t.background)) {
    base.bg = t.background;
    base.bg2 = t.background;
  }
  return base;
}

function vars(p: Palette): string {
  return `--bg:${p.bg};--bg2:${p.bg2};--surface:${p.surface};--fg:${p.fg};--muted:${p.muted};--accent:${p.accent};--accent-fg:${p.accentFg};--border:${p.border};`;
}

/** 生成注入 <style id="pgs-theme"> 的 CSS 文本 */
export function themeCss(t: ThemeSetting): string {
  const light = vars(palette(t, false));
  const dark = vars(palette(t, true));
  if (t.mode === "light") return `:root{${light}color-scheme:light;}`;
  if (t.mode === "dark") return `:root{${dark}color-scheme:dark;}`;
  return `:root{${light}color-scheme:light;}@media (prefers-color-scheme:dark){:root{${dark}color-scheme:dark;}}`;
}
