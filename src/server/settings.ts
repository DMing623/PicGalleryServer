import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { DEFAULT_THEME, PRESETS, isHex, type ThemeSetting } from "@/lib/theme";
import { E } from "./http";

/** 站点设置:存于 pgs_settings 的单个 JSON(key = "site"),内存缓存。 */

export interface SplashSetting {
  enabled: boolean;
  /** builtin = 内置粒子+3D 文字; url = 使用 https 链接(图片/视频/网页) */
  mode: "builtin" | "url";
  url: string;
  durationMs: number;
  title: string;
}

export interface SiteSettings {
  siteName: string;
  theme: ThemeSetting;
  splash: SplashSetting;
  /** 自定义图标版本号(0 = 使用内置图标),用于缓存失效 */
  iconVersion: number;
  iconMime: string;
  /** 是否允许游客浏览管理员开放的相册 */
  guestBrowse: boolean;
}

export const DEFAULT_SITE: SiteSettings = {
  siteName: "PicGalleryServer",
  theme: DEFAULT_THEME,
  splash: { enabled: true, mode: "builtin", url: "", durationMs: 2800, title: "PicGalleryServer" },
  iconVersion: 0,
  iconMime: "",
  guestBrowse: true,
};

let cache: { value: SiteSettings; at: number } | null = null;

function merge(raw: Partial<SiteSettings> | null | undefined): SiteSettings {
  const r = raw ?? {};
  return {
    ...DEFAULT_SITE,
    ...r,
    theme: { ...DEFAULT_THEME, ...(r.theme ?? {}) },
    splash: { ...DEFAULT_SITE.splash, ...(r.splash ?? {}) },
  };
}

export async function getSite(): Promise<SiteSettings> {
  if (cache && Date.now() - cache.at < 5000) return cache.value;
  const [row] = await db.select().from(settings).where(eq(settings.key, "site")).limit(1);
  const value = merge(row?.value as Partial<SiteSettings> | undefined);
  cache = { value, at: Date.now() };
  return value;
}

async function save(value: SiteSettings) {
  await db
    .insert(settings)
    .values({ key: "site", value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  cache = { value, at: Date.now() };
}

/** 校验并合并补丁,返回新设置 */
export async function patchSite(patch: Record<string, unknown>): Promise<SiteSettings> {
  const cur = await getSite();
  const next: SiteSettings = merge(cur);

  if (patch.siteName !== undefined) {
    if (typeof patch.siteName !== "string" || !patch.siteName.trim() || patch.siteName.length > 60) throw E.badRequest("siteName 无效");
    next.siteName = patch.siteName.trim();
  }
  if (patch.guestBrowse !== undefined) next.guestBrowse = !!patch.guestBrowse;

  const t = patch.theme as Partial<ThemeSetting> | undefined;
  if (t && typeof t === "object") {
    if (t.preset !== undefined) {
      if (!PRESETS[t.preset]) throw E.badRequest(`未知主题预设: ${t.preset}`);
      next.theme.preset = t.preset;
    }
    if (t.mode !== undefined) {
      if (!["light", "dark", "auto"].includes(t.mode)) throw E.badRequest("theme.mode 无效");
      next.theme.mode = t.mode;
    }
    for (const k of ["accent", "background"] as const) {
      const v = t[k];
      if (v !== undefined) {
        if (v !== "" && !isHex(v)) throw E.badRequest(`theme.${k} 必须是 #RRGGBB`);
        next.theme[k] = v;
      }
    }
  }

  const s = patch.splash as Partial<SplashSetting> | undefined;
  if (s && typeof s === "object") {
    if (s.enabled !== undefined) next.splash.enabled = !!s.enabled;
    if (s.mode !== undefined) {
      if (s.mode !== "builtin" && s.mode !== "url") throw E.badRequest("splash.mode 无效");
      next.splash.mode = s.mode;
    }
    if (s.url !== undefined) {
      const u = String(s.url).trim();
      if (u && !/^https:\/\/[^\s]+$/i.test(u)) throw E.badRequest("启动页链接必须是 https:// 开头的地址");
      next.splash.url = u;
    }
    if (s.durationMs !== undefined) {
      const n = Number(s.durationMs);
      if (!Number.isFinite(n) || n < 800 || n > 20000) throw E.badRequest("splash.durationMs 应在 800~20000");
      next.splash.durationMs = Math.round(n);
    }
    if (s.title !== undefined) next.splash.title = String(s.title).slice(0, 40) || "PicGalleryServer";
  }
  if (next.splash.mode === "url" && !next.splash.url) throw E.badRequest("splash.mode=url 时必须提供 url");

  await save(next);
  return next;
}

export async function setIcon(version: number, mime: string): Promise<SiteSettings> {
  const next = { ...(await getSite()), iconVersion: version, iconMime: mime };
  await save(next);
  return next;
}

/** 面向前端/游客的公开配置 */
export function publicSite(s: SiteSettings) {
  return {
    siteName: s.siteName,
    theme: s.theme,
    splash: s.splash,
    iconUrl: `/api/v1/branding/icon?v=${s.iconVersion}`,
    guestBrowse: s.guestBrowse,
  };
}
