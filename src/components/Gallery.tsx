"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, qs } from "@/lib/api";
import { duration } from "@/lib/format";
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

/** 1mm ≈ 3.78 CSS px:瀑布流图片间距与两侧边距 */
const MM = 96 / 25.4;

/**
 * 固定列数:
 *  - 手机(竖屏或横屏,按短边判断)恒为 2 列;
 *  - 电脑/平板按屏宽分档,档位固定,所有列等宽。
 */
function columnsFor(w: number, h: number): number {
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  if (w < 640 || (coarse && Math.min(w, h) < 640)) return 2;
  if (w < 1100) return 4;
  if (w < 1500) return 5;
  if (w < 1900) return 6;
  if (w < 2400) return 7;
  return 8;
}

export default function Gallery({ album }: { album?: string }) {
  const sp = useSearchParams();
  const q = sp.get("q") ?? "";
  const kind = sp.get("kind") ?? "";
  const order: "asc" | "desc" = sp.get("order") === "asc" ? "asc" : "desc";
  const { loading: appLoading, me } = useApp();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [width, setWidth] = useState(1000);
  const [cols, setCols] = useState(2);
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
    const io = new IntersectionObserver((es) => es[0].isIntersecting && cursorRef.current && void fetchPage(false), { rootMargin: "1200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [fetchPage, items.length]);

  // 容器宽度与列数(横竖屏切换时同步更新)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => {
      setWidth(el.clientWidth);
      setCols(columnsFor(window.innerWidth, window.innerHeight));
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("orientationchange", update);
    update();
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", update);
    };
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

  /** 瀑布流分列:每张图放进当前最矮的列,所有列等宽;图片按真实宽高比显示 */
  const columns = useMemo(() => {
    const colW = Math.max(40, (width - MM * 2 - MM * (cols - 1)) / cols);
    const heights = new Array<number>(cols).fill(0);
    const out: Array<Array<{ it: MediaItem; idx: number; ar: number }>> = Array.from({ length: cols }, () => []);
    items.forEach((it, idx) => {
      const raw = it.width && it.height ? it.width / it.height : 1;
      const ar = Math.min(3, Math.max(0.35, raw));
      let c = 0;
      for (let i = 1; i < cols; i++) if (heights[i] < heights[c] - 0.5) c = i;
      out[c].push({ it, idx, ar });
      heights[c] += colW / ar + MM;
    });
    return out;
  }, [items, cols, width]);

  return (
    <div>
      {q && (
        <p className="muted px-2 pb-1 text-[11px]">
          {album ? "当前相册内" : "全局"}搜索:「{q}」
        </p>
      )}

      <div ref={box} className="masonry w-full">
        {columns.map((col, ci) => (
          <div key={ci} className="masonry-col">
            {col.map(({ it, idx, ar }) => (
              <button
                key={it.id}
                onClick={() => setOpen(idx)}
                className="mtile"
                style={{ aspectRatio: String(ar), background: it.color ?? "var(--border)" }}
                title={it.filename}
                aria-label={it.filename}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img key={it.status} src={`${it.thumbUrl}?s=${it.status}`} alt={it.filename} loading="lazy" decoding="async" draggable={false} />
                {it.kind === "video" && (
                  <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 py-px text-[10px] text-white backdrop-blur">▶ {duration(it.duration)}</span>
                )}
                {it.status === "pending" && <span className="absolute inset-x-0 bottom-0 bg-black/50 py-0.5 text-center text-[10px] text-white">处理中…</span>}
                {it.status === "failed" && <span className="absolute inset-x-0 bottom-0 bg-red-700/70 py-0.5 text-center text-[10px] text-white">处理失败</span>}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div ref={sentinel} className="h-10" />
      {loading && <p className="muted py-4 text-center text-xs">加载中…</p>}
      {error && <p className="py-4 text-center text-sm text-red-600">{error}</p>}
      {!loading && !error && items.length === 0 && (
        <div className="glass mx-auto mt-10 max-w-md rounded-3xl p-8 text-center">
          <div className="text-4xl">🖼️</div>
          <p className="mt-3 font-medium">{q ? "没有找到匹配的内容" : "这里还没有内容"}</p>
          <p className="muted mt-1 text-sm">
            {q ? (album ? "搜索范围仅限当前相册(不含子相册)" : "已在全部可见相册中搜索") : me?.user ? "点击底部「上传」添加图片或视频" : "游客仅可浏览管理员开放的相册,可登录后查看更多"}
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
