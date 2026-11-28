"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
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

/**
 * 相册文件夹移动对话框:以文件管理器式的可展开文件树选择目标父相册(或顶层根目录)。
 * - 受管相册(managed):后端同步移动 VPS 数据目录中的源文件夹到目的文件夹并更新 storageKey;
 * - 挂载目录(mounted):仅更新相册层级链接与前端展示位置,不移动服务器上的物理目录。
 */
function MoveAlbumDialog({
  album,
  onClose,
  onMoved,
}: {
  album: AlbumDto;
  onClose: () => void;
  onMoved: () => void;
}) {
  const router = useRouter();
  const [albums, setAlbums] = useState<AlbumDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(album.parent ?? null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setMounted(true);
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, busy]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api<{ albums: AlbumDto[] }>("/albums")
      .then((r) => {
        if (!active) return;
        setAlbums(r.albums);
        // 默认展开顶层有子相册的目录以及当前所在父目录的整条祖先链,打开即可直观看到文件树
        const byCode = new Map(r.albums.map((a) => [a.code, a]));
        const hasKids = new Set<string>();
        for (const a of r.albums) {
          if (a.parent) hasKids.add(a.parent);
        }
        const init = new Set<string>();
        for (const a of r.albums) {
          if (!a.parent && hasKids.has(a.code)) init.add(a.code);
        }
        let cur = album.parent ? byCode.get(album.parent) : undefined;
        let guard = 0;
        while (cur && guard++ < 64) {
          init.add(cur.code);
          cur = cur.parent ? byCode.get(cur.parent) : undefined;
        }
        setExpanded(init);
        setErr("");
      })
      .catch((e) => {
        if (active) setErr((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [album.parent]);

  const byCode = useMemo(() => new Map(albums.map((a) => [a.code, a])), [albums]);

  const childrenMap = useMemo(() => {
    const m = new Map<string | null, AlbumDto[]>();
    for (const a of albums) {
      const p = a.parent && byCode.has(a.parent) ? a.parent : null;
      const list = m.get(p);
      if (list) list.push(a);
      else m.set(p, [a]);
    }
    return m;
  }, [albums, byCode]);

  /** 禁止选择自身及自身的全部子孙相册 */
  const forbiddenCodes = useMemo(() => {
    const out = new Set<string>([album.code]);
    const stack = [album.code];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of childrenMap.get(cur) ?? []) {
        if (!out.has(c.code)) {
          out.add(c.code);
          stack.push(c.code);
        }
      }
    }
    return out;
  }, [album.code, childrenMap]);

  /** 搜索过滤时保留命中节点及其全部祖先 */
  const visibleCodes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    const vis = new Set<string>();
    for (const a of albums) {
      if (a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q)) {
        let cur: AlbumDto | undefined = a;
        let guard = 0;
        while (cur && guard++ < 64) {
          vis.add(cur.code);
          cur = cur.parent ? byCode.get(cur.parent) : undefined;
        }
      }
    }
    return vis;
  }, [albums, byCode, filter]);

  const toggleExpand = useCallback((code: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    const all = new Set<string>();
    for (const a of albums) {
      if ((childrenMap.get(a.code)?.length ?? 0) > 0) all.add(a.code);
    }
    setExpanded(all);
  }, [albums, childrenMap]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  /** 计算所选目标的完整路径名称链 */
  const targetPathText = useMemo(() => {
    if (selected === null) return "顶层 (根目录)";
    const names: string[] = [];
    let cur = byCode.get(selected);
    let guard = 0;
    while (cur && guard++ < 64) {
      names.unshift(cur.name);
      cur = cur.parent ? byCode.get(cur.parent) : undefined;
    }
    return `顶层 / ${names.join(" / ")}`;
  }, [selected, byCode]);

  async function confirmMove() {
    if (selected === (album.parent ?? null)) {
      onClose();
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await api(`/albums/${album.code}`, { method: "PATCH", json: { parent: selected } });
      onMoved();
      window.dispatchEvent(new Event("pgs:albums"));
      window.dispatchEvent(new Event("pgs:changed"));
      router.refresh();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function renderTreeNodes(parentCode: string | null, depth: number): React.ReactNode {
    const list = childrenMap.get(parentCode) ?? [];
    return list.map((node) => {
      if (visibleCodes && !visibleCodes.has(node.code)) return null;
      const kids = childrenMap.get(node.code) ?? [];
      const hasKids = kids.length > 0;
      const isOpen = visibleCodes ? true : expanded.has(node.code);
      const isForbidden = forbiddenCodes.has(node.code);
      const isSelf = node.code === album.code;
      const isCurrentParent = node.code === (album.parent ?? null);
      const isSelected = selected === node.code;

      return (
        <div key={node.code}>
          <div
            className={`flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-sm transition ${
              isForbidden
                ? "cursor-not-allowed opacity-45"
                : isSelected
                  ? "font-medium"
                  : "cursor-pointer hover:bg-black/5"
            }`}
            style={{
              paddingLeft: `${depth * 18 + 8}px`,
              background: isSelected ? "color-mix(in srgb, var(--accent) 18%, transparent)" : undefined,
              color: isSelected ? "var(--accent)" : undefined,
            }}
            onClick={() => {
              if (isForbidden) return;
              setSelected(node.code);
              if (hasKids && !expanded.has(node.code)) toggleExpand(node.code);
            }}
          >
            {hasKids ? (
              <button
                type="button"
                className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-black/10"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(node.code);
                }}
                aria-label={isOpen ? "折叠子文件夹" : "展开子文件夹"}
              >
                {isOpen ? "▾" : "▸"}
              </button>
            ) : (
              <span className="inline-block h-5 w-5 shrink-0" />
            )}
            <span className="shrink-0 text-base">{isOpen && hasKids ? "📂" : "📁"}</span>
            <span className="min-w-0 flex-1 break-all text-left">{node.name}</span>
            {node.kind === "mounted" && <span className="chip shrink-0">目录</span>}
            {isSelf && <span className="chip shrink-0">当前相册</span>}
            {!isSelf && isForbidden && <span className="chip shrink-0">子相册</span>}
            {isCurrentParent && <span className="chip shrink-0">当前所在</span>}
            {hasKids && <span className="muted shrink-0 text-xs">{kids.length}</span>}
          </div>
          {hasKids && isOpen && renderTreeNodes(node.code, depth + 1)}
        </div>
      );
    });
  }

  const panel = (
    <div
      className="fixed inset-0 z-[130]"
      style={{
        paddingTop: "calc(env(safe-area-inset-top, 0px) + 1mm + 36px + 8px)",
        paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 14px + 40px + 8px)",
        paddingLeft: "0.5rem",
        paddingRight: "0.5rem",
      }}
    >
      <div
        className="absolute inset-0 transition-opacity duration-200"
        style={{
          background: "color-mix(in srgb, var(--fg) 28%, transparent)",
          backdropFilter: "blur(14px) saturate(1.2)",
          WebkitBackdropFilter: "blur(14px) saturate(1.2)",
          opacity: mounted ? 1 : 0,
        }}
        onClick={() => !busy && onClose()}
      />
      <div
        className="glass-strong relative mx-auto flex h-full w-full max-w-xl flex-col overflow-hidden rounded-3xl shadow-2xl transition-all duration-200"
        style={{ opacity: mounted ? 1 : 0, transform: mounted ? "none" : "translateY(10px) scale(0.985)" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="移动相册文件夹"
      >
        <div className="shrink-0 px-5 pt-4">
          <div className="mb-1 flex items-center gap-2">
            <h2 className="min-w-0 flex-1 break-all text-base font-semibold">移动「{album.name}」</h2>
            <button className="btn shrink-0 !py-1 text-xs" onClick={onClose} disabled={busy} aria-label="关闭">
              ✕
            </button>
          </div>
          <p className="muted mb-2 text-xs leading-relaxed">
            {album.kind === "mounted"
              ? "当前为挂载服务器目录：移动仅改变项目内的相册层级链接与显示位置，不会实际移动服务器上的源文件夹。"
              : album.storage === "s3"
                ? "当前为受管相册(S3)：确认后将更新相册在项目中的所属文件夹层级。"
                : "当前为受管相册(本地)：确认后将同时移动 VPS 数据目录中的源文件夹到目的文件夹，并自动同步文件路径。"}
          </p>
          <div className="mb-2 flex items-center gap-1.5">
            <input
              className="field !py-1 text-xs"
              placeholder="筛选相册文件夹名称…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button type="button" className="btn shrink-0 !px-2.5 !py-1 text-xs" onClick={expandAll}>
              展开全部
            </button>
            <button type="button" className="btn shrink-0 !px-2.5 !py-1 text-xs" onClick={collapseAll}>
              折叠全部
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-1" style={{ WebkitOverflowScrolling: "touch" }}>
          <div className="glass rounded-2xl p-2">
            {/* 顶层根目录选项 */}
            <div
              className={`flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-sm transition ${
                selected === null ? "font-medium" : "hover:bg-black/5"
              }`}
              style={{
                background: selected === null ? "color-mix(in srgb, var(--accent) 18%, transparent)" : undefined,
                color: selected === null ? "var(--accent)" : undefined,
              }}
              onClick={() => setSelected(null)}
            >
              <span className="shrink-0 text-base">🏠</span>
              <span className="min-w-0 flex-1 text-left">顶层 (根目录)</span>
              {album.parent === null && <span className="chip shrink-0">当前所在</span>}
            </div>

            <div className="my-1 border-t border-line/40" />

            {loading ? (
              <p className="muted py-6 text-center text-xs">正在加载文件夹树…</p>
            ) : (childrenMap.get(null)?.length ?? 0) > 0 ? (
              <div className="space-y-0.5">{renderTreeNodes(null, 0)}</div>
            ) : (
              <p className="muted py-4 text-center text-xs">暂无其他相册文件夹</p>
            )}
          </div>
          {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        </div>

        <div className="shrink-0 border-t border-line/60 px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="muted min-w-0 flex-1 break-all text-xs">目标位置：{targetPathText}</span>
            <button className="btn shrink-0" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              className="btn btn-primary shrink-0"
              disabled={busy || loading || selected === (album.parent ?? null)}
              onClick={confirmMove}
            >
              {busy ? "移动中…" : selected === (album.parent ?? null) ? "已在当前位置" : "确认移动"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? panel : createPortal(panel, document.body);
}

/** 相册操作按钮组(按权限显示)。变更后触发 onChanged 并广播 pgs:albums。 */
export default function AlbumActions({ album, onChanged, onDeleted }: { album: AlbumDto; onChanged: () => void; onDeleted?: () => void }) {
  const { can, me } = useApp();
  const dlg = useDialog();
  const [busy, setBusy] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
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
    <>
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
          onClick={() => setMoveOpen(true)}
        >
          📁 移动
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
        {/* 移除挂载相册仅管理员可用(后端同样 403),manager 不展示以免点击必报错 */}
        {(album.kind !== "mounted" || mount) && (
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
        )}
      </div>
      {moveOpen && <MoveAlbumDialog album={album} onClose={() => setMoveOpen(false)} onMoved={onChanged} />}
    </>
  );
}
