"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { bytes, dateTime } from "@/lib/format";
import { useApp } from "./AppProvider";
import { useDialog } from "./DialogProvider";
import type { MediaItem } from "./Gallery";
import MetaPanel, { type Meta } from "./MetaPanel";
import { useHd } from "./useHd";

interface Detail extends MediaItem {
  note: string;
  error: string | null;
  meta: Meta | null;
  mime: string;
  storage: string;
  storageKey: string | null;
  createdAt: string | null;
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
      {label && <span className="muted w-16 shrink-0 text-xs">{label}</span>}
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

/** 复制按钮:点击后短暂显示对勾反馈 */
function CopyChip({ value, className = "chip" }: { value: string; className?: string }) {
  const [ok, setOk] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      className={`${className} cursor-pointer`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setOk(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setOk(false), 1500);
        } catch {
          /* 剪贴板不可用时静默失败 */
        }
      }}
      title={ok ? "已复制" : "复制到剪贴板"}
    >
      {ok ? "✓ 已复制" : "复制"}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 缩放舞台:滚轮缩放 / 双击(双击触屏)放大 / 鼠标拖动 / 触屏双指缩放 / 触屏滑动切换   */
/* ------------------------------------------------------------------ */

interface View {
  s: number;
  x: number;
  y: number;
}

const MAX_SCALE = 8;

function applyTransform(el: HTMLDivElement | null, v: View, animate: boolean) {
  if (!el) return;
  el.style.transition = animate ? "transform .2s cubic-bezier(0.22, 1, 0.36, 1)" : "none";
  el.style.transform = `translate3d(-50%, -50%, 0) translate3d(${v.x}px, ${v.y}px, 0) scale(${v.s})`;
}

function ZoomStage({
  src, natW, natH, zoomable, alt, onSwipe, children,
}: {
  src: string;
  natW: number | null;
  natH: number | null;
  zoomable: boolean;
  alt: string;
  onSwipe: (dir: 1 | -1) => void;
  children?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<{ left: number; top: number; width: number; height: number }>({ left: 0, top: 0, width: 0, height: 0 });
  const viewRef = useRef<View>({ s: 1, x: 0, y: 0 });
  const [zoomed, setZoomed] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [nat, setNat] = useState({ w: natW ?? 0, h: natH ?? 0 });
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gest = useRef<{ kind: "none" | "pan" | "pinch"; sx: number; sy: number; v: View; dist: number; cx: number; cy: number; moved: number; t: number; type: string }>({
    kind: "none", sx: 0, sy: 0, v: { s: 1, x: 0, y: 0 }, dist: 0, cx: 0, cy: 0, moved: 0, t: 0, type: "mouse",
  });
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const [grabbing, setGrabbing] = useState(false);
  const grabbingRef = useRef(false);

  const setGrabState = useCallback((next: boolean) => {
    if (grabbingRef.current === next) return;
    grabbingRef.current = next;
    setGrabbing(next);
  }, []);

  const setContentNode = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    if (node) applyTransform(node, viewRef.current, false);
  }, []);

  const commit = useCallback((v: View, animate = false) => {
    const prevZoomed = viewRef.current.s > 1.001;
    const nextZoomed = v.s > 1.001;
    viewRef.current = v;
    applyTransform(contentRef.current, v, animate);
    if (prevZoomed !== nextZoomed) setZoomed(nextZoomed);
  }, []);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const syncRect = () => {
      const r = el.getBoundingClientRect();
      rectRef.current = { left: r.left, top: r.top, width: r.width, height: r.height };
      setSize((prev) => (prev.w === el.clientWidth && prev.h === el.clientHeight ? prev : { w: el.clientWidth, h: el.clientHeight }));
    };
    const ro = new ResizeObserver(syncRect);
    ro.observe(el);
    syncRect();
    return () => ro.disconnect();
  }, []);

  // 适配尺寸:占满舞台的大部分(四周留 8px),极小图最多放大 3 倍
  const pad = 8;
  const fit = nat.w && nat.h && size.w ? Math.min(3, Math.max(0.01, Math.min((size.w - pad * 2) / nat.w, (size.h - pad * 2) / nat.h))) : 0;
  const baseW = nat.w * fit;
  const baseH = nat.h * fit;

  const clamp = useCallback(
    (v: View): View => {
      const s = Math.min(MAX_SCALE, Math.max(1, v.s));
      const mx = Math.max(0, (baseW * s - size.w) / 2);
      const my = Math.max(0, (baseH * s - size.h) / 2);
      return { s, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
    },
    [baseW, baseH, size.w, size.h],
  );

  /** 以舞台坐标 (px,py)(相对舞台中心)为不动点缩放到 newS */
  const zoomAt = useCallback(
    (newS: number, px: number, py: number, animate = false) => {
      const v = viewRef.current;
      const s = Math.min(MAX_SCALE, Math.max(1, newS));
      const r = s / v.s;
      commit(clamp({ s, x: px - r * (px - v.x), y: py - r * (py - v.y) }), animate);
    },
    [clamp, commit],
  );

  /** factor=0 表示还原到 1× */
  const zoomBy = (factor: number) => zoomAt(factor === 0 ? 1 : viewRef.current.s * factor, 0, 0, true);

  const rel = (e: { clientX: number; clientY: number }) => {
    let r = rectRef.current;
    if (!r.width && stage.current) {
      const b = stage.current.getBoundingClientRect();
      r = rectRef.current = { left: b.left, top: b.top, width: b.width, height: b.height };
    }
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  // 滚轮缩放(需要非被动监听才能 preventDefault)
  useEffect(() => {
    const el = stage.current;
    if (!el || !zoomable) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const p = rel(e);
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
      zoomAt(viewRef.current.s * k, p.x, p.y, false);
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, [zoomable, zoomAt]);

  // 键盘 + / - / 0
  useEffect(() => {
    if (!zoomable) return;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.tagName === "TEXTAREA" || t?.tagName === "INPUT") return;
      if (e.key === "+" || e.key === "=") zoomAt(viewRef.current.s * 1.4, 0, 0, true);
      else if (e.key === "-") zoomAt(viewRef.current.s / 1.4, 0, 0, true);
      else if (e.key === "0") zoomAt(1, 0, 0, true);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [zoomable, zoomAt]);

  function down(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest("[data-nodrag]")) return;
    if (stage.current) {
      const b = stage.current.getBoundingClientRect();
      rectRef.current = { left: b.left, top: b.top, width: b.width, height: b.height };
      stage.current.setPointerCapture(e.pointerId);
    }
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (contentRef.current) contentRef.current.style.transition = "none";
    const g = gest.current;
    g.type = e.pointerType;
    if (ptrs.current.size === 1) {
      Object.assign(g, { kind: "pan", sx: e.clientX, sy: e.clientY, v: viewRef.current, moved: 0, t: Date.now() });
    } else if (ptrs.current.size === 2 && zoomable) {
      const [a, b] = [...ptrs.current.values()];
      const c = rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      Object.assign(g, { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: c.x, cy: c.y, v: viewRef.current, moved: 99 });
    }
  }

  function move(e: React.PointerEvent) {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gest.current;
    if (g.kind === "pinch" && ptrs.current.size >= 2 && zoomable) {
      const [a, b] = [...ptrs.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const c = rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      const s = Math.min(MAX_SCALE, Math.max(1, g.v.s * (dist / g.dist)));
      const r = s / g.v.s;
      // 以起始双指中心为不动点缩放,再叠加双指中心的平移
      commit(clamp({ s, x: g.cx - r * (g.cx - g.v.x) + (c.x - g.cx), y: g.cy - r * (g.cy - g.v.y) + (c.y - g.cy) }), false);
      setGrabState(true);
    } else if (g.kind === "pan") {
      const dx = e.clientX - g.sx;
      const dy = e.clientY - g.sy;
      g.moved = Math.max(g.moved, Math.hypot(dx, dy));
      if (zoomable && g.v.s > 1.001) {
        setGrabState(true);
        commit(clamp({ s: g.v.s, x: g.v.x + dx, y: g.v.y + dy }), false);
      }
    }
  }

  function up(e: React.PointerEvent) {
    const g = gest.current;
    const had = ptrs.current.delete(e.pointerId);
    if (!had) return;
    if (ptrs.current.size === 1 && g.kind === "pinch") {
      // 双指变单指:以剩余手指继续拖动
      const [rest] = [...ptrs.current.values()];
      Object.assign(g, { kind: "pan", sx: rest.x, sy: rest.y, v: viewRef.current, moved: 99 });
      return;
    }
    if (ptrs.current.size > 0) return;
    const wasPan = g.kind === "pan";
    g.kind = "none";
    setGrabState(false);
    if (!wasPan) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    const isTap = g.moved < 8 && Date.now() - g.t < 350;
    if (isTap && zoomable) {
      const now = Date.now();
      const lt = lastTap.current;
      if (now - lt.t < 320 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 40) {
        // 双击 / 双击触屏:1× ↔ 2.5×
        const p = rel(e);
        zoomAt(viewRef.current.s > 1.05 ? 1 : 2.5, p.x, p.y, true);
        lastTap.current = { t: 0, x: 0, y: 0 };
      } else lastTap.current = { t: now, x: e.clientX, y: e.clientY };
      return;
    }
    // 未放大时,触屏横滑切换上/下一张
    if (g.type === "touch" && viewRef.current.s <= 1.001 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) onSwipe(dx < 0 ? 1 : -1);
  }

  return (
    <div
      ref={stage}
      className="viewer-stage absolute inset-0 overflow-hidden"
      style={{ cursor: zoomable ? (zoomed ? (grabbing ? "grabbing" : "grab") : "zoom-in") : "default" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onContextMenu={(e) => e.preventDefault()}
    >
      {fit > 0 && (
        <div
          ref={setContentNode}
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: baseW,
            height: baseH,
            transformOrigin: "center",
            willChange: "transform",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            decoding="async"
            draggable={false}
            onLoad={(e) => {
              const im = e.currentTarget;
              if (im.naturalWidth && (!nat.w || zoomable)) {
                setNat((prev) => (prev.w === im.naturalWidth && prev.h === im.naturalHeight ? prev : { w: im.naturalWidth, h: im.naturalHeight }));
              }
            }}
            className="fade-in h-full w-full select-none object-fill shadow-2xl"
          />
        </div>
      )}
      {/* 尺寸未知时先用隐藏图片取得天然尺寸 */}
      {fit === 0 && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="invisible absolute" onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      )}
      {children}
      {zoomable && (
        <div data-nodrag className="absolute bottom-3 right-3 flex flex-col gap-1">
          <button className="grid h-8 w-8 place-items-center rounded-full bg-black/45 text-sm text-white backdrop-blur hover:bg-black/65" onClick={() => zoomBy(1.5)} aria-label="放大">＋</button>
          <button className="grid h-8 w-8 place-items-center rounded-full bg-black/45 text-sm text-white backdrop-blur hover:bg-black/65" onClick={() => zoomBy(1 / 1.5)} aria-label="缩小">－</button>
          <button className="grid h-8 w-8 place-items-center rounded-full bg-black/45 text-sm text-white backdrop-blur hover:bg-black/65" onClick={() => zoomBy(0)} aria-label="还原">⤢</button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-line/40 py-1.5 text-[13px] last:border-0">
      <dt className="muted w-20 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
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
  const dlg = useDialog();
  const { can } = useApp();
  const cur = items[index];
  const root = useRef<HTMLDivElement>(null);
  const detailCache = useRef(new Map<string, Detail>());
  const loadReqId = useRef(0);
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [panel, setPanel] = useState(false);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);
  const hd = useHd(items, index);

  const load = useCallback(async (bypassCache = false) => {
    const targetId = cur.id;
    const req = ++loadReqId.current;
    if (!bypassCache) {
      const cached = detailCache.current.get(targetId);
      if (cached && cached.status !== "pending") {
        setD(cached);
        setNote(cached.note);
        setErr("");
        return;
      }
    }
    try {
      const x = await api<Detail>(`/media/${targetId}`);
      if (req !== loadReqId.current) return;
      if (detailCache.current.size >= 30) {
        const oldest = detailCache.current.keys().next().value;
        if (oldest) detailCache.current.delete(oldest);
      }
      detailCache.current.set(targetId, x);
      setD(x);
      setNote(x.note);
      setErr("");
    } catch (e) {
      if (req === loadReqId.current) setErr((e as Error).message);
    }
  }, [cur.id]);

  useEffect(() => {
    const cached = detailCache.current.get(cur.id);
    setD(cached ?? null);
    if (cached) setNote(cached.note);
    setEditing(false);
    void load();
  }, [cur.id, load]);

  // 处理中则轮询详情,以便尽快显示元数据
  useEffect(() => {
    if (!d || d.status !== "pending") return;
    const t = setTimeout(() => void load(true), 2500);
    return () => clearTimeout(t);
  }, [d, load]);

  const prev = useCallback(() => index > 0 && setIndex(index - 1), [index, setIndex]);
  const next = useCallback(() => index < items.length - 1 && setIndex(index + 1), [index, items.length, setIndex]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement)?.tagName;
      if (t === "TEXTAREA" || t === "INPUT") return;
      if (e.key === "Escape") {
        if (panel) setPanel(false);
        else onClose();
      } else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "i" || e.key === "I") setPanel((p) => !p);
    };
    window.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", h);
      document.body.style.overflow = "";
    };
  }, [onClose, prev, next, panel]);

  useEffect(() => {
    const h = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);

  function toggleFull() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.().catch(() => undefined);
  }

  async function saveNote() {
    setBusy(true);
    try {
      await api(`/media/${cur.id}`, { method: "PATCH", json: { note } });
      setEditing(false);
      await load(true);
      window.dispatchEvent(new Event("pgs:changed"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!d) return;
    // 物理删除源文件需要 media.purge(仅 admin);其它角色只能"排除"(进删除黑名单)
    const canPurge = can("media.purge");
    const pick = await dlg.confirmCheck({
      title: "删除文件",
      message: `即将删除「${d.filename}」。`,
      checkLabel: canPurge ? "同时删除服务器上的原文件(彻底删除,不可恢复)" : "同时删除服务器上的原文件(需要管理员权限)",
      checkHint:
        "不勾选时:仅把该文件从本项目排除(加入删除黑名单),服务器上的源文件保持原样;之后可在 设置 → 删除黑名单 中解除并恢复。",
      confirmText: "删除",
      danger: true,
    });
    if (!pick) return;
    if (pick.checked && !canPurge) {
      setErr("物理删除源文件需要管理员权限;已按「仅排除」处理");
    }
    const purge = pick.checked && canPurge;
    try {
      await api(`/media/${cur.id}?purge=${purge ? 1 : 0}`, { method: "DELETE" });
      detailCache.current.delete(cur.id);
      onRemoved(cur.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const origLink = d && key ? `${d.links.file}?key=${encodeURIComponent(key)}` : "";
  const isVideo = cur.kind === "video";
  const hdReady = hd.state?.status === "ready" && !!hd.state.url;
  const format = (d?.meta?.summary?.file?.format as string | undefined) ?? d?.mime ?? cur.filename.split(".").pop() ?? "";
  const resolution = (d?.width ?? cur.width) && (d?.height ?? cur.height) ? `${d?.width ?? cur.width} × ${d?.height ?? cur.height}` : d?.status === "pending" || cur.status === "pending" ? "处理中…" : "未知";

  const circle = "grid h-9 w-9 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition hover:bg-black/70 disabled:opacity-35";

  return (
    <div ref={root} className="fixed inset-0 z-50 flex flex-col text-white" style={{ background: "rgba(10,10,10,.96)" }}>
      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ===== 舞台:高清图占据屏幕主体 ===== */}
        <div className="relative min-h-0 min-w-0 flex-1">
          {isVideo ? (
            <div className="absolute inset-0 flex items-center justify-center p-2 pt-14">
              {d?.streamUrl ? (
                <video
                  key={d.streamUrl}
                  src={d.streamUrl}
                  poster={cur.previewUrl}
                  controls
                  controlsList="nodownload noremoteplayback"
                  disablePictureInPicture
                  playsInline
                  onContextMenu={(e) => e.preventDefault()}
                  className="max-h-full max-w-full bg-black"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={cur.previewUrl} alt="" className="max-h-full max-w-full opacity-60" />
              )}
            </div>
          ) : hdReady ? (
            <ZoomStage
              key={cur.id + "-hd"}
              src={hd.state!.url!}
              natW={cur.width}
              natH={cur.height}
              zoomable
              alt={cur.filename}
              onSwipe={(dir) => (dir > 0 ? next() : prev())}
            />
          ) : (
            /* 高清图(已含水印)就绪前只显示加载状态,不先展示无水印的预览图 */
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              {hd.state?.status === "error" ? (
                <>
                  <span className="text-3xl">⚠️</span>
                  <p className="max-w-sm break-words text-sm">高清图加载失败:{hd.state.error}</p>
                  <button className="btn btn-primary !py-1 text-xs" onClick={hd.retry}>重试</button>
                </>
              ) : (
                <>
                  <span className="hd-spinner" />
                  <p className="text-xs opacity-70">正在加载高清预览…</p>
                </>
              )}
            </div>
          )}

          {/* 顶栏:关闭 / 计数 / 右上角功能按钮 */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 p-2" style={{ paddingTop: "calc(env(safe-area-inset-top,0px) + 8px)" }}>
            <button className={`${circle} pointer-events-auto`} onClick={onClose} aria-label="关闭">✕</button>
            <div className="pointer-events-none min-w-0 flex-1 pt-1">
              <div className="truncate text-sm font-medium drop-shadow">{cur.filename}</div>
              <div className="text-[11px] opacity-70 drop-shadow">{index + 1} / {items.length}{hasMore ? "+" : ""}</div>
            </div>
            <div className="pointer-events-auto flex gap-1.5">
              <button className={circle} onClick={prev} disabled={index === 0} aria-label="上一张">‹</button>
              <button className={circle} onClick={next} disabled={index >= items.length - 1} aria-label="下一张">›</button>
              {typeof document !== "undefined" && document.fullscreenEnabled && (
                <button className={circle} onClick={toggleFull} aria-label="全屏">{full ? "⤡" : "⛶"}</button>
              )}
              <button className={`${circle} ${panel ? "!bg-white !text-black" : ""}`} onClick={() => setPanel((p) => !p)} aria-label="图片详情" title="图片详情 (I)">ⓘ</button>
            </div>
          </div>
        </div>

        {/* ===== 详情页:桌面端并排(不遮盖图片),手机端自下而上的页面 ===== */}
        {panel && (
          <aside
            className="glass-strong absolute inset-x-0 bottom-0 top-[14vh] z-10 flex flex-col overflow-hidden rounded-t-2xl text-[var(--fg)] shadow-2xl lg:static lg:inset-auto lg:w-[420px] lg:shrink-0 lg:rounded-none"
            style={{ background: "color-mix(in srgb, var(--surface) 94%, transparent)" }}
          >
            <div className="flex items-center gap-2 border-b border-line/50 px-4 py-2">
              <h3 className="flex-1 text-sm font-semibold">图片详情</h3>
              <button className="btn !px-2.5 !py-1 text-xs" onClick={() => setPanel(false)}>关闭 ✕</button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              {err && <p className="text-sm text-red-600">{err}</p>}
              {!d && !err && <p className="muted text-sm">加载中…</p>}
              {d?.status === "pending" && <p className="text-xs" style={{ color: "var(--accent)" }}>正在生成缩略图与元数据…</p>}
              {d?.status === "failed" && <p className="text-xs text-red-600">处理失败:{d.error}</p>}

              {/* 必备条目:所有图片都有 */}
              <section>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--accent)" }}>基本信息</h4>
                <dl>
                  <InfoRow label="图片名称">{cur.filename}</InfoRow>
                  <InfoRow label="备注">
                    {editing ? (
                      <div className="space-y-2">
                        <textarea className="field min-h-24" value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} placeholder="仅用于展示,不会写入原文件" autoFocus />
                        <div className="flex gap-2">
                          <button className="btn btn-primary !py-1 text-xs" disabled={busy} onClick={saveNote}>保存</button>
                          <button className="btn !py-1 text-xs" onClick={() => { setEditing(false); setNote(d?.note ?? ""); }}>取消</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <span className={`min-w-0 flex-1 whitespace-pre-wrap ${d?.note ? "" : "muted"}`}>{d ? d.note || "暂无备注" : "…"}</span>
                        {d?.canEdit && <button className="btn !px-2 !py-0.5 text-xs" onClick={() => setEditing(true)}>✎ 编辑</button>}
                      </div>
                    )}
                  </InfoRow>
                  <InfoRow label="分辨率">{resolution}</InfoRow>
                  <InfoRow label="所属相册">{d ? (d.breadcrumbs.length ? d.breadcrumbs.map((b) => b.name).join(" / ") : "未归类") : "…"}</InfoRow>
                  <InfoRow label="图片 ID">
                    <span className="flex items-center gap-2">
                      <code className="select-all break-all">{cur.id}</code>
                      <CopyChip value={cur.id} />
                    </span>
                    <span className="muted mt-0.5 block text-[11px]">API 中的图片字符串 ID:/api/v1/media/{cur.id}、/f/{cur.id}</span>
                  </InfoRow>
                  <InfoRow label="上传时间">{d ? dateTime(d.createdAt) : "…"}</InfoRow>
                  <InfoRow label="格式">{String(format).toUpperCase()}</InfoRow>
                  <InfoRow label="文件大小">{bytes(cur.size)}</InfoRow>
                  {d?.takenAt && <InfoRow label="拍摄时间">{dateTime(d.takenAt)}</InfoRow>}
                  {d?.storageKey && <InfoRow label="存储位置"><span className="muted break-all text-[11px]">[{d.storage}] {d.storageKey}</span></InfoRow>}
                </dl>
              </section>

              {/* 自动检测的元数据:有什么显示什么 */}
              {d && <MetaPanel meta={d.meta} kind={d.kind} />}

              {d && (
                <section className="glass rounded-2xl p-3">
                  <h4 className="mb-2 text-sm font-semibold">文件链接</h4>
                  <div className="space-y-1.5">
                    <CopyLine label="直链" value={d.links.file} />
                    <CopyLine label="HTML" value={d.links.html} />
                    <CopyLine label="Markdown" value={d.links.markdown} />
                  </div>
                  <p className="muted mt-2 text-xs">
                    不带密钥的链接只会返回{d.kind === "video" ? "视频封面图" : "网页预览图"}。获取服务器原文件需在链接后追加 <code>?key=下载密钥</code>(由管理员在设置中创建):
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    <input className="field !py-1 text-xs" placeholder="输入下载密钥,生成原文件链接" value={key} onChange={(e) => setKey(e.target.value)} />
                    {origLink && (
                      <>
                        <a className="btn btn-primary !py-1 text-xs" href={`${origLink}&dl=1`}>下载原文件</a>
                        <CopyLine label="" value={origLink} />
                      </>
                    )}
                    {d.canOriginal && <a className="btn !py-1 text-xs" href={`/f/${d.id}?dl=1`}>下载原文件(管理权限)</a>}
                  </div>
                </section>
              )}

              {d?.canEdit && (
                <div className="flex flex-wrap gap-2">
                  <button className="btn !py-1 text-xs" onClick={async () => { await api(`/media/${d.id}/reprocess`, { method: "POST" }); await load(true); }}>重新生成缩略图/元数据</button>
                  <button className="btn btn-danger !py-1 text-xs" onClick={remove}>🗑 删除</button>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
