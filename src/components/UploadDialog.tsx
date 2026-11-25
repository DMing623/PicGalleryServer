"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useRouter } from "next/navigation";
import { memo, useEffect, useMemo, useRef, useState } from "react";
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
  readonly?: boolean;
}

interface Job {
  file: File;
  state: "wait" | "up" | "done" | "dup" | "err";
  pct: number;
  msg?: string;
  id?: string;
}

interface UrlJob {
  url: string;
  state: "wait" | "up" | "done" | "dup" | "err";
  msg?: string;
  id?: string;
}

const ROW_CLS = "flex items-center gap-2 rounded-lg border border-line/60 px-3 py-1.5";
const ROW_STYLE = { background: "color-mix(in srgb, var(--surface) 62%, transparent)" };

const FileJobRow = memo(function FileJobRow({ j }: { j: Job }) {
  return (
    <li className={ROW_CLS} style={ROW_STYLE}>
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
  );
});

function sendOne(file: File, query: string, onPct: (p: number) => void): Promise<{ status: string; id?: string; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/v1/media/upload?${query}`);
    let lastPct = -1;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      if (pct === 100 || pct - lastPct >= 2) {
        lastPct = pct;
        onPct(pct);
      }
    };
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
  const [mode, setMode] = useState<"file" | "url">("file");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [urlText, setUrlText] = useState("");
  const [urlJobs, setUrlJobs] = useState<UrlJob[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ albums: AlbumLite[] }>("/albums").then((r) => setAlbums(r.albums)).catch(() => undefined);
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const options = useMemo(() => {
    const byParent = new Map<string | null, AlbumLite[]>();
    for (const a of albums) {
      const p = a.parent ?? null;
      const list = byParent.get(p);
      if (list) list.push(a);
      else byParent.set(p, [a]);
    }
    const out: Array<{ a: AlbumLite; d: number }> = [];
    const walk = (parent: string | null, d: number) => {
      if (d > 10) return;
      const children = byParent.get(parent);
      if (!children) return;
      for (const a of children) {
        out.push({ a, d });
        walk(a.code, d + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [albums]);

  const target = albums.find((a) => a.code === album);
  // 只读挂载目录不允许写入,提前禁用上传按钮并给出说明,避免用户上传后才收到 403
  const readOnlyTarget = !!target?.readonly;
  const where = target
    ? target.kind === "mounted"
      ? `服务器目录 ${target.rootPath ?? "(挂载目录)"}${target.readonly ? "(只读)" : ""}`
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

  function query() {
    const q = new URLSearchParams();
    if (album) q.set("album", album);
    else q.set("storage", storage);
    q.set("duplicate", dupSkip ? "skip" : "keep");
    return q.toString();
  }

  async function start() {
    setRunning(true);
    const q = query();
    const queue = jobs.map((_, i) => i).filter((i) => jobs[i].state === "wait" || jobs[i].state === "err");
    let cursor = 0;
    const set = (i: number, patch: Partial<Job>) =>
      setJobs((js) => {
        const cur = js[i];
        if (!cur) return js;
        const next = js.slice();
        next[i] = { ...cur, ...patch };
        return next;
      });
    const worker = async () => {
      while (cursor < queue.length) {
        const i = queue[cursor++];
        set(i, { state: "up", pct: 0 });
        const r = await sendOne(jobs[i].file, q, (pct) => set(i, { pct }));
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

  const urls = urlText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  async function startUrls() {
    if (!urls.length) return;
    setRunning(true);
    setFinished(false);
    setUrlJobs(urls.map((url) => ({ url, state: "wait" })));
    try {
      const r = await api<{ results: Array<{ filename: string; status: string; id?: string; error?: string }> }>("/media/upload-url", {
        method: "POST",
        json: { urls, album: album || undefined, storage: album ? undefined : storage, duplicate: dupSkip ? "skip" : "keep" },
      });
      setUrlJobs(
        urls.map((url, i) => {
          const res = r.results[i];
          if (!res) return { url, state: "err", msg: "没有返回结果" };
          if (res.status === "created") return { url, state: "done", id: res.id };
          if (res.status === "duplicate") return { url, state: "dup", id: res.id, msg: "已存在,已跳过" };
          return { url, state: "err", msg: res.error };
        }),
      );
    } catch (e) {
      setUrlJobs(urls.map((url) => ({ url, state: "err", msg: (e as Error).message })));
    } finally {
      setRunning(false);
      setFinished(true);
      window.dispatchEvent(new Event("pgs:changed"));
      window.dispatchEvent(new Event("pgs:albums"));
    }
  }

  const done = jobs.filter((j) => j.state === "done").length;
  const pendingCount = jobs.filter((j) => j.state === "wait" || j.state === "err").length;
  const urlDone = urlJobs.filter((j) => j.state === "done").length;
  const urlFailed = urlJobs.filter((j) => j.state === "err").length;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center"
      style={{
        paddingTop: "calc(env(safe-area-inset-top, 0px) + 46px)",
        paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 58px)",
        paddingLeft: "0.5rem",
        paddingRight: "0.5rem",
      }}
      onClick={() => !running && onClose()}
    >
      <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" />
      <div
        className="glass-strong fade-in relative flex w-full max-w-2xl flex-col overflow-hidden rounded-3xl shadow-2xl"
        style={{ maxHeight: "100%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 px-5 pt-4">
          <h2 className="text-lg font-semibold">上传图片 / 视频</h2>
          <button className="btn ml-auto !py-1 text-xs" onClick={onClose} disabled={running}>
            ✕
          </button>
        </div>

        {/* 上传方式切换:本地文件(拖拽/点击) / 直链上传 */}
        <div className="flex shrink-0 gap-1.5 px-5 pt-2">
          <button
            className={`btn !py-1 text-xs ${mode === "file" ? "btn-primary" : ""}`}
            onClick={() => setMode("file")}
            disabled={running}
          >
            📁 本地文件
          </button>
          <button
            className={`btn !py-1 text-xs ${mode === "url" ? "btn-primary" : ""}`}
            onClick={() => setMode("url")}
            disabled={running}
          >
            🔗 直链上传
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3" style={{ WebkitOverflowScrolling: "touch" }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="muted mb-1 block text-xs">上传到相册</span>
              <select className="field" value={album} onChange={(e) => setAlbum(e.target.value)} disabled={running}>
                <option value="">未归类(收件箱)</option>
                {options.map(({ a, d }) => (
                  <option key={a.code} value={a.code}>
                    {"　".repeat(d)}{a.name} {a.kind === "mounted" ? (a.readonly ? "· 目录(只读)" : "· 目录") : a.storage === "s3" ? "· S3" : ""}
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
          {readOnlyTarget && (
            <p className="mt-2 rounded-xl p-2 text-xs" style={{ background: "rgba(220,38,38,.12)", color: "#b91c1c" }}>
              该挂载相册为只读,无法上传。如需写入,请让管理员在相册设置里关闭「只读」。
            </p>
          )}
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={dupSkip} onChange={(e) => setDupSkip(e.target.checked)} disabled={running} /> 跳过同一相册内的重复文件(按内容哈希)
          </label>

          {mode === "file" ? (
            <>
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
                <ul className="mt-3 space-y-1 text-sm">
                  {jobs.map((j, i) => (
                    <FileJobRow key={i} j={j} />
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <textarea
                className="field mt-3 min-h-[7rem] resize-y font-mono text-[12px] leading-relaxed"
                placeholder={"一行一个图片/视频直链,例如:\nimages-assets.nasa.gov/image/carina_nebula/carina_nebula~orig.png\nhttps://example.com/video.mp4"}
                value={urlText}
                onChange={(e) => setUrlText(e.target.value)}
                disabled={running}
              />
              <p className="muted mt-1 text-xs">
                支持图片与视频直链,可省略 https://;一次最多 50 条。服务器会下载后按上面的相册/存储设置入库。
              </p>
              {urlJobs.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {urlJobs.map((j, i) => (
                    <li key={i} className={ROW_CLS} style={ROW_STYLE}>
                      <span className="min-w-0 flex-1 truncate" title={j.url}>{j.url}</span>
                      <span className="w-20 shrink-0 text-right text-xs">
                        {j.state === "wait" && "等待"}
                        {j.state === "up" && "下载中…"}
                        {j.state === "done" && <span style={{ color: "var(--accent)" }}>✓ 完成</span>}
                        {j.state === "dup" && <span className="muted">已存在</span>}
                        {j.state === "err" && <span className="text-red-600" title={j.msg}>✗ 失败</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {finished && mode === "file" && jobs.length > 0 && (
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
          {finished && mode === "url" && urlJobs.length > 0 && (
            <div className="mt-3 rounded-xl p-3 text-sm" style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)" }}>
              ✅ 直链入库完成:成功 {urlDone} 条{urlFailed ? `,失败 ${urlFailed} 条` : ""}。目标「{target?.name ?? "未归类(收件箱)"}」。
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
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line/60 px-5 py-3" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom, 0px))" }}>
          <span className="muted text-xs">
            {mode === "file"
              ? jobs.length
                ? `共 ${jobs.length} 个文件`
                : "支持图片与视频,可多选"
              : urls.length
                ? `共 ${urls.length} 条链接`
                : "一行一个直链"}
          </span>
          <button className="btn ml-auto" onClick={() => (mode === "file" ? setJobs([]) : setUrlJobs([]))} disabled={running || (mode === "file" ? !jobs.length : !urlJobs.length)}>
            清空
          </button>
          {mode === "file" ? (
            <button className="btn btn-primary" onClick={start} disabled={running || !pendingCount || readOnlyTarget}>
              {running ? "上传中…" : `开始上传${pendingCount ? ` (${pendingCount})` : ""}`}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={startUrls} disabled={running || !urls.length || readOnlyTarget}>
              {running ? "下载中…" : `开始入库${urls.length ? ` (${urls.length})` : ""}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
