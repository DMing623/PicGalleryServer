"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { usePathname, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";

export interface SiteInfo {
  siteName: string;
  theme: { preset: string; mode: "light" | "dark" | "auto"; accent: string; background: string };
  splash: { enabled: boolean; mode: "builtin" | "url"; url: string; durationMs: number; title: string; subtitle?: string };
  iconUrl: string;
  guestBrowse: boolean;
  /** 站点时区(IANA),通知时间按它换算 */
  timezone: string;
}

export interface Me {
  user: { id: string; username: string; role: string } | null;
  perms: string[];
  site: SiteInfo;
  features: { s3: boolean; thumbConcurrency: number };
  /** 未读通知数(铃铛红点) */
  unread: number;
}

interface Ctx {
  me: Me | null;
  loading: boolean;
  can: (perm: string) => boolean;
  reload: () => Promise<void>;
}

const AppCtx = createContext<Ctx>({ me: null, loading: true, can: () => false, reload: async () => undefined });

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setMe(await api<Me>("/auth/me"));
    } catch {
      // 服务重启 / 网络抖动时不要让 Promise 未捕获(会刷屏 unhandledRejection)
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo<Ctx>(() => ({ me, loading, reload, can: (p) => !!me?.perms.includes(p) }), [me, loading, reload]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export const useApp = () => useContext(AppCtx);

/* ============ 零延迟客户端路由与滚动记忆(供 Shell / Gallery / AlbumsView 共用) ============ */

export interface AppLocation {
  pathname: string;
  search: string;
}

let clientLoc: AppLocation | null = null;
const locListeners = new Set<() => void>();
const scrollMemory = new Map<string, number>();

function notifyLoc() {
  for (const fn of locListeners) fn();
}

export function getSavedScrollY(pathname: string): number {
  return scrollMemory.get(pathname) ?? 0;
}

/**
 * 同步切换应用内路由:
 * 直接在离散点击事件(SyncLane)中更新客户端路径并写入 History,
 * 避免 Next.js force-dynamic 布局下每次切换都发起服务端 _rsc 请求与 startTransition 挂起。
 */
export function navigateApp(href: string) {
  if (typeof window === "undefined") return;
  const u = new URL(href, window.location.origin);
  const nextSearch = u.search.replace(/^\?/, "");
  const curPath = clientLoc?.pathname ?? window.location.pathname;
  const curSearch = clientLoc?.search ?? window.location.search.replace(/^\?/, "");
  if (u.pathname === curPath && nextSearch === curSearch) return;
  scrollMemory.set(curPath, window.scrollY);
  clientLoc = { pathname: u.pathname, search: nextSearch };
  notifyLoc();
  window.history.pushState(null, "", u.pathname + u.search + u.hash);
}

/**
 * 同步替换当前 URL 查询参数(如切换全部/图片/视频、排序方向):
 * 零网络往返,按钮文案与列表筛选在同一帧立即响应。
 */
export function replaceAppUrl(href: string) {
  if (typeof window === "undefined") return;
  const u = new URL(href, window.location.origin);
  const nextSearch = u.search.replace(/^\?/, "");
  const curPath = clientLoc?.pathname ?? window.location.pathname;
  const curSearch = clientLoc?.search ?? window.location.search.replace(/^\?/, "");
  if (u.pathname === curPath && nextSearch === curSearch) return;
  clientLoc = { pathname: u.pathname, search: nextSearch };
  notifyLoc();
  window.history.replaceState(null, "", u.pathname + u.search + u.hash);
}

export function useAppLocation(): AppLocation {
  const nextPathname = usePathname();
  const nextSp = useSearchParams();
  const nextSearch = nextSp.toString();
  const [loc, setLoc] = useState<AppLocation | null>(null);

  useEffect(() => {
    const winPath = window.location.pathname || nextPathname;
    const winSearch = window.location.search.replace(/^\?/, "");
    const cur = { pathname: winPath, search: winSearch };
    clientLoc = cur;
    setLoc((prev) => (prev && prev.pathname === cur.pathname && prev.search === cur.search ? prev : cur));
  }, [nextPathname, nextSearch]);

  useEffect(() => {
    const onChange = () => {
      if (clientLoc) {
        const snap = { pathname: clientLoc.pathname, search: clientLoc.search };
        setLoc((prev) => (prev && prev.pathname === snap.pathname && prev.search === snap.search ? prev : snap));
      }
    };
    const onPopState = () => {
      clientLoc = {
        pathname: window.location.pathname || "/",
        search: window.location.search.replace(/^\?/, ""),
      };
      notifyLoc();
    };
    locListeners.add(onChange);
    window.addEventListener("popstate", onPopState);
    return () => {
      locListeners.delete(onChange);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  return loc ?? { pathname: nextPathname, search: nextSearch };
}
