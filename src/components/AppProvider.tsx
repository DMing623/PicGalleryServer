"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";

export interface SiteInfo {
  siteName: string;
  theme: { preset: string; mode: "light" | "dark" | "auto"; accent: string; background: string };
  splash: { enabled: boolean; mode: "builtin" | "url"; url: string; durationMs: number; title: string };
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
