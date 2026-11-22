// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppProvider } from "@/components/AppProvider";
import DevI18n from "@/components/DevI18n";
import { DialogProvider } from "@/components/DialogProvider";
import Disclaimer, { DISCLAIMER_BOOT_SCRIPT } from "@/components/Disclaimer";
import { PwaRegister } from "@/components/Pwa";
import Splash from "@/components/Splash";
import { themeCss } from "@/lib/theme";
import { DEFAULT_SITE, getSite } from "@/server/settings";
import { ensureReady } from "@/server/ready";
import "./globals.css";

export const dynamic = "force-dynamic";

async function site() {
  try {
    await ensureReady();
    return await getSite();
  } catch {
    return DEFAULT_SITE;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const s = await site();
  const icon = `/api/v1/branding/icon?v=${s.iconVersion}`;
  return {
    title: s.siteName,
    description: "自托管图片与视频相册服务",
    applicationName: s.siteName,
    manifest: "/manifest.webmanifest",
    icons: { icon, shortcut: icon, apple: `/pwa-icon/180.png?v=${s.iconVersion}` },
    appleWebApp: { capable: true, title: s.siteName, statusBarStyle: "black-translucent" },
    formatDetection: { telephone: false },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const s = await site();
  return { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: s.theme.accent || "#d97757" };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const s = await site();
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <style id="pgs-theme" dangerouslySetInnerHTML={{ __html: themeCss(s.theme) }} />
        {/* 已同意过免责声明的访客:首屏前就标记,避免弹窗闪现 */}
        <script dangerouslySetInnerHTML={{ __html: DISCLAIMER_BOOT_SCRIPT }} />
      </head>
      <body>
        <AppProvider>
          <DialogProvider>
            <Splash conf={s.splash} />
            {children}
            <Disclaimer />
            <PwaRegister />
            <DevI18n />
          </DialogProvider>
        </AppProvider>
      </body>
    </html>
  );
}
