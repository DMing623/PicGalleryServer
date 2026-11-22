"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "./AppProvider";

export interface AlbumDto {
  code: string;
  name: string;
  description: string;
  parent: string | null;
  kind: "managed" | "mounted";
  storage: string;
  rootPath: string | null;
  visibility: "public" | "private";
  effectivePublic: boolean;
  coverId: string | null;
  counts: { media: number; mediaTotal: number; images: number; videos: number; size: number; sizeTotal: number; pending: number; failed: number; children: number };
  lastScanAt: string | null;
}

/** 相册操作按钮组(按权限显示)。变更后触发 onChanged 并广播 pgs:albums。 */
export default function AlbumActions({ album, onChanged, onDeleted }: { album: AlbumDto; onChanged: () => void; onDeleted?: () => void }) {
  const { can, me } = useApp();
  const [busy, setBusy] = useState(false);
  const manage = can("album.manage");
  const mount = can("album.mount");

  async function run(fn: () => Promise<unknown>, done?: () => void) {
    setBusy(true);
    try {
      await fn();
      (done ?? onChanged)();
      window.dispatchEvent(new Event("pgs:albums"));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!manage) return null;
  const canStorageS3 = me?.features.s3;

  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        className="btn !py-1 text-xs"
        disabled={busy}
        onClick={() => {
          const name = prompt("子相册名称");
          if (name) void run(() => api("/albums", { method: "POST", json: { name, parent: album.code, visibility: album.visibility, storage: canStorageS3 ? undefined : "local" } }));
        }}
      >
        ＋ 子相册
      </button>
      <button
        className="btn !py-1 text-xs"
        disabled={busy}
        onClick={() => {
          const name = prompt("新名称", album.name);
          if (name && name !== album.name) void run(() => api(`/albums/${album.code}`, { method: "PATCH", json: { name } }));
        }}
      >
        ✎ 重命名
      </button>
      <button
        className="btn !py-1 text-xs"
        disabled={busy}
        onClick={() => {
          const next = album.visibility === "public" ? "private" : "public";
          const cascade = album.counts.children > 0 && confirm(`将「${album.name}」设为${next === "public" ? "公开(游客可见)" : "私有"}。\n是否同时应用到全部子相册?`);
          void run(() => api(`/albums/${album.code}`, { method: "PATCH", json: { visibility: next, cascade } }));
        }}
      >
        {album.visibility === "public" ? "🌐 公开 → 设为私有" : "🔒 私有 → 设为公开"}
      </button>
      {mount && album.kind === "mounted" && (
        <button className="btn !py-1 text-xs" disabled={busy} onClick={() => void run(() => api(`/albums/${album.code}/scan?wait=1`, { method: "POST" }))}>
          ⟳ 重新扫描
        </button>
      )}
      <button
        className="btn btn-danger !py-1 text-xs"
        disabled={busy}
        onClick={() => {
          if (album.kind === "mounted") {
            if (!confirm(`移除挂载相册「${album.name}」?\n只会删除登记信息,服务器上的原文件不会被删除。`)) return;
            void run(() => api(`/albums/${album.code}`, { method: "DELETE" }), onDeleted ?? onChanged);
          } else {
            const del = confirm(`删除相册「${album.name}」?\n\n确定 = 同时删除相册内的 ${album.counts.media} 个文件\n取消 = 继续,可选择把文件移到上级`);
            if (!del && !confirm("仅删除相册本身,文件移动到上级相册(或未归类)。继续?")) return;
            void run(() => api(`/albums/${album.code}?media=${del ? "delete" : "move"}`, { method: "DELETE" }), onDeleted ?? onChanged);
          }
        }}
      >
        🗑 删除
      </button>
    </div>
  );
}
