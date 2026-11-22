"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, qs } from "@/lib/api";
import { dayLabel, duration } from "@/lib/format";
import { useApp } from "./AppProvider";
import Viewer from "./Viewer";

export interface MediaItem {
  id: string;
  kind: "image" | "video";
  filename: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  sortAt: string;
  status: string;
  color: string | null;
  hasNote: boolean;
  album: string | null;
  size: number;
  thumbUrl: string;
  previewUrl: string;
}

interface Page {
  items: MediaItem[];
  nextCursor: string | null;
}

interface Tile {
  it: MediaItem;
  idx: number;
  w: number;
  h: number;
}

/** 等高行(justified)布局 */
function justify(list: Array<{ it: MediaItem; idx: number }>, width: number, target: number, gap: number): Tile[][] {
  const rows: Tile[][] = [];
  let row: Array<{ it: MediaItem; idx: number; ar: number }> = [];
  let sum = 0;
  const flush = (h: number) => {
    rows.push(row.map((r) => ({ it: r.it, idx: r.idx, w: r.ar * h, h })));
    row = [];
    sum = 0;
  };
  for (const e of list) {
    const raw = e.it.width && e.it.height ? e.it.width / e.it.height : 4 / 3;
    const ar = Math.min(3, Math.max(0.4, raw));
    row.push({ ...e, ar });
    sum += ar;
    const h = (width - gap * (row.length - 1)) / sum;
    if (h <= target) flush(h);
  }
  if (row.length) flush(Math.min(target, (width - gap * (row.length - 1)) / sum));
  return rows;
}

export default function Gallery({ album }: { album?: string }) {
  const sp = useSearchParams();
  const q = sp.get("q") ?? "";
  const { loading: appLoading, me } = useApp();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("");
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const [open, setOpen] = useState<number | null>(null);
  const [width, setWidth] = useState(1000);
  const [version, setVersion] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const busy = useRef(false);

  const params = useMemo(() => ({ album, q, kind, order, limit: 80 }), [album, q, kind, order]);

  const fetchPage = useCallback(
    async (reset: boolean) => {
      if (busy.current && !reset) return;
      const id = ++reqId.current;
      busy.current = true;
      setLoading(true);
      try {
        const page = await api<Page>(`/media${qs({ ...params, cursor: reset ? undefined : cursorRef.current })}`);
        if (id !== reqId.current) return;
        setError("");
        setItems((prev) => (reset ? page.items : [...prev, ...page.items]));
        cursorRef.current = page.nextCursor;
        setCursor(page.nextCursor);
      } catch (e) {
        if (id === reqId.current) setError((e as Error).message);
      } finally {
        if (id === reqId.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [params],
  );

  useEffect(() => {
    if (appLoading) return;
    cursorRef.current = null;
    busy.current = false;
    setItems([]);
    setCursor(null);
    void fetchPage(true);
  }, [fetchPage, version, appLoading, me?.user?.id]);

  // 上传完成/外部变更后刷新
  useEffect(() => {
    const h = () => setVersion((v) => v + 1);
    window.addEventListener("pgs:changed", h);
    return () => window.removeEventListener("pgs:changed", h);
  }, []);

  // 无限滚动
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && cursorRef.current && void fetchPage(false), { rootMargin: "900px" });
    io.observe(el);
    return () => io.disconnect();
  }, [fetchPage, items.length]);

  // 容器宽度
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // 有处理中的文件时轮询前几十项的状态
  const pending = items.some((i) => i.status === "pending");
  useEffect(() => {
    if (!pending) return;
    let n = 0;
    const t = setInterval(async () => {
      if (++n > 40) return clearInterval(t);
      try {
        const page = await api<Page>(`/media${qs({ ...params, limit: 80 })}`);
        const map = new Map(page.items.map((i) => [i.id, i]));
        setItems((prev) => prev.map((i) => map.get(i.id) ?? i));
      } catch {
        /* 忽略 */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [pending, params]);

  const groups = useMemo(() => {
    const g: Array<{ day: string; list: Array<{ it: MediaItem; idx: number }> }> = [];
    items.forEach((it, idx) => {
      const day = new Date(it.sortAt).toDateString();
      const last = g[g.length - 1];
      if (last && last.day === day) last.list.push({ it, idx });
      else g.push({ day, list: [{ it, idx }] });
    });
    return g;
  }, [items]);

  const target = width < 520 ? 130 : width < 900 ? 170 : 220;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {[["", "全部"], ["image", "图片"], ["video", "视频"]].map(([v, l]) => (
          <button key={v} className="btn" style={kind === v ? { background: "var(--accent)", color: "var(--accent-fg)" } : undefined} onClick={() => setKind(v)}>
            {l}
          </button>
        ))}
        <button className="btn" onClick={() => setOrder(order === "desc" ? "asc" : "desc")}>{order === "desc" ? "↓ 最新优先" : "↑ 最早优先"}</button>
        {q && (
          <span className="chip">
            {album ? "当前相册内" : "全局"}搜索:「{q}」
          </span>
        )}
      </div>

      <div ref={box} className="w-full">
        {groups.map((g) => (
          <section key={g.day} className="mb-5">
            <h3 className="muted mb-2 px-1 text-sm font-medium">{dayLabel(g.list[0].it.sortAt)}</h3>
            <div className="space-y-1.5">
              {justify(g.list, width, target, 6).map((row, ri) => (
                <div key={ri} className="row-lazy flex gap-1.5">
                  {row.map((t) => (
                    <button
                      key={t.it.id}
                      onClick={() => setOpen(t.idx)}
                      className="tile relative block shrink-0 overflow-hidden rounded-xl"
                      style={{ width: t.w, height: t.h, background: t.it.color ?? "var(--border)" }}
                      title={t.it.filename}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img key={t.it.status} src={`${t.it.thumbUrl}?s=${t.it.status}`} alt={t.it.filename} loading="lazy" draggable={false} className="h-full w-full object-cover" />
                      {t.it.kind === "video" && (
                        <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] text-white backdrop-blur">
                          ▶ {duration(t.it.duration)}
                        </span>
                      )}
                      {t.it.hasNote && <span className="absolute right-1.5 top-1.5 rounded-md bg-black/55 px-1 text-[11px] text-white">📝</span>}
                      {t.it.status === "pending" && <span className="absolute inset-x-0 bottom-0 bg-black/50 py-0.5 text-center text-[11px] text-white">处理中…</span>}
                      {t.it.status === "failed" && <span className="absolute inset-x-0 bottom-0 bg-red-700/70 py-0.5 text-center text-[11px] text-white">处理失败</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <div ref={sentinel} className="h-10" />
      {loading && <p className="muted py-6 text-center text-sm">加载中…</p>}
      {error && <p className="py-6 text-center text-sm text-red-600">{error}</p>}
      {!loading && !error && items.length === 0 && (
        <div className="glass mx-auto mt-10 max-w-md rounded-3xl p-10 text-center">
          <div className="text-4xl">🖼️</div>
          <p className="mt-3 font-medium">{q ? "没有找到匹配的内容" : "这里还没有内容"}</p>
          <p className="muted mt-1 text-sm">
            {q ? (album ? "搜索范围仅限当前相册(含子相册)" : "已在全部可见相册中搜索") : me?.user ? "点击右上角「上传」添加图片或视频" : "游客仅可浏览管理员开放的相册,可登录后查看更多"}
          </p>
        </div>
      )}

      {open !== null && items[open] && (
        <Viewer
          items={items}
          index={open}
          setIndex={(i) => {
            setOpen(i);
            if (i >= items.length - 6 && cursorRef.current) void fetchPage(false);
          }}
          onClose={() => setOpen(null)}
          onRemoved={(id) => {
            setItems((p) => p.filter((x) => x.id !== id));
            setOpen(null);
            window.dispatchEvent(new Event("pgs:albums"));
          }}
          hasMore={!!cursor}
        />
      )}
    </div>
  );
}
