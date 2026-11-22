"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { bytes } from "@/lib/format";
import { useApp } from "../AppProvider";

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
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="glass rounded-xl p-3">
      <div className="muted text-xs">{label}</div>
      <div className="mt-0.5 text-lg font-semibold">{value}</div>
    </div>
  );
}

export default function SystemTab() {
  const { can } = useApp();
  const [s, setS] = useState<Status | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () => api<Status>("/status").then((r) => alive && setS(r)).catch((e) => alive && setMsg(e.message));
    void load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!s) return <p className="muted text-sm">{msg || "加载中…"}</p>;
  const c = s.counts;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="媒体总数" value={c.total} />
        <Stat label="图片 / 视频" value={`${c.images} / ${c.videos}`} />
        <Stat label="占用空间(原文件)" value={bytes(c.bytes)} />
        <Stat label="相册 / 用户 / 密钥" value={`${c.albums} / ${c.users} / ${c.keys}`} />
        <Stat label="处理队列" value={`${s.queue.running} 运行 · ${s.queue.waiting} 等待`} />
        <Stat label="待处理 / 失败" value={`${c.pending} / ${c.failed}`} />
        <Stat label="未归类" value={c.unsorted} />
        <Stat label="磁盘剩余" value={s.disk ? `${bytes(s.disk.freeBytes)} / ${bytes(s.disk.totalBytes)}` : "N/A"} />
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
        <h3 className="mb-1 mt-4 font-semibold">当前配置</h3>
        <pre className="glass overflow-auto rounded-lg p-3 text-xs">{JSON.stringify(s.config, null, 2)}</pre>
      </section>
      {can("media.edit") && (
        <div className="flex items-center gap-3">
          <button
            className="btn"
            onClick={async () => {
              const r = await api<{ queued: number }>("/system/reprocess", { method: "POST" });
              setMsg(`已重新入队 ${r.queued} 个待处理/失败文件`);
            }}
          >
            ⟳ 重新处理失败 / 待处理文件
          </button>
          {msg && <span className="text-sm">{msg}</span>}
        </div>
      )}
    </div>
  );
}
