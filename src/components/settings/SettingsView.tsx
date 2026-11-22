"use client";

import Link from "next/link";
import { useState } from "react";
import { useApp } from "../AppProvider";
import { AlbumManager, KeysTab, UsersTab } from "./AdminTabs";
import AppearanceTab from "./AppearanceTab";
import SystemTab from "./SystemTab";

export default function SettingsView() {
  const { me, loading, can } = useApp();
  const tabs = [
    { id: "appearance", label: "外观与启动页", ok: can("settings") },
    { id: "albums", label: "相册管理", ok: can("album.manage") },
    { id: "keys", label: "原文件下载密钥", ok: can("keys") },
    { id: "users", label: "用户与权限", ok: can("users") },
    { id: "system", label: "系统状态", ok: can("status") },
  ].filter((t) => t.ok);
  const [tab, setTab] = useState<string>("");
  const active = tab || tabs[0]?.id;

  if (loading) return <p className="muted py-10 text-center text-sm">加载中…</p>;
  if (!me?.user || !tabs.length) {
    return (
      <div className="glass mx-auto mt-10 max-w-md rounded-3xl p-10 text-center">
        <p className="font-medium">需要管理员权限</p>
        <Link href="/login" className="btn btn-primary mt-4">去登录</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-3 text-xl font-semibold">设置</h1>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button key={t.id} className="btn" style={active === t.id ? { background: "var(--accent)", color: "var(--accent-fg)" } : undefined} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="fade-in" key={active}>
        {active === "appearance" && <AppearanceTab />}
        {active === "albums" && <AlbumManager />}
        {active === "keys" && <KeysTab />}
        {active === "users" && <UsersTab />}
        {active === "system" && <SystemTab />}
      </div>
    </div>
  );
}
