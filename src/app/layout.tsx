// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppProvider } from "@/components/AppProvider";
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
    icons: { icon, shortcut: icon, apple: icon },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const s = await site();
  return (
    <html lang="zh-CN">
      <head>
        <style id="pgs-theme" dangerouslySetInnerHTML={{ __html: themeCss(s.theme) }} />
      </head>
      <body>
        <AppProvider>
          <Splash conf={s.splash} />
          {children}
        </AppProvider>
      </body>
    </html>
  );
}
