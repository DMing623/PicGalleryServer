"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useApp } from "./AppProvider";
import { useInstall } from "./Pwa";
import UploadDialog from "./UploadDialog";

const IS_DEV = process.env.NODE_ENV !== "production";

/**
 * 应用外壳:
 *  - 顶部:仅一条搜索栏(相册页内自动限定为当前相册)
 *  - 底部:紧凑的毛玻璃工具栏(导航 / 筛选 / 上传 / 账户),开发模式下紧靠左下角 Next 悬浮球
 *  - 主体:整屏瀑布流
 */
export default function Shell({ children }: { children: ReactNode }) {
  const { me, can, reload } = useApp();
  const pathname = usePathname();
  const router = useRouter();
  const sp = useSearchParams();
  const install = useInstall();
  const albumMatch = /^\/albums\/([^/]+)/.exec(pathname);
  const scope = albumMatch ? decodeURIComponent(albumMatch[1]) : null;
  const isGallery = pathname === "/" || !!albumMatch;
  const [text, setText] = useState(sp.get("q") ?? "");
  const [upload, setUpload] = useState(false);
  const kind = sp.get("kind") ?? "";
  const order = sp.get("order") === "asc" ? "asc" : "desc";

  useEffect(() => setText(sp.get("q") ?? ""), [sp]);

  function search(e: React.FormEvent) {
    e.preventDefault();
    const base = scope ? `/albums/${scope}` : "/";
    const p = new URLSearchParams();
    if (text.trim()) p.set("q", text.trim());
    if (kind) p.set("kind", kind);
    if (order === "asc") p.set("order", "asc");
    const s = p.toString();
    router.push(s ? `${base}?${s}` : base);
  }

  function setParam(k: string, v: string) {
    const p = new URLSearchParams(sp.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    const s = p.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    await reload();
    router.push("/");
    router.refresh();
  }

  const nav = [
    { href: "/", label: "图库", icon: "🖼" },
    { href: "/albums", label: "相册", icon: "📁" },
    ...(can("settings") || can("album.manage") ? [{ href: "/settings", label: "设置", icon: "⚙" }] : []),
  ];
  const kinds = [["", "全部"], ["image", "图片"], ["video", "视频"]];
  const nextKind = kinds[(kinds.findIndex((k) => k[0] === kind) + 1) % kinds.length];

  return (
    <div className="min-h-screen">
      <form noValidate onSubmit={search} className="topbar glass">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={me?.site.iconUrl ?? "/api/v1/branding/icon"} alt="" className="h-6 w-6 shrink-0 rounded-md" />
        <input
          className="field compact-field min-w-0 flex-1"
          type="text"
          enterKeyHint="search"
          placeholder={scope ? "在当前相册内搜索…" : "搜索 文件名 / 备注 / 相机 / 提示词…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="chip hidden shrink-0 sm:inline-flex">{scope ? "当前相册" : "全局"}</span>
        <button type="submit" className="dbtn shrink-0" aria-label="搜索">🔍</button>
      </form>

      <main className="pb-[calc(env(safe-area-inset-bottom,0px)+72px)] pt-[calc(env(safe-area-inset-top,0px)+1mm+36px+1mm)]" style={{ paddingInline: 0 }}>
        {children}
      </main>

      <nav className={`dock glass ${IS_DEV ? "dev" : ""}`} aria-label="底部工具栏">
        {nav.map((n) => {
          const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href} className={`dbtn ${active ? "on" : ""}`}>
              <span aria-hidden>{n.icon}</span>
              <span>{n.label}</span>
            </Link>
          );
        })}
        {isGallery && (
          <>
            <span className="dsep" />
            <button className="dbtn" onClick={() => setParam("kind", nextKind[0])} title="切换:全部 / 图片 / 视频">
              {kinds.find((k) => k[0] === kind)?.[1]}
            </button>
            <button className="dbtn" onClick={() => setParam("order", order === "desc" ? "asc" : "")} title="排序">
              {order === "desc" ? "↓新" : "↑旧"}
            </button>
          </>
        )}
        <span className="flex-1" />
        {can("upload") && (
          <button className="dbtn on" onClick={() => setUpload(true)} aria-label="上传">⬆ 上传</button>
        )}
        {install.can && <button className="dbtn" onClick={() => void install.install()}>⤓ 安装</button>}
        {me?.user ? (
          <>
            <span className="muted hidden px-1 text-[11px] md:inline">{me.user.username}</span>
            <button className="dbtn" onClick={logout}>退出</button>
          </>
        ) : (
          <Link href="/login" className="dbtn">登录</Link>
        )}
      </nav>

      {upload && <UploadDialog defaultAlbum={scope} onClose={() => setUpload(false)} />}
    </div>
  );
}
