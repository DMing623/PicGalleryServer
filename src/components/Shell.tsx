"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import AlbumsView from "./AlbumsView";
import { getSavedScrollY, navigateApp, replaceAppUrl, useApp, useAppLocation } from "./AppProvider";
import Gallery from "./Gallery";
import NoticeBell from "./NoticeBell";
import { useInstall } from "./Pwa";
import SettingsView from "./settings/SettingsView";
import UploadDialog from "./UploadDialog";

const IS_DEV = process.env.NODE_ENV !== "production";

/**
 * 独立搜索表单:将输入框受控状态隔离在表单内部,
 * 避免每次按键输入时连带重渲染整页 Shell(NoticeBell、main、底部 dock)。
 */
const SearchForm = memo(function SearchForm({
  scope,
  kind,
  order,
  urlQuery,
}: {
  scope: string | null;
  kind: string;
  order: "asc" | "desc";
  urlQuery: string;
}) {
  const [text, setText] = useState(urlQuery);

  useEffect(() => {
    setText(urlQuery);
  }, [urlQuery]);

  function search(e: React.FormEvent) {
    e.preventDefault();
    const base = scope ? `/albums/${encodeURIComponent(scope)}` : "/";
    const p = new URLSearchParams();
    if (text.trim()) p.set("q", text.trim());
    if (kind) p.set("kind", kind);
    if (order === "asc") p.set("order", "asc");
    const s = p.toString();
    navigateApp(s ? `${base}?${s}` : base);
  }

  return (
    <form noValidate onSubmit={search} className="flex min-w-0 flex-1 items-center gap-1.5">
      <input
        className="field compact-field min-w-0 flex-1"
        type="text"
        enterKeyHint="search"
        placeholder={scope ? "本相册内搜索…" : "搜索 文件名/备注/相机/提示词"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <span className="chip hidden shrink-0 sm:inline-flex">{scope ? "当前相册" : "全局"}</span>
      <button type="submit" className="dbtn shrink-0" aria-label="搜索">
        🔍
      </button>
    </form>
  );
});

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * 应用外壳:
 *  - 顶部:仅一条搜索栏(相册页内自动限定为当前相册)
 *  - 底部:紧凑的毛玻璃工具栏(导航 / 筛选 / 上传 / 账户),开发模式下紧靠左下角 Next 悬浮球
 *  - 主体:图库 / 相册 / 设置三大主视图常驻保活(Keep-Alive),点击底栏零网络等待、同帧切换
 */
export default function Shell({ children }: { children: ReactNode }) {
  const { me, loading: appLoading, can, reload } = useApp();
  const { pathname, search } = useAppLocation();
  const router = useRouter();
  const install = useInstall();
  const sp = useMemo(() => new URLSearchParams(search), [search]);

  const albumMatch = /^\/albums\/([^/]+)/.exec(pathname);
  const scope = albumMatch ? decodeURIComponent(albumMatch[1]) : null;
  const isHome = pathname === "/";
  const isAlbumsRoot = pathname === "/albums";
  const isSettings = pathname.startsWith("/settings");
  const isGallery = isHome || !!scope;

  const [upload, setUpload] = useState(false);
  /** 按下瞬间(pointerdown)即切换按钮高亮,消除等待松手/路由提交的视觉延迟 */
  const [pressingHref, setPressingHref] = useState<string | null>(null);
  /** 已挂载的主标签页:SSR 与首屏水合仅挂载当前页,水合完成后空闲预热其余标签页并常驻保活 */
  const [mounted, setMounted] = useState<{ home: boolean; albums: boolean; settings: boolean }>({
    home: false,
    albums: false,
    settings: false,
  });

  const canSettings = can("settings") || can("album.manage");

  useEffect(() => {
    setMounted((prev) => {
      const next = {
        home: prev.home || isHome,
        albums: prev.albums || isAlbumsRoot,
        settings: prev.settings || isSettings,
      };
      return next.home === prev.home && next.albums === prev.albums && next.settings === prev.settings ? prev : next;
    });
  }, [isHome, isAlbumsRoot, isSettings]);

  // 首屏就绪后在浏览器空闲帧后台预挂载其余底栏标签页,首次点击即可同帧秒开
  useEffect(() => {
    if (appLoading) return;
    const t = setTimeout(() => {
      setMounted((prev) => {
        const next = {
          home: true,
          albums: true,
          settings: prev.settings || canSettings,
        };
        return next.home === prev.home && next.albums === prev.albums && next.settings === prev.settings ? prev : next;
      });
    }, 150);
    return () => clearTimeout(t);
  }, [appLoading, canSettings]);

  // 切换主视图时在浏览器绘制前同步恢复目标页的滚动位置
  useIsoLayoutEffect(() => {
    window.scrollTo(0, getSavedScrollY(pathname));
  }, [pathname]);

  const urlQuery = sp.get("q") ?? "";
  const kind = sp.get("kind") ?? "";
  const order: "asc" | "desc" = sp.get("order") === "asc" ? "asc" : "desc";

  function setParam(k: string, v: string) {
    const p = new URLSearchParams(search);
    if (v) p.set(k, v);
    else p.delete(k);
    const s = p.toString();
    replaceAppUrl(s ? `${pathname}?${s}` : pathname);
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    await reload();
    navigateApp("/");
    router.refresh();
  }

  function onNavClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    setPressingHref(null);
    if (pathname === href) {
      if (href === "/" && (urlQuery || kind || order !== "desc")) {
        navigateApp("/");
      } else if (window.scrollY > 0) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      return;
    }
    navigateApp(href);
  }

  const nav = [
    { href: "/", label: "图库", icon: "🖼" },
    { href: "/albums", label: "相册", icon: "📁" },
    ...(canSettings ? [{ href: "/settings", label: "设置", icon: "⚙" }] : []),
  ];
  const visualPath = pressingHref ?? pathname;
  const kinds = [["", "全部"], ["image", "图片"], ["video", "视频"]];
  const nextKind = kinds[(kinds.findIndex((k) => k[0] === kind) + 1) % kinds.length];

  const showHome = isHome || mounted.home;
  const showAlbums = isAlbumsRoot || mounted.albums;
  const showSettings = isSettings || mounted.settings;

  return (
    <div className="min-h-screen">
      <div className="topbar glass">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={me?.site.iconUrl ?? "/api/v1/branding/icon"} alt="" className="h-6 w-6 shrink-0 rounded-md" />
        <NoticeBell />
        <SearchForm scope={scope} kind={kind} order={order} urlQuery={urlQuery} />
      </div>

      <main className="pb-[calc(env(safe-area-inset-bottom,0px)+72px)] pt-[calc(env(safe-area-inset-top,0px)+1mm+36px+1mm)]" style={{ paddingInline: 0 }}>
        {showHome && (
          <div hidden={!isHome}>
            <Gallery active={isHome} />
          </div>
        )}
        {showAlbums && (
          <div hidden={!isAlbumsRoot}>
            <AlbumsView active={isAlbumsRoot} />
          </div>
        )}
        {scope && (
          <div>
            <AlbumsView key={scope} code={scope} active />
          </div>
        )}
        {showSettings && (
          <div hidden={!isSettings}>
            <SettingsView active={isSettings} />
          </div>
        )}
        {children}
      </main>

      <nav className={`dock glass ${IS_DEV ? "dev" : ""}`} aria-label="底部工具栏">
        {nav.map((n) => {
          const active = n.href === "/" ? visualPath === "/" : visualPath.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              prefetch
              onPointerDown={(e) => {
                if (e.button === 0) setPressingHref(n.href);
              }}
              onPointerUp={() => setPressingHref(null)}
              onPointerCancel={() => setPressingHref(null)}
              onPointerLeave={() => setPressingHref(null)}
              onClick={(e) => onNavClick(e, n.href)}
              className={`dbtn ${active ? "on" : ""} ${pressingHref === n.href ? "pressing" : ""}`}
            >
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
          <Link href="/login" prefetch className="dbtn">登录</Link>
        )}
      </nav>

      {upload && <UploadDialog defaultAlbum={scope} onClose={() => setUpload(false)} />}
    </div>
  );
}
