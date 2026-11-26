"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApp } from "../AppProvider";
import { AlbumManager, BlocklistTab, KeysTab, UsersTab } from "./AdminTabs";
import AppearanceTab from "./AppearanceTab";
import NoticeTab from "./NoticeTab";
import SystemTab from "./SystemTab";

export default function SettingsView({ active: pageActive = true }: { active?: boolean }) {
  const { me, loading, can } = useApp();
  const tabs = [
    { id: "appearance", label: "外观与启动页", ok: can("settings") },
    { id: "albums", label: "相册管理", ok: can("album.manage") },
    { id: "notices", label: "通知发布", ok: can("notice.publish") },
    { id: "blocklist", label: "删除黑名单", ok: can("media.delete") },
    { id: "keys", label: "原文件下载密钥", ok: can("keys") },
    { id: "users", label: "用户与权限", ok: can("users") },
    { id: "system", label: "系统状态", ok: can("status") },
  ].filter((t) => t.ok);
  const [tab, setTab] = useState<string>("");
  const active = tab || tabs[0]?.id || "";
  const [visited, setVisited] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (active) {
      setVisited((prev) => (prev[active] ? prev : { ...prev, [active]: true }));
    }
  }, [active]);

  if (loading) return <p className="muted py-10 text-center text-sm">加载中…</p>;
  if (!me?.user || !tabs.length) {
    return (
      <div className="glass mx-auto mt-10 max-w-md rounded-3xl p-10 text-center">
        <p className="font-medium">需要管理员权限</p>
        <Link href="/login" prefetch className="btn btn-primary mt-4">去登录</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto min-w-0 max-w-5xl px-3">
      <h1 className="mb-2 text-lg font-semibold">设置</h1>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            className="btn !py-1 text-xs"
            style={active === t.id ? { background: "var(--accent)", color: "var(--accent-fg)", borderColor: "transparent" } : undefined}
            onPointerDown={(e) => {
              if (e.button === 0 && active !== t.id) {
                setVisited((prev) => (prev[t.id] ? prev : { ...prev, [t.id]: true }));
                setTab(t.id);
              }
            }}
            onClick={() => {
              setVisited((prev) => (prev[t.id] ? prev : { ...prev, [t.id]: true }));
              setTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-w-0">
        {(active === "appearance" || visited.appearance) && (
          <div hidden={active !== "appearance"} className="min-w-0">
            <AppearanceTab active={pageActive && active === "appearance"} />
          </div>
        )}
        {(active === "albums" || visited.albums) && (
          <div hidden={active !== "albums"} className="min-w-0">
            <AlbumManager active={pageActive && active === "albums"} />
          </div>
        )}
        {(active === "notices" || visited.notices) && (
          <div hidden={active !== "notices"} className="min-w-0">
            <NoticeTab />
          </div>
        )}
        {(active === "blocklist" || visited.blocklist) && (
          <div hidden={active !== "blocklist"} className="min-w-0">
            <BlocklistTab active={pageActive && active === "blocklist"} />
          </div>
        )}
        {(active === "keys" || visited.keys) && (
          <div hidden={active !== "keys"} className="min-w-0">
            <KeysTab />
          </div>
        )}
        {(active === "users" || visited.users) && (
          <div hidden={active !== "users"} className="min-w-0">
            <UsersTab />
          </div>
        )}
        {(active === "system" || visited.system) && (
          <div hidden={active !== "system"} className="min-w-0">
            <SystemTab active={pageActive && active === "system"} />
          </div>
        )}
      </div>
    </div>
  );
}
