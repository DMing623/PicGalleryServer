"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "../AppProvider";
import { useDialog } from "../DialogProvider";
import Markdown from "../Markdown";
import type { NoticeDto } from "../NoticeBell";

/**
 * 设置 → 通知发布(管理者及以上)。
 * 支持 Markdown 编辑与实时预览;发布后所有登录用户在顶部铃铛里可见。
 */

function fmt(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default function NoticeTab() {
  const { me, can } = useApp();
  const dlg = useDialog();
  const tz = me?.site.timezone || "Asia/Shanghai";
  const [items, setItems] = useState<NoticeDto[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: NoticeDto[] }>("/notices");
      setItems(r.items);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canPublish = can("notice.publish");
  const sorted = useMemo(() => [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [items]);

  function reset() {
    setTitle("");
    setBody("");
    setPinned(false);
    setEditing(null);
    setPreview(false);
  }

  async function submit() {
    if (!title.trim()) {
      setMsg("请填写标题");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      if (editing) {
        await api(`/notices/${editing}`, { method: "PATCH", json: { title: title.trim(), body, pinned } });
        setMsg("已保存修改");
      } else {
        await api("/notices", { method: "POST", json: { title: title.trim(), body, pinned } });
        setMsg("已发布,所有登录用户会在铃铛里看到");
      }
      reset();
      await load();
      window.dispatchEvent(new Event("pgs:notices"));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const ok = await dlg.confirm({ title: "删除通知", message: "删除后所有用户都不再看到这条通知,确定删除?", confirmText: "删除", danger: true });
    if (!ok) return;
    try {
      await api(`/notices/${id}`, { method: "DELETE" });
      await load();
      window.dispatchEvent(new Event("pgs:notices"));
    } catch (e) {
      await dlg.alert((e as Error).message, "删除失败");
    }
  }

  if (!canPublish) {
    return <p className="muted text-sm">需要管理者及以上权限才能发布通知。</p>;
  }

  return (
    <div className="min-w-0 space-y-4">
      <section className="glass rounded-2xl p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{editing ? "编辑通知" : "发布新通知"}</h3>
          <span className="muted text-xs">支持 Markdown;时间按站点时区({tz})显示</span>
          <button className="btn ml-auto !py-1 text-xs" onClick={() => setPreview((v) => !v)}>
            {preview ? "✎ 继续编辑" : "👁 预览"}
          </button>
        </div>
        <input
          className="field mb-2"
          placeholder="标题(必填)"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
        {preview ? (
          <div className="min-h-[10rem] rounded-xl border border-line/70 bg-black/5 p-3">
            {body.trim() ? <Markdown text={body} /> : <p className="muted text-xs">还没有内容</p>}
          </div>
        ) : (
          <textarea
            className="field min-h-[10rem] resize-y font-mono text-[13px] leading-relaxed"
            placeholder={"支持 Markdown:\n# 标题\n**粗体** *斜体* `代码`\n- 列表\n> 引用\n[链接](https://example.com)"}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> 置顶
          </label>
          {msg && <span className="min-w-0 break-words text-xs" style={{ color: "var(--accent)" }}>{msg}</span>}
          <span className="flex-1" />
          {editing && (
            <button className="btn" onClick={reset} disabled={busy}>
              取消编辑
            </button>
          )}
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "提交中…" : editing ? "保存修改" : "发布通知"}
          </button>
        </div>
      </section>

      <section className="glass rounded-2xl p-4">
        <h3 className="mb-2 text-sm font-semibold">已发布({sorted.length})</h3>
        {!sorted.length && <p className="muted text-xs">还没有发布过通知。</p>}
        <ul className="space-y-2">
          {sorted.map((n) => (
            <li key={n.id} className="rounded-xl border border-line/70 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.title}</span>
                {n.pinned && <span className="chip">置顶</span>}
                <span className="muted text-[11px]">{fmt(n.createdAt, tz)}</span>
                <button
                  className="btn !py-0.5 text-xs"
                  onClick={() => {
                    setEditing(n.id);
                    setTitle(n.title);
                    setBody(n.body);
                    setPinned(n.pinned);
                    setPreview(false);
                    setMsg("");
                  }}
                >
                  编辑
                </button>
                <button className="btn btn-danger !py-0.5 text-xs" onClick={() => remove(n.id)}>
                  删除
                </button>
              </div>
              {n.body && <p className="muted mt-1 line-clamp-2 text-xs">{n.body.replace(/[#>*`]/g, "").slice(0, 120)}</p>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
