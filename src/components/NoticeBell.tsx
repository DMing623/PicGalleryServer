"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { useApp } from "./AppProvider";
import { DISCLAIMER_SECTIONS } from "./Disclaimer";
import Markdown from "./Markdown";

/**
 * 顶部栏通知铃铛 + 通知面板。
 *
 * 交互:
 *  - 铃铛位于站点图标右侧;有未读时右上角显示小红点。
 *  - 点击铃铛弹出覆盖主体屏幕的面板,面板背后的相册内容被虚化。
 *  - 面板顶部「一键已读」;其下方是一条类似搜索栏的长条,显示未读概况,
 *    最右侧 ∨ 展开「有通知的日期」列表,未读日期会轻微闪烁变色。
 *  - 内容区默认展示安全隐私协议(默认已读,无需同意);点击日期后展示该日通知,
 *    同一天多条时以时间折叠展示,点击展开 / 收起。
 */

export interface NoticeDto {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  createdByName: string;
  read: boolean;
}

const PRIVACY_KEY = "privacy";

function dateKey(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(iso),
    );
  } catch {
    return iso.slice(0, 10);
  }
}

function timeLabel(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toTimeString().slice(0, 5);
  }
}

function dayLabel(key: string, tz: string): string {
  try {
    const d = new Date(`${key}T12:00:00Z`);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(d);
  } catch {
    return key;
  }
}

export default function NoticeBell() {
  const { me } = useApp();
  const tz = me?.site.timezone || "Asia/Shanghai";
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(me?.unread ?? 0);
  const [items, setItems] = useState<NoticeDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);
  const [sel, setSel] = useState<string>(PRIVACY_KEY);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const panel = useRef<HTMLDivElement>(null);

  /* ---------- 未读数 ---------- */
  const loadUnread = useCallback(() => {
    api<{ unread: number }>("/notices/unread")
      .then((r) => setUnread(r.unread))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadUnread();
    const t = setInterval(loadUnread, 60_000);
    const h = () => loadUnread();
    window.addEventListener("pgs:notices", h);
    return () => {
      clearInterval(t);
      window.removeEventListener("pgs:notices", h);
    };
  }, [loadUnread]);

  useEffect(() => {
    if (me) setUnread(me.unread ?? 0);
  }, [me]);

  /* ---------- 打开面板 ---------- */
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: NoticeDto[]; unread: number }>("/notices");
      setItems(r.items);
      setUnread(r.unread);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadAll();
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open, loadAll]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  /* ---------- 分组 ---------- */
  const groups = useMemo(() => {
    const m = new Map<string, NoticeDto[]>();
    for (const n of items) {
      const k = dateKey(n.createdAt, tz);
      const arr = m.get(k) ?? [];
      arr.push(n);
      m.set(k, arr);
    }
    // 每天内按时间倒序;日期整体倒序
    for (const arr of m.values()) arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [items, tz]);

  const unreadDates = useMemo(() => {
    const s = new Set<string>();
    for (const n of items) if (!n.read) s.add(dateKey(n.createdAt, tz));
    return s;
  }, [items, tz]);

  const latest = items[0];

  /* ---------- 操作 ---------- */
  async function markAll() {
    try {
      await api("/notices/read-all", { method: "POST" });
      setItems((arr) => arr.map((n) => ({ ...n, read: true })));
      setUnread(0);
      window.dispatchEvent(new Event("pgs:notices"));
    } catch {
      /* 忽略 */
    }
  }

  async function markOne(id: string) {
    try {
      await api(`/notices/${id}/read`, { method: "POST" });
      setItems((arr) => arr.map((n) => (n.id === id ? { ...n, read: true } : n)));
      setUnread((u) => Math.max(0, u - 1));
      window.dispatchEvent(new Event("pgs:notices"));
    } catch {
      /* 忽略 */
    }
  }

  function toggle(id: string) {
    const willOpen = !expanded.has(id);
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (willOpen) {
      const n = items.find((x) => x.id === id);
      if (n && !n.read) void markOne(id);
    }
  }

  const selItems = sel === PRIVACY_KEY ? [] : (groups.find(([k]) => k === sel)?.[1] ?? []);

  return (
    <>
      <button
        type="button"
        className="bell-btn"
        aria-label={unread > 0 ? `通知(${unread} 条未读)` : "通知"}
        title="通知"
        onClick={() => {
          setOpen(true);
          setSel(PRIVACY_KEY);
          setDropOpen(false);
        }}
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && <span className="bell-dot" aria-hidden />}
      </button>

      {/*
        必须用 Portal 挂到 body:铃铛位于 .topbar 内,而 .topbar 带 backdrop-filter(毛玻璃),
        带 backdrop-filter 的元素会成为 fixed 后代的包含块 —— 直接渲染的话 inset-0 只等于
        36px 高的顶栏,面板会被算成一条细线。
      */}
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[130] flex items-center justify-center"
            role="dialog"
            aria-modal="true"
            aria-label="通知"
            style={{
              paddingTop: "calc(env(safe-area-inset-top, 0px) + 46px)",
              paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 58px)",
              paddingLeft: "0.5rem",
              paddingRight: "0.5rem",
            }}
          >
          {/* 背景虚化:把相册内容挡住并模糊 */}
          <div
            className="notice-backdrop absolute inset-0"
            onClick={() => setOpen(false)}
            style={{
              background: "color-mix(in srgb, var(--bg) 30%, rgba(0,0,0,.42))",
              WebkitBackdropFilter: "blur(14px) saturate(1.2)",
              backdropFilter: "blur(14px) saturate(1.2)",
            }}
          />
          <div
            ref={panel}
            className="glass-strong fade-in relative flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl shadow-2xl"
          >
            {/* 顶部:标题 + 一键已读 */}
            <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
              <h2 className="flex items-center gap-1.5 text-base font-semibold">
                <span aria-hidden>🔔</span> 通知
              </h2>
              {unread > 0 && <span className="chip">{unread} 条未读</span>}
              <button className="btn ml-auto !py-1 text-xs" onClick={markAll} disabled={!items.some((n) => !n.read)}>
                ✓ 一键已读
              </button>
              <button className="btn !py-1 text-xs" onClick={() => setOpen(false)} aria-label="关闭">
                ✕
              </button>
            </div>

            {/* 未读概况长条(类似搜索栏)+ ∨ 下拉 */}
            <div className="shrink-0 px-3 pt-2">
              <div className="notice-bar">
                <span className="min-w-0 flex-1 truncate text-xs">
                  {unread > 0 ? (
                    <>
                      <span style={{ color: "var(--accent)" }}>● {unread} 条未读</span>
                      {latest && <span className="muted"> · 最新:{latest.title}</span>}
                    </>
                  ) : (
                    <span className="muted">{items.length ? "全部已读" : "暂无站点通知"}</span>
                  )}
                </span>
                <button
                  type="button"
                  className="notice-caret"
                  aria-label="展开有通知的日期"
                  aria-expanded={dropOpen}
                  onClick={() => setDropOpen((v) => !v)}
                >
                  <span style={{ display: "inline-block", transform: dropOpen ? "rotate(180deg)" : "none", transition: "transform .18s" }}>
                    ∨
                  </span>
                </button>
              </div>
              {dropOpen && (
                <div className="notice-dates glass mt-1 max-h-52 overflow-y-auto overscroll-contain rounded-xl p-1">
                  <button
                    className={`notice-date ${sel === PRIVACY_KEY ? "on" : ""}`}
                    onClick={() => {
                      setSel(PRIVACY_KEY);
                      setDropOpen(false);
                    }}
                  >
                    🛡 安全隐私协议
                    <span className="muted ml-auto text-[11px]">默认已读</span>
                  </button>
                  {groups.map(([k, arr]) => {
                    const un = unreadDates.has(k);
                    return (
                      <button
                        key={k}
                        className={`notice-date ${sel === k ? "on" : ""} ${un ? "unread" : ""}`}
                        onClick={() => {
                          setSel(k);
                          setDropOpen(false);
                          setExpanded(new Set());
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">{dayLabel(k, tz)}</span>
                        <span className="muted ml-2 shrink-0 text-[11px]">
                          {arr.length} 条{un ? " · 未读" : ""}
                        </span>
                      </button>
                    );
                  })}
                  {!groups.length && <p className="muted p-2 text-xs">还没有任何通知</p>}
                </div>
              )}
            </div>

            {/* 内容区:可滚动 */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
              {sel === PRIVACY_KEY ? (
                <div className="text-[13px] leading-relaxed">
                  <p className="muted mb-2 text-xs">以下为本站默认的安全与隐私说明,已默认阅读,无需再次同意。</p>
                  {DISCLAIMER_SECTIONS.map((s) => (
                    <section key={s.title} className="mb-3 last:mb-0">
                      <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--accent)" }}>
                        {s.title}
                      </h3>
                      <ul className="list-disc space-y-1 pl-5">
                        {s.items.map((t) => (
                          <li key={t}>{t}</li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {loading && <p className="muted text-sm">加载中…</p>}
                  {!loading && !selItems.length && <p className="muted text-sm">这一天没有通知</p>}
                  {selItems.map((n) => {
                    const on = expanded.has(n.id);
                    return (
                      <div key={n.id} className={`notice-item ${on ? "open" : ""} ${n.read ? "" : "unread"}`}>
                        <button className="notice-head" onClick={() => toggle(n.id)} aria-expanded={on}>
                          <span className="notice-time">{timeLabel(n.createdAt, tz)}</span>
                          <span className="min-w-0 flex-1 truncate text-left text-sm">{n.title}</span>
                          {!n.read && <span className="notice-unread-dot" aria-label="未读" />}
                          <span className="muted shrink-0 text-xs" aria-hidden>
                            {on ? "▲" : "▼"}
                          </span>
                        </button>
                        {on && (
                          <div className="notice-body">
                            {n.createdByName && <p className="muted mb-1 text-[11px]">发布者:{n.createdByName}</p>}
                            <Markdown text={n.body} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          </div>,
          document.body,
        )}
    </>
  );
}
