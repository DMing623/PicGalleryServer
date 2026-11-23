"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { bytes } from "@/lib/format";
import { useApp } from "../AppProvider";
import { useDialog } from "../DialogProvider";

interface Status {
  app: string;
  version: string;
  uptimeSec: number;
  node: string;
  counts: { total: number; images: number; videos: number; pending: number; failed: number; unsorted: number; bytes: number; albums: number; users: number; keys: number };
  queue: { concurrency: number; running: number; waiting: number; done: number; failed: number };
  tools: { ffmpeg: boolean; ffprobe: boolean; s3: boolean };
  memory: { rss: number; heapUsed: number };
  disk: { freeBytes: number; totalBytes: number } | null;
  config: Record<string, string | number>;
  hd?: { files: number; bytes: number; maxBytes: number; ttlDays: number; hits: number; misses: number; evicted: number; expired: number; invalidated: number; conversions: number; coalesced: number };
}

interface CorruptItem {
  id: string;
  filename: string;
  kind: string;
  size: number;
  error: string | null;
  createdAt: string;
}

interface CorruptSummary {
  count: number;
  items: CorruptItem[];
  autoPurgeHours: number;
  purgeInSec: number | null;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="glass min-w-0 rounded-xl p-3">
      <div className="muted text-xs">{label}</div>
      <div className="mt-0.5 break-words text-lg font-semibold">{value}</div>
    </div>
  );
}

/** 疑似损坏文件:右上角垃圾桶图标,点击弹出确认框并列出文件名(最多 20 个) */
function CorruptCard({ data, onPurged }: { data: CorruptSummary; onPurged: () => void }) {
  const dlg = useDialog();
  const [busy, setBusy] = useState(false);
  const shown = data.items.slice(0, 20);
  const more = data.count - shown.length;

  async function purge() {
    const list = shown.map((i) => `· ${i.filename}`).join("\n");
    const ok = await dlg.confirm({
      title: "清理疑似损坏文件",
      message: (
        <span className="block space-y-2">
          <span className="block">
            共 <b>{data.count}</b> 个文件无法生成缩略图或解析元数据(损坏、伪造或格式不支持)。
            删除后记录与源文件一并移除,不可恢复。
          </span>
          <span className="block whitespace-pre-wrap break-all text-xs opacity-80">
            {list}
            {more > 0 && `\n…另有 ${more} 个未列出`}
          </span>
        </span>
      ),
      confirmText: "全部删除",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api("/status/corrupt/purge", { method: "POST", json: {} });
      onPurged();
    } catch (e) {
      await dlg.alert((e as Error).message, "清理失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass relative min-w-0 rounded-xl p-3">
      <div className="muted text-xs">疑似损坏文件</div>
      <div className="mt-0.5 break-words text-lg font-semibold">{data.count}</div>
      <div className="muted mt-0.5 text-[11px] leading-tight">
        {data.count === 0
          ? "无"
          : data.autoPurgeHours > 0 && data.purgeInSec !== null
            ? `${Math.floor(data.purgeInSec / 3600)} 小时后自动清理`
            : "需手动清理"}
      </div>
      {data.count > 0 && (
        <button
          className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-lg text-sm hover:bg-black/10 disabled:opacity-40"
          title="清理疑似损坏文件"
          aria-label="清理疑似损坏文件"
          disabled={busy}
          onClick={purge}
        >
          🗑
        </button>
      )}
    </div>
  );
}

export default function SystemTab() {
  const { can } = useApp();
  const [s, setS] = useState<Status | null>(null);
  const [corrupt, setCorrupt] = useState<CorruptSummary | null>(null);
  const [msg, setMsg] = useState("");

  const loadCorrupt = useCallback(() => api<CorruptSummary>("/status/corrupt").then(setCorrupt).catch(() => undefined), []);

  useEffect(() => {
    let alive = true;
    const load = () => api<Status>("/status").then((r) => alive && setS(r)).catch((e) => alive && setMsg(e.message));
    void load();
    void loadCorrupt();
    const t = setInterval(load, 3000);
    const t2 = setInterval(() => void loadCorrupt(), 10000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(t2);
    };
  }, [loadCorrupt]);

  if (!s) return <p className="muted text-sm">{msg || "加载中…"}</p>;
  const c = s.counts;
  return (
    <div className="min-w-0 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="媒体总数" value={c.total} />
        <Stat label="图片 / 视频" value={`${c.images} / ${c.videos}`} />
        <Stat label="占用空间(原文件)" value={bytes(c.bytes)} />
        <Stat label="相册 / 用户 / 密钥" value={`${c.albums} / ${c.users} / ${c.keys}`} />
        <Stat label="处理队列" value={`${s.queue.running} 运行 · ${s.queue.waiting} 等待`} />
        <Stat label="待处理 / 失败" value={`${c.pending} / ${c.failed}`} />
        <Stat label="未归类" value={c.unsorted} />
        <Stat label="磁盘剩余" value={s.disk ? `${bytes(s.disk.freeBytes)} / ${bytes(s.disk.totalBytes)}` : "N/A"} />
        {corrupt && (
          <CorruptCard
            data={corrupt}
            onPurged={() => {
              void loadCorrupt();
              setMsg("已清理疑似损坏文件");
            }}
          />
        )}
      </div>
      <section className="glass rounded-2xl p-5 text-sm">
        <h3 className="mb-2 font-semibold">运行环境</h3>
        <ul className="grid gap-1 sm:grid-cols-2">
          <li>版本:{s.app} {s.version}</li>
          <li>Node:{s.node}</li>
          <li>运行时长:{Math.floor(s.uptimeSec / 3600)} 小时 {Math.floor((s.uptimeSec % 3600) / 60)} 分</li>
          <li>内存:RSS {bytes(s.memory.rss)} · 堆 {bytes(s.memory.heapUsed)}</li>
          <li>ffmpeg:{s.tools.ffmpeg ? "✓ 可用" : "✗ 未检测到(视频封面使用占位图)"}</li>
          <li>ffprobe:{s.tools.ffprobe ? "✓ 可用" : "✗ 未检测到(视频元数据为 N/A)"}</li>
          <li>对象存储 S3:{s.tools.s3 ? "✓ 已配置" : "未配置"}</li>
          <li>处理并发上限:{s.queue.concurrency}(THUMB_CONCURRENCY)</li>
        </ul>
        {s.hd && (
          <>
            <h3 className="mb-1 mt-4 font-semibold">高清预览缓存</h3>
            <ul className="grid gap-1 sm:grid-cols-2">
              <li>缓存:{s.hd.files} 个文件 · {bytes(s.hd.bytes)} / {bytes(s.hd.maxBytes)}(有效期 {s.hd.ttlDays} 天)</li>
              <li>命中 {s.hd.hits} · 未命中 {s.hd.misses} · 合并并发 {s.hd.coalesced}</li>
              <li>转换 {s.hd.conversions} 次 · LRU 淘汰 {s.hd.evicted} · 过期 {s.hd.expired} · 失效 {s.hd.invalidated}</li>
            </ul>
          </>
        )}
        <h3 className="mb-1 mt-4 font-semibold">当前配置</h3>
        <pre className="glass overflow-auto rounded-lg p-3 text-xs">{JSON.stringify(s.config, null, 2)}</pre>
      </section>
      {can("media.edit") && (
        /* 按钮允许换行:窄屏下两个按钮各占一行,提示信息独占一行,
           避免 nowrap 的按钮与长文本撑破容器造成整页横向溢出 */
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
          <button
            className="btn"
            onClick={async () => {
              const r = await api<{ queued: number }>("/system/reprocess", { method: "POST" });
              setMsg(`已重新入队 ${r.queued} 个待处理/失败文件`);
            }}
          >
            ⟳ 重新处理失败 / 待处理文件
          </button>
          <button
            className="btn"
            onClick={async () => {
              const r = await api<{ queued: number }>("/system/regenerate-derived", { method: "POST" });
              setMsg(`已入队 ${r.queued} 个文件,正在重新生成高清无元数据缩略图/预览图`);
            }}
          >
            ↻ 重新生成全部缩略图
          </button>
          {msg && <span className="w-full min-w-0 break-words text-sm">{msg}</span>}
        </div>
      )}
    </div>
  );
}
