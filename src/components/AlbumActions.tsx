"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "./AppProvider";
import { useDialog } from "./DialogProvider";

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
  readonly?: boolean;
  coverId: string | null;
  counts: { media: number; mediaTotal: number; images: number; videos: number; size: number; sizeTotal: number; pending: number; failed: number; children: number };
  lastScanAt: string | null;
}

/** 相册操作按钮组(按权限显示)。变更后触发 onChanged 并广播 pgs:albums。 */
export default function AlbumActions({ album, onChanged, onDeleted }: { album: AlbumDto; onChanged: () => void; onDeleted?: () => void }) {
  const { can, me } = useApp();
  const dlg = useDialog();
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
      await dlg.alert((e as Error).message, "操作失败");
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
        onClick={async () => {
          const name = await dlg.prompt({ title: "新建子相册", label: "子相册名称", confirmText: "创建", validate: (v: string) => (v ? (v.length > 80 ? "名称过长(最多 80 字)" : null) : "请输入名称") });
          if (name) void run(() => api("/albums", { method: "POST", json: { name, parent: album.code, visibility: album.visibility, storage: canStorageS3 ? undefined : "local" } }));
        }}
      >
        ＋ 子相册
      </button>
      <button
        className="btn !py-1 text-xs"
        disabled={busy}
        onClick={async () => {
          const name = await dlg.prompt({ title: "重命名相册", label: "新名称", defaultValue: album.name, confirmText: "保存", validate: (v: string) => (v ? (v.length > 80 ? "名称过长(最多 80 字)" : null) : "请输入名称") });
          if (name && name !== album.name) void run(() => api(`/albums/${album.code}`, { method: "PATCH", json: { name } }));
        }}
      >
        ✎ 重命名
      </button>
      <button
        className="btn !py-1 text-xs"
        disabled={busy}
        onClick={async () => {
          const next = album.visibility === "public" ? "private" : "public";
          let cascade = false;
          if (album.counts.children > 0) {
            const pick = await dlg.choose({
              title: `设为${next === "public" ? "公开(游客可见)" : "私有"}`,
              message: `将「${album.name}」设为${next === "public" ? "公开" : "私有"}。是否同时应用到全部子相册?`,
              options: [{ value: "all", label: "应用到全部子相册", kind: "primary" }, { value: "self", label: "仅此相册" }],
            });
            if (!pick) return;
            cascade = pick === "all";
          } else if (next === "public" && !(await dlg.confirm({ title: "设为公开", message: `「${album.name}」将对所有游客可见,确认公开吗?`, confirmText: "公开" }))) return;
          void run(() => api(`/albums/${album.code}`, { method: "PATCH", json: { visibility: next, cascade } }));
        }}
      >
        {album.visibility === "public" ? "🌐 公开 → 设为私有" : "🔒 私有 → 设为公开"}
      </button>
      {mount && album.kind === "mounted" && (
        <button
          className="btn !py-1 text-xs"
          disabled={busy}
          onClick={async () => {
            const next = !album.readonly;
            if (
              !next &&
              !(await dlg.confirm({
                title: "允许写入该挂载目录",
                message: `关闭只读后,本系统可以向「${album.name}」所在的服务器目录写入、移动和删除文件。确认允许吗?`,
                confirmText: "允许写入",
                danger: true,
              }))
            )
              return;
            void run(() => api(`/albums/${album.code}`, { method: "PATCH", json: { readonly: next } }));
          }}
        >
          {album.readonly ? "🔒 只读 → 允许写入" : "🔓 可写 → 设为只读"}
        </button>
      )}
      {mount && album.kind === "mounted" && (
        <button
          className="btn !py-1 text-xs"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const r = await api<{ added: number; missing: number; albumsCreated: number; albumsRemoved: number; albumsMoved: number; truncated: number }>(
                `/albums/${album.code}/scan?wait=1`,
                { method: "POST" },
              );
              const parts = [
                `新增 ${r.added}`,
                r.albumsCreated ? `新建子相册 ${r.albumsCreated}` : "",
                r.albumsMoved ? `改名沿用 ${r.albumsMoved}` : "",
                r.albumsRemoved ? `移除失效相册 ${r.albumsRemoved}` : "",
                r.missing ? `缺失 ${r.missing}` : "",
              ].filter(Boolean);
              // 深层目录被截断时必须提示,否则用户会以为文件"丢了"
              const warn = r.truncated ? `\n\n注意:有 ${r.truncated} 个子目录超过最大扫描深度(SCAN_MAX_DEPTH),其中的文件未被索引。` : "";
              await dlg.alert(`扫描完成:${parts.join(" · ")}${warn}`, "重新扫描");
            })
          }
        >
          ⟳ 重新扫描
        </button>
      )}
      <button
        className="btn btn-danger !py-1 text-xs"
        disabled={busy}
        onClick={async () => {
          if (album.kind === "mounted") {
            if (!(await dlg.confirm({ title: "移除挂载相册", message: `移除挂载相册「${album.name}」?只会删除登记信息,服务器上的原文件不会被删除。`, confirmText: "移除", danger: true }))) return;
            void run(() => api(`/albums/${album.code}`, { method: "DELETE" }), onDeleted ?? onChanged);
          } else {
            const pick = await dlg.choose({
              title: `删除相册「${album.name}」`,
              message: `相册内有 ${album.counts.media} 个文件,请选择处理方式:`,
              options: [
                { value: "delete", label: `同时删除相册内的 ${album.counts.media} 个文件`, kind: "danger" },
                { value: "move", label: "仅删除相册,文件移到上级相册(或未归类)" },
              ],
            });
            if (!pick) return;
            void run(() => api(`/albums/${album.code}?media=${pick}`, { method: "DELETE" }), onDeleted ?? onChanged);
          }
        }}
      >
        🗑 删除
      </button>
    </div>
  );
}
