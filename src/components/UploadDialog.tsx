"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { bytes } from "@/lib/format";
import { useApp } from "./AppProvider";

interface AlbumLite {
  code: string;
  name: string;
  parent: string | null;
  kind: string;
  storage: string;
  rootPath: string | null;
}

interface Job {
  file: File;
  state: "wait" | "up" | "done" | "dup" | "err";
  pct: number;
  msg?: string;
  id?: string;
}

function sendOne(file: File, query: string, onPct: (p: number) => void): Promise<{ status: string; id?: string; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/v1/media/upload?${query}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onPct(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      try {
        const r = JSON.parse(xhr.responseText);
        const first = r?.data?.results?.[0];
        if (first) resolve({ status: first.status, id: first.id, error: first.error });
        else resolve({ status: "error", error: r?.error?.message ?? `HTTP ${xhr.status}` });
      } catch {
        resolve({ status: "error", error: `HTTP ${xhr.status}` });
      }
    };
    xhr.onerror = () => resolve({ status: "error", error: "网络错误" });
    xhr.onabort = () => resolve({ status: "error", error: "已取消" });
    xhr.ontimeout = () => resolve({ status: "error", error: "上传超时" });
    const fd = new FormData();
    fd.append("file", file, file.name);
    xhr.send(fd);
  });
}

export default function UploadDialog({ defaultAlbum, onClose }: { defaultAlbum: string | null; onClose: () => void }) {
  const { me } = useApp();
  const router = useRouter();
  const [albums, setAlbums] = useState<AlbumLite[]>([]);
  const [album, setAlbum] = useState(defaultAlbum ?? "");
  const [storage, setStorage] = useState("local");
  const [conc, setConc] = useState(3);
  const [dupSkip, setDupSkip] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ albums: AlbumLite[] }>("/albums").then((r) => setAlbums(r.albums)).catch(() => undefined);
  }, []);

  const options = useMemo(() => {
    const byCode = new Map(albums.map((a) => [a.code, a]));
    const depth = (a: AlbumLite) => {
      let n = 0;
      let c: AlbumLite | undefined = a;
      while (c?.parent && n < 10) {
        c = byCode.get(c.parent);
        n++;
      }
      return n;
    };
    // 按树顺序展开
    const out: Array<{ a: AlbumLite; d: number }> = [];
    const walk = (parent: string | null) =>
      albums.filter((a) => a.parent === parent).forEach((a) => {
        out.push({ a, d: depth(a) });
        walk(a.code);
      });
    walk(null);
    return out;
  }, [albums]);

  const target = albums.find((a) => a.code === album);
  const where = target
    ? target.kind === "mounted"
      ? `服务器目录 ${target.rootPath ?? "(挂载目录)"}`
      : target.storage === "s3"
        ? "对象存储 (S3)"
        : `数据目录 albums/${target.code}/`
    : storage === "s3"
      ? "对象存储 (S3) · 未归类收件箱"
      : "数据目录 albums/_inbox/ · 未归类收件箱(仅登录用户可见)";

  function add(list: FileList | File[]) {
    const ok = Array.from(list).filter((f) => /^(image|video)\//.test(f.type) || /\.(heic|heif|hif|avif|mkv|avi|wmv|flv|3gp|ts)$/i.test(f.name));
    setJobs((j) => [...j, ...ok.map((file) => ({ file, state: "wait" as const, pct: 0 }))]);
    setFinished(false);
  }

  async function start() {
    setRunning(true);
    const q = new URLSearchParams();
    if (album) q.set("album", album);
    else q.set("storage", storage);
    q.set("duplicate", dupSkip ? "skip" : "keep");
    const query = q.toString();
    const queue = jobs.map((_, i) => i).filter((i) => jobs[i].state === "wait" || jobs[i].state === "err");
    let cursor = 0;
    const set = (i: number, patch: Partial<Job>) => setJobs((js) => js.map((j, k) => (k === i ? { ...j, ...patch } : j)));
    const worker = async () => {
      while (cursor < queue.length) {
        const i = queue[cursor++];
        set(i, { state: "up", pct: 0 });
        const r = await sendOne(jobs[i].file, query, (pct) => set(i, { pct }));
        if (r.status === "created") set(i, { state: "done", pct: 100, id: r.id });
        else if (r.status === "duplicate") set(i, { state: "dup", pct: 100, id: r.id, msg: "已存在,已跳过" });
        else set(i, { state: "err", msg: r.error });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(conc, 10)) }, worker));
    setRunning(false);
    setFinished(true);
    window.dispatchEvent(new Event("pgs:changed"));
    window.dispatchEvent(new Event("pgs:albums"));
  }

  const done = jobs.filter((j) => j.state === "done").length;
  const pendingCount = jobs.filter((j) => j.state === "wait" || j.state === "err").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 backdrop-blur-sm" onClick={() => !running && onClose()}>
      <div className="glass-strong fade-in flex max-h-[90vh] w-full max-w-2xl flex-col rounded-3xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center">
          <h2 className="text-lg font-semibold">上传图片 / 视频</h2>
          <button className="btn ml-auto" onClick={onClose} disabled={running}>✕</button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="muted mb-1 block text-xs">上传到相册</span>
            <select className="field" value={album} onChange={(e) => setAlbum(e.target.value)} disabled={running}>
              <option value="">未归类(收件箱)</option>
              {options.map(({ a, d }) => (
                <option key={a.code} value={a.code}>
                  {"　".repeat(d)}{a.name} {a.kind === "mounted" ? "· 目录" : a.storage === "s3" ? "· S3" : ""}
                </option>
              ))}
            </select>
          </label>
          {!album && me?.features.s3 ? (
            <label className="text-sm">
              <span className="muted mb-1 block text-xs">存储位置</span>
              <select className="field" value={storage} onChange={(e) => setStorage(e.target.value)} disabled={running}>
                <option value="local">本地数据目录</option>
                <option value="s3">对象存储 S3</option>
              </select>
            </label>
          ) : (
            <label className="text-sm">
              <span className="muted mb-1 block text-xs">并发上传数 (1-10)</span>
              <input className="field" type="number" min={1} max={10} value={conc} onChange={(e) => setConc(Number(e.target.value) || 1)} disabled={running} />
            </label>
          )}
        </div>
        <p className="muted mt-2 text-xs">📍 文件将保存到:{where}</p>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={dupSkip} onChange={(e) => setDupSkip(e.target.checked)} disabled={running} /> 跳过同一相册内的重复文件(按内容哈希)
        </label>

        <div
          className="mt-3 cursor-pointer rounded-2xl border-2 border-dashed border-line p-6 text-center text-sm transition hover:border-[var(--accent)]"
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            add(e.dataTransfer.files);
          }}
        >
          拖拽文件到这里,或点击选择
          <input
            ref={input}
            type="file"
            multiple
            accept="image/*,video/*,.heic,.heif,.mkv,.avi"
            hidden
            /* 阻止冒泡到外层 div 的 onClick,否则会再次触发 input.click() 导致文件选择器重复弹出 */
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              e.target.files && add(e.target.files);
              // 清空 value,保证再次选择同一批文件也能触发 change
              e.target.value = "";
            }}
          />
        </div>

        {jobs.length > 0 && (
          <ul className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto text-sm">
            {jobs.map((j, i) => (
              <li key={i} className="glass flex items-center gap-2 rounded-lg px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate">{j.file.name}</span>
                <span className="muted text-xs">{bytes(j.file.size)}</span>
                <span className="w-24 text-right text-xs">
                  {j.state === "wait" && "等待"}
                  {j.state === "up" && `${j.pct}%`}
                  {j.state === "done" && <span style={{ color: "var(--accent)" }}>✓ 完成</span>}
                  {j.state === "dup" && <span className="muted">已存在</span>}
                  {j.state === "err" && <span className="text-red-600" title={j.msg}>✗ 失败</span>}
                </span>
              </li>
            ))}
          </ul>
        )}

        {finished && (
          <div className="mt-3 rounded-xl p-3 text-sm" style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)" }}>
            ✅ 已上传 {done} 个文件到「{target?.name ?? "未归类(收件箱)"}」。缩略图与元数据会在后台生成。
            <button
              className="btn btn-primary ml-2 !py-0.5 text-xs"
              onClick={() => {
                onClose();
                router.push(album ? `/albums/${album}` : "/");
              }}
            >
              查看
            </button>
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <span className="muted text-xs">{jobs.length ? `共 ${jobs.length} 个文件` : "支持图片与视频,可多选"}</span>
          <button className="btn ml-auto" onClick={() => setJobs([])} disabled={running || !jobs.length}>清空</button>
          <button className="btn btn-primary" onClick={start} disabled={running || !pendingCount}>
            {running ? "上传中…" : `开始上传${pendingCount ? ` (${pendingCount})` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
