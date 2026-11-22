"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { bytes, dateTime } from "@/lib/format";
import type { MediaItem } from "./Gallery";
import MetaPanel, { type Meta } from "./MetaPanel";

interface Detail extends MediaItem {
  note: string;
  error: string | null;
  meta: Meta | null;
  storage: string;
  storageKey: string | null;
  canEdit: boolean;
  canOriginal: boolean;
  breadcrumbs: Array<{ code: string; name: string }>;
  links: { file: string; thumb: string; preview: string; originalTemplate: string; html: string; markdown: string };
  streamUrl: string | null;
  takenAt: string | null;
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="muted w-16 shrink-0 text-xs">{label}</span>
      <input readOnly className="field !py-1 text-xs" value={value} onFocus={(e) => e.currentTarget.select()} />
      <button
        className="btn !px-2 !py-1 text-xs"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setOk(true);
            setTimeout(() => setOk(false), 1200);
          } catch {
            /* ignore */
          }
        }}
      >
        {ok ? "✓" : "复制"}
      </button>
    </div>
  );
}

export default function Viewer({
  items, index, setIndex, onClose, onRemoved, hasMore,
}: {
  items: MediaItem[];
  index: number;
  setIndex: (i: number) => void;
  onClose: () => void;
  onRemoved: (id: string) => void;
  hasMore: boolean;
}) {
  const cur = items[index];
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const x = await api<Detail>(`/media/${cur.id}`);
      setD(x);
      setNote(x.note);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [cur.id]);

  useEffect(() => {
    setD(null);
    setEditing(false);
    void load();
  }, [load]);

  // 处理中则轮询详情,以便尽快显示元数据
  useEffect(() => {
    if (!d || d.status !== "pending") return;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  }, [d, load]);

  const prev = useCallback(() => index > 0 && setIndex(index - 1), [index, setIndex]);
  const next = useCallback(() => index < items.length - 1 && setIndex(index + 1), [index, items.length, setIndex]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", h);
      document.body.style.overflow = "";
    };
  }, [onClose, prev, next]);

  // 预加载相邻预览图
  useEffect(() => {
    [items[index - 1], items[index + 1]].forEach((it) => {
      if (it && it.kind === "image") new Image().src = it.previewUrl;
    });
  }, [index, items]);

  async function saveNote() {
    setBusy(true);
    try {
      await api(`/media/${cur.id}`, { method: "PATCH", json: { note } });
      setEditing(false);
      await load();
      window.dispatchEvent(new Event("pgs:changed"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!d || !confirm(`确定删除「${d.filename}」吗?此操作不可恢复。`)) return;
    let purge = false;
    if (d.storage === "ext") purge = confirm("该文件位于挂载的服务器目录。\n是否同时删除服务器上的源文件?\n(取消 = 仅移除记录,下次扫描文件还会回来)");
    try {
      await api(`/media/${cur.id}?purge=${purge ? 1 : 0}`, { method: "DELETE" });
      onRemoved(cur.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const origLink = d && key ? `${d.links.file}?key=${encodeURIComponent(key)}` : "";

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "color-mix(in srgb, var(--bg) 55%, #000)" }}>
      <div className="glass-strong flex items-center gap-2 px-4 py-2">
        <button className="btn" onClick={onClose}>✕ 关闭</button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{cur.filename}</span>
        <span className="muted text-xs">{index + 1} / {items.length}{hasMore ? "+" : ""}</span>
        <button className="btn" onClick={prev} disabled={index === 0}>‹</button>
        <button className="btn" onClick={next} disabled={index >= items.length - 1}>›</button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* 左:媒体 + 链接 + 备注 */}
        <div className="min-w-0 flex-1 overflow-y-auto p-3 lg:p-5">
          <div className="flex min-h-[40vh] items-center justify-center">
            {cur.kind === "video" ? (
              d?.streamUrl ? (
                <video
                  key={d.streamUrl}
                  src={d.streamUrl}
                  poster={cur.previewUrl}
                  controls
                  controlsList="nodownload noremoteplayback"
                  disablePictureInPicture
                  playsInline
                  onContextMenu={(e) => e.preventDefault()}
                  className="max-h-[68vh] max-w-full rounded-2xl bg-black"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={cur.previewUrl} alt="" className="max-h-[68vh] max-w-full rounded-2xl opacity-60" />
              )
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={cur.id} src={`${cur.previewUrl}?s=${d?.status ?? cur.status}`} alt={cur.filename} draggable={false} className="fade-in max-h-[68vh] max-w-full rounded-2xl object-contain shadow-2xl" />
            )}
          </div>
          {err && <p className="mt-2 text-center text-sm text-red-600">{err}</p>}

          {d && (
            <div className="mx-auto mt-4 grid max-w-3xl gap-3">
              <section className="glass rounded-2xl p-4">
                <h4 className="mb-2 text-sm font-semibold">文件链接</h4>
                <div className="space-y-1.5">
                  <CopyLine label="直链" value={d.links.file} />
                  <CopyLine label={d.kind === "video" ? "HTML" : "HTML"} value={d.links.html} />
                  <CopyLine label="Markdown" value={d.links.markdown} />
                </div>
                <p className="muted mt-2 text-xs">
                  不带密钥的链接只会返回{d.kind === "video" ? "视频封面图" : "网页缩略图(预览图)"}。获取服务器原文件需在链接后追加 <code>?key=下载密钥</code>(由管理员在设置中创建):
                </p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <input className="field !py-1 text-xs sm:max-w-xs" placeholder="输入下载密钥,生成原文件链接" value={key} onChange={(e) => setKey(e.target.value)} />
                  {origLink && (
                    <>
                      <a className="btn btn-primary !py-1 text-xs" href={`${origLink}&dl=1`}>下载原文件</a>
                      <CopyLine label="" value={`${typeof window !== "undefined" ? window.location.origin : ""}${origLink}`} />
                    </>
                  )}
                  {d.canOriginal && <a className="btn !py-1 text-xs" href={`/f/${d.id}?dl=1`}>下载原文件(管理权限)</a>}
                </div>
              </section>

              <section className="glass rounded-2xl p-4">
                <div className="mb-2 flex items-center">
                  <h4 className="text-sm font-semibold">备注</h4>
                  {d.canEdit && !editing && <button className="btn ml-auto !py-0.5 text-xs" onClick={() => setEditing(true)}>✎ 编辑</button>}
                </div>
                {editing ? (
                  <div className="space-y-2">
                    <textarea className="field min-h-24" value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} placeholder="仅用于展示,不会写入原文件" />
                    <div className="flex gap-2">
                      <button className="btn btn-primary" disabled={busy} onClick={saveNote}>保存</button>
                      <button className="btn" onClick={() => { setEditing(false); setNote(d.note); }}>取消</button>
                    </div>
                  </div>
                ) : d.note ? (
                  <p className="whitespace-pre-wrap text-sm">{d.note}</p>
                ) : (
                  <p className="muted text-sm">暂无备注</p>
                )}
              </section>

              {d.canEdit && (
                <div className="flex flex-wrap gap-2">
                  <button className="btn" onClick={async () => { await api(`/media/${d.id}/reprocess`, { method: "POST" }); await load(); }}>重新生成缩略图/元数据</button>
                  <button className="btn btn-danger" onClick={remove}>🗑 删除</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 右:元数据 */}
        <aside className="glass-strong w-full shrink-0 overflow-y-auto p-4 lg:w-[400px]">
          <div className="mb-3">
            <h3 className="break-all text-base font-semibold">{cur.filename}</h3>
            <p className="muted mt-0.5 text-xs">
              {bytes(cur.size)} · {cur.width && cur.height ? `${cur.width}×${cur.height}` : "N/A"} · {dateTime(d?.takenAt ?? cur.sortAt)}
            </p>
            {d && d.breadcrumbs.length > 0 && <p className="mt-1 text-xs">📁 {d.breadcrumbs.map((b) => b.name).join(" / ")}</p>}
            {d?.storageKey && <p className="muted mt-1 break-all text-[11px]">[{d.storage}] {d.storageKey}</p>}
            {d?.status === "pending" && <p className="mt-1 text-xs" style={{ color: "var(--accent)" }}>正在生成缩略图与元数据…</p>}
            {d?.status === "failed" && <p className="mt-1 text-xs text-red-600">处理失败:{d.error}</p>}
          </div>
          {d ? <MetaPanel meta={d.meta} kind={d.kind} /> : <p className="muted text-sm">加载中…</p>}
        </aside>
      </div>
    </div>
  );
}
