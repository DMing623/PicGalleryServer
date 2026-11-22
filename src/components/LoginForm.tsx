"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "./AppProvider";

export default function LoginForm() {
  const router = useRouter();
  const { me, reload } = useApp();
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api("/auth/login", { method: "POST", json: { username, password } });
      await reload();
      router.push("/");
      router.refresh();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="glass-strong fade-in w-full max-w-sm space-y-4 rounded-3xl p-8">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={me?.site.iconUrl ?? "/api/v1/branding/icon"} alt="" className="h-11 w-11 rounded-xl" />
          <div>
            <h1 className="text-lg font-semibold">{me?.site.siteName ?? "PicGalleryServer"}</h1>
            <p className="muted text-xs">登录后可查看私有相册与管理内容</p>
          </div>
        </div>
        <input className="field" placeholder="用户名" autoComplete="username" value={username} onChange={(e) => setU(e.target.value)} autoFocus />
        <input className="field" type="password" placeholder="密码" autoComplete="current-password" value={password} onChange={(e) => setP(e.target.value)} />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button className="btn btn-primary w-full" disabled={busy || !username || !password}>{busy ? "登录中…" : "登录"}</button>
        <button type="button" className="btn w-full" onClick={() => router.push("/")}>以游客身份浏览</button>
      </form>
    </main>
  );
}
