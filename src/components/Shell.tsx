"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useApp } from "./AppProvider";
import UploadDialog from "./UploadDialog";

/** 应用外壳:毛玻璃顶栏、导航、搜索(相册页内自动限定为当前相册)、上传与账户菜单。 */
export default function Shell({ children }: { children: ReactNode }) {
  const { me, can, reload } = useApp();
  const pathname = usePathname();
  const router = useRouter();
  const sp = useSearchParams();
  const albumMatch = /^\/albums\/([^/]+)/.exec(pathname);
  const scope = albumMatch ? decodeURIComponent(albumMatch[1]) : null;
  const [text, setText] = useState(sp.get("q") ?? "");
  const [upload, setUpload] = useState(false);

  useEffect(() => setText(sp.get("q") ?? ""), [sp]);

  function search(e: React.FormEvent) {
    e.preventDefault();
    const base = scope ? `/albums/${scope}` : "/";
    router.push(text.trim() ? `${base}?q=${encodeURIComponent(text.trim())}` : base);
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    await reload();
    router.push("/");
    router.refresh();
  }

  const nav = [
    { href: "/", label: "全部" },
    { href: "/albums", label: "相册" },
    ...(can("settings") || can("album.manage") ? [{ href: "/settings", label: "设置" }] : []),
  ];

  return (
    <div className="min-h-screen">
      <header className="glass sticky top-0 z-40 mx-2 mt-2 flex flex-wrap items-center gap-3 rounded-2xl px-4 py-2.5 sm:mx-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={me?.site.iconUrl ?? "/api/v1/branding/icon"} alt="" className="h-8 w-8 rounded-lg" />
          <span className="hidden sm:inline">{me?.site.siteName ?? "PicGalleryServer"}</span>
        </Link>
        <nav className="flex gap-1">
          {nav.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} className="rounded-lg px-3 py-1.5 text-sm transition" style={active ? { background: "var(--accent)", color: "var(--accent-fg)" } : undefined}>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <form onSubmit={search} className="relative order-last min-w-[220px] flex-1 sm:order-none sm:max-w-md">
          <input
            className="field pr-24"
            placeholder={scope ? "在当前相册内搜索…" : "全局搜索 文件名 / 备注 / 相机 / 提示词…"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <span className="chip pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">{scope ? "当前相册" : "全局"}</span>
        </form>
        <div className="ml-auto flex items-center gap-2">
          {can("upload") && (
            <button className="btn btn-primary" onClick={() => setUpload(true)}>
              ⬆ 上传
            </button>
          )}
          {me?.user ? (
            <>
              <span className="hidden text-sm sm:inline">
                {me.user.username} <span className="chip">{me.user.role}</span>
              </span>
              <button className="btn" onClick={logout}>退出</button>
            </>
          ) : (
            <Link href="/login" className="btn">登录</Link>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-[1800px] px-2 py-4 sm:px-4">{children}</main>
      {upload && <UploadDialog defaultAlbum={scope} onClose={() => setUpload(false)} />}
    </div>
  );
}
