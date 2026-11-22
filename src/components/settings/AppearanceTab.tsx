"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { PRESETS, themeCss, type ThemeSetting } from "@/lib/theme";
import { useApp } from "../AppProvider";

interface Site {
  siteName: string;
  theme: ThemeSetting;
  splash: { enabled: boolean; mode: "builtin" | "url"; url: string; durationMs: number; title: string };
  guestBrowse: boolean;
}

function applyTheme(t: ThemeSetting) {
  const el = document.getElementById("pgs-theme");
  if (el) el.textContent = themeCss(t);
}

export default function AppearanceTab() {
  const { me, reload } = useApp();
  const [s, setS] = useState<Site | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const saved = useRef<ThemeSetting | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [iconKey, setIconKey] = useState(0);

  useEffect(() => {
    api<Site>("/settings").then((r) => {
      setS(r);
      saved.current = r.theme;
    });
    // 离开页面时恢复到已保存的主题(未保存的预览不保留)
    return () => {
      if (saved.current) applyTheme(saved.current);
    };
  }, []);

  if (!s) return <p className="muted text-sm">加载中…</p>;

  const setTheme = (patch: Partial<ThemeSetting>) => {
    const theme = { ...s.theme, ...patch };
    setS({ ...s, theme });
    applyTheme(theme);
  };

  async function save() {
    if (!s) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await api<Site>("/settings", { method: "PUT", json: { siteName: s.siteName, theme: s.theme, splash: s.splash, guestBrowse: s.guestBrowse } });
      saved.current = r.theme;
      await reload();
      setMsg("✓ 已保存");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadIcon(f: File) {
    const fd = new FormData();
    fd.append("icon", f);
    try {
      const res = await fetch("/api/v1/settings/icon", { method: "POST", body: fd });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error?.message);
      await reload();
      setIconKey((k) => k + 1);
      setMsg("✓ 图标已更新(浏览器标签页图标可能需要刷新)");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <section className="glass rounded-2xl p-5">
        <h2 className="mb-3 font-semibold">站点</h2>
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <label className="text-sm">
            <span className="muted mb-1 block text-xs">站点名称</span>
            <input className="field" value={s.siteName} maxLength={60} onChange={(e) => setS({ ...s, siteName: e.target.value })} />
          </label>
          <div className="flex items-end gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img key={iconKey} src={`${me?.site.iconUrl ?? "/api/v1/branding/icon"}&r=${iconKey}`} alt="图标" className="h-12 w-12 rounded-xl border border-line" />
            <button className="btn" onClick={() => file.current?.click()}>上传自定义图标</button>
            <button className="btn" onClick={async () => { await api("/settings/icon", { method: "DELETE" }); await reload(); setIconKey((k) => k + 1); }}>恢复默认</button>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={(e) => e.target.files?.[0] && uploadIcon(e.target.files[0])} />
          </div>
        </div>
        <p className="muted mt-2 text-xs">图标用于顶栏 Logo 与浏览器标签页(favicon);支持 PNG / JPG / WebP / SVG,最大 2MB。</p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.guestBrowse} onChange={(e) => setS({ ...s, guestBrowse: e.target.checked })} />
          允许游客浏览「公开」相册(关闭后游客必须登录)
        </label>
      </section>

      <section className="glass rounded-2xl p-5">
        <h2 className="mb-3 font-semibold">主题配色</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Object.entries(PRESETS).map(([id, p]) => (
            <button
              key={id}
              onClick={() => setTheme({ preset: id, accent: "", background: "" })}
              className="tile overflow-hidden rounded-xl border text-left"
              style={{ borderColor: s.theme.preset === id ? "var(--accent)" : "var(--border)", outline: s.theme.preset === id ? "2px solid var(--accent)" : "none" }}
            >
              <div className="flex h-12">
                <div className="flex-1" style={{ background: p.light.bg }} />
                <div className="flex-1" style={{ background: p.light.accent }} />
                <div className="flex-1" style={{ background: p.dark.bg }} />
                <div className="flex-1" style={{ background: p.dark.accent }} />
              </div>
              <div className="px-2 py-1.5 text-xs">{p.label}{id === "claude" && " (默认)"}</div>
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5">
            明暗:
            {([["auto", "跟随系统"], ["light", "浅色"], ["dark", "深色"]] as const).map(([v, l]) => (
              <button key={v} className="btn !py-1" style={s.theme.mode === v ? { background: "var(--accent)", color: "var(--accent-fg)" } : undefined} onClick={() => setTheme({ mode: v })}>
                {l}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2">
            自定义主色
            <input type="color" value={s.theme.accent || PRESETS[s.theme.preset]?.light.accent || "#d97757"} onChange={(e) => setTheme({ accent: e.target.value })} />
            {s.theme.accent && <button className="btn !py-0.5 text-xs" onClick={() => setTheme({ accent: "" })}>清除</button>}
          </label>
          <label className="flex items-center gap-2">
            自定义背景
            <input type="color" value={s.theme.background || PRESETS[s.theme.preset]?.light.bg || "#f0eee6"} onChange={(e) => setTheme({ background: e.target.value })} />
            {s.theme.background && <button className="btn !py-0.5 text-xs" onClick={() => setTheme({ background: "" })}>清除</button>}
          </label>
        </div>
        <p className="muted mt-2 text-xs">修改会立即预览,点击底部「保存」后对所有访问者生效。</p>
      </section>

      <section className="glass rounded-2xl p-5">
        <h2 className="mb-3 font-semibold">启动页</h2>
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.splash.enabled} onChange={(e) => setS({ ...s, splash: { ...s.splash, enabled: e.target.checked } })} /> 启用启动页(每个浏览器标签页会话只显示一次)
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="muted mb-1 block text-xs">样式</span>
            <select className="field" value={s.splash.mode} onChange={(e) => setS({ ...s, splash: { ...s.splash, mode: e.target.value as "builtin" | "url" } })}>
              <option value="builtin">内置:粒子 + 3D 旋转光环 + 3D 文字</option>
              <option value="url">自定义 https 链接(图片 / 视频 / 网页)</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="muted mb-1 block text-xs">显示时长(毫秒)</span>
            <input className="field" type="number" min={800} max={20000} step={200} value={s.splash.durationMs} onChange={(e) => setS({ ...s, splash: { ...s.splash, durationMs: Number(e.target.value) } })} />
          </label>
          {s.splash.mode === "builtin" ? (
            <label className="text-sm sm:col-span-2">
              <span className="muted mb-1 block text-xs">3D 标题文字</span>
              <input className="field" maxLength={40} value={s.splash.title} onChange={(e) => setS({ ...s, splash: { ...s.splash, title: e.target.value } })} />
            </label>
          ) : (
            <label className="text-sm sm:col-span-2">
              <span className="muted mb-1 block text-xs">启动页链接(必须 https://;.png/.jpg/.gif/.webp 作图片,.mp4/.webm 作视频,其它按网页嵌入)</span>
              <input className="field" placeholder="https://example.com/splash.mp4" value={s.splash.url} onChange={(e) => setS({ ...s, splash: { ...s.splash, url: e.target.value } })} />
            </label>
          )}
        </div>
        <button className="btn mt-3" onClick={() => { try { sessionStorage.removeItem("pgs-splash"); } catch {} location.reload(); }}>
          ▶ 保存后点此重新预览
        </button>
      </section>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary" onClick={save} disabled={busy}>保存设置</button>
        {msg && <span className="text-sm">{msg}</span>}
      </div>
    </div>
  );
}
