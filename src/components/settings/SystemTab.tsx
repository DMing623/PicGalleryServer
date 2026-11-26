"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useCallback, useEffect, useMemo, useState } from "react";
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
  queue: {
    concurrency: number; running: number; waiting: number; done: number; failed: number;
    gates?: Record<string, { max: number; active: number; waiting: number }>;
  };
  tools: { ffmpeg: boolean; ffprobe: boolean; s3: boolean };
  memory: {
    rss: number; heapUsed: number; heapTotal?: number; external?: number; arrayBuffers?: number; maxRss?: number; rssPeak10m?: number;
    cgroup?: { version: number; current: number | null; max: number | null; anon: number | null; workingSet: number | null } | null;
    pressureRatio?: number | null;
  };
  eventLoop?: { p99Ms: number; maxMs: number; windowSec: number } | null;
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
  /** 因超出内存/像素上限被拒绝(未损坏,不会被自动清理)的文件数 */
  limited?: number;
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
      {!!data.limited && (
        <div className="mt-1 text-[11px] leading-tight" style={{ color: "var(--accent)" }} title="这些文件没有损坏:超出了 MEDIA_MAX_INPUT_MP / MEDIA_MAX_EST_MB 的上限,原文件完好保留。调大上限后在「重新处理」里恢复。">
          另有 {data.limited} 个因超限被拒绝(原文件保留)
        </div>
      )}
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

export default function SystemTab({ active = true }: { active?: boolean }) {
  const { can, me, reload } = useApp();
  const [s, setS] = useState<Status | null>(null);
  const [corrupt, setCorrupt] = useState<CorruptSummary | null>(null);
  const [msg, setMsg] = useState("");
  const [tz, setTz] = useState(me?.site.timezone ?? "Asia/Shanghai");
  const [tzBusy, setTzBusy] = useState(false);
  const [tzMsg, setTzMsg] = useState("");

  const zones = useMemo(() => {
    const list: string[] =
      typeof Intl.supportedValuesOf === "function"
        ? (Intl.supportedValuesOf("timeZone") as string[])
        : ["Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "UTC", "Europe/London", "America/New_York", "America/Los_Angeles"];
    const extra = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Asia/Seoul", "Asia/Singapore", "UTC"];
    return [...new Set([...extra, ...list])].sort((a, b) => a.localeCompare(b));
  }, []);

  useEffect(() => {
    if (me?.site.timezone) setTz(me.site.timezone);
  }, [me?.site.timezone]);

  const loadCorrupt = useCallback(() => api<CorruptSummary>("/status/corrupt").then(setCorrupt).catch(() => undefined), []);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      api<Status>("/status").then((r) => alive && setS(r)).catch((e) => alive && setMsg(e.message));
    };
    const loadCorruptVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void loadCorrupt();
    };
    void load();
    void loadCorrupt();
    const onVis = () => {
      if (document.visibilityState !== "hidden") {
        void load();
        void loadCorrupt();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(load, 3000);
    const t2 = setInterval(loadCorruptVisible, 10000);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(t);
      clearInterval(t2);
    };
  }, [loadCorrupt, active]);

  const tzFmt = useMemo(() => {
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    } catch {
      return null;
    }
  }, [tz]);

  if (!s) return <p className="muted text-sm">{msg || "加载中…"}</p>;
  const c = s.counts;
  const nowInTz = tzFmt ? tzFmt.format(new Date()) : "—";

  async function saveTz(next: string) {
    setTz(next);
    setTzBusy(true);
    setTzMsg("");
    try {
      await api("/settings", { method: "PUT", json: { timezone: next } });
      setTzMsg("已保存,通知时间与日期分组会按新时区显示");
      await reload();
    } catch (e) {
      setTzMsg((e as Error).message);
    } finally {
      setTzBusy(false);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <section className="glass rounded-2xl p-4 text-sm">
        <h3 className="mb-1 font-semibold">时区</h3>
        <p className="muted mb-2 text-xs">
          通知的发布时间、日期分组都按该时区换算;修改后历史通知的显示时间会同步变化。
          容器部署时可用环境变量 TZ 指定默认值(默认 Asia/Shanghai)。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="field max-w-full sm:max-w-xs"
            value={tz}
            disabled={!can("settings") || tzBusy}
            onChange={(e) => void saveTz(e.target.value)}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <span className="muted text-xs">当前时间:{nowInTz}</span>
        </div>
        {!can("settings") && <p className="muted mt-1 text-xs">仅管理员可修改时区。</p>}
        {tzMsg && <p className="mt-1 break-words text-xs" style={{ color: "var(--accent)" }}>{tzMsg}</p>}
      </section>
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
          <li>内存:RSS {bytes(s.memory.rss)} · 堆 {bytes(s.memory.heapUsed)}{s.memory.external !== undefined && <> · 堆外 {bytes(s.memory.external)}</>}</li>
          {s.memory.rssPeak10m !== undefined && <li>近 10 分钟 RSS 峰值:{bytes(s.memory.rssPeak10m)}(启动以来 {bytes(s.memory.maxRss ?? 0)})</li>}
          {s.memory.cgroup && (
            <li>
              容器内存:工作集 {bytes(s.memory.cgroup.workingSet ?? 0)} / {s.memory.cgroup.max ? bytes(s.memory.cgroup.max) : "无上限"}
              {s.memory.pressureRatio != null && <> · 水位 {Math.round(s.memory.pressureRatio * 100)}%</>}
            </li>
          )}
          {s.eventLoop && <li>事件循环延迟:p99 {s.eventLoop.p99Ms}ms · 最大 {s.eventLoop.maxMs}ms</li>}
          {s.queue.gates && Object.keys(s.queue.gates).length > 0 && (
            <li>
              闸门:{Object.entries(s.queue.gates).map(([k, v]) => `${k} ${v.active}/${v.max}${v.waiting ? `(等待 ${v.waiting})` : ""}`).join(" · ")}
            </li>
          )}
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
