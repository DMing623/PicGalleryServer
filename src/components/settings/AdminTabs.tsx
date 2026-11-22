"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { bytes, dateTime } from "@/lib/format";
import AlbumActions, { type AlbumDto } from "../AlbumActions";
import { useApp } from "../AppProvider";
import { useDialog } from "../DialogProvider";

/* ============ 相册管理 + 目录挂载 ============ */

function MountDialog({ albums, onClose, onDone }: { albums: AlbumDto[]; onClose: () => void; onDone: () => void }) {
  const [path, setPath] = useState("/");
  const [dirs, setDirs] = useState<string[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [parentAlbum, setParentAlbum] = useState("");
  const [recursive, setRecursive] = useState(true);
  const [visibility, setVisibility] = useState("private");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const browse = useCallback(async (p: string) => {
    try {
      const r = await api<{ path: string; parent: string | null; dirs: string[] }>(`/fs/browse?path=${encodeURIComponent(p)}`);
      setPath(r.path);
      setDirs(r.dirs);
      setParent(r.parent);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void browse("/");
  }, [browse]);

  async function mount() {
    setBusy(true);
    try {
      await api("/albums/mount", { method: "POST", json: { path, name: name || undefined, parent: parentAlbum || null, recursive, visibility } });
      onDone();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-strong fade-in flex max-h-[90vh] w-full max-w-xl flex-col rounded-3xl p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-lg font-semibold">挂载服务器目录为相册</h2>
        <p className="muted mb-3 text-xs">目录内的图片/视频会就地建立索引(不复制原文件);子目录自动生成嵌套子相册。</p>
        <div className="flex gap-2">
          <input className="field" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && browse(path)} placeholder="/data/photos" />
          <button className="btn" onClick={() => browse(path)}>浏览</button>
        </div>
        <div className="glass mt-2 max-h-48 min-h-24 overflow-y-auto rounded-xl p-1 text-sm">
          {parent && <button className="block w-full rounded-lg px-2 py-1 text-left hover:bg-black/5" onClick={() => browse(parent)}>⬆ 上级目录</button>}
          {dirs.map((d) => (
            <button key={d} className="block w-full truncate rounded-lg px-2 py-1 text-left hover:bg-black/5" onClick={() => browse(`${path === "/" ? "" : path}/${d}`)}>
              📁 {d}
            </button>
          ))}
          {!dirs.length && <p className="muted p-2 text-xs">没有子目录</p>}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="muted mb-1 block text-xs">相册名称(默认取目录名)</span>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="muted mb-1 block text-xs">放在哪个相册下(嵌套)</span>
            <select className="field" value={parentAlbum} onChange={(e) => setParentAlbum(e.target.value)}>
              <option value="">顶层</option>
              {albums.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="muted mb-1 block text-xs">可见性</span>
            <select className="field" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="private">私有(仅登录用户)</option>
              <option value="public">公开(游客可见缩略图)</option>
            </select>
          </label>
          <label className="mt-5 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} /> 子目录生成嵌套相册
          </label>
        </div>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        <div className="mt-4 flex gap-2">
          <span className="muted min-w-0 flex-1 truncate self-center text-xs">将挂载:{path}</span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy} onClick={mount}>挂载并扫描</button>
        </div>
      </div>
    </div>
  );
}

export function AlbumManager() {
  const { can, me } = useApp();
  const dlg = useDialog();
  const [albums, setAlbums] = useState<AlbumDto[]>([]);
  const [mountOpen, setMountOpen] = useState(false);
  const [err, setErr] = useState("");
  /** 当前所在文件夹路径(相册代码链);空 = 顶层 */
  const [path, setPath] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setAlbums((await api<{ albums: AlbumDto[] }>("/albums")).albums);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const h = () => void load();
    window.addEventListener("pgs:albums", h);
    const t = setInterval(load, 5000);
    return () => {
      window.removeEventListener("pgs:albums", h);
      clearInterval(t);
    };
  }, [load]);

  const byCode = useMemo(() => new Map(albums.map((a) => [a.code, a])), [albums]);

  /** 只显示当前层级的相册(子相册默认隐藏,点文件夹图标进入) */
  const current = useMemo(() => {
    const parent = path.length ? path[path.length - 1] : null;
    return albums.filter((a) => (a.parent ?? null) === parent);
  }, [albums, path]);

  const crumbs = useMemo(() => path.map((c) => byCode.get(c)).filter((a): a is AlbumDto => !!a), [path, byCode]);

  const childCount = useCallback((code: string) => albums.filter((a) => a.parent === code).length, [albums]);

  async function create() {
    const name = await dlg.prompt({ title: "新建相册", label: "相册名称", placeholder: "例如:旅行", confirmText: "创建", validate: (v) => (v ? (v.length > 80 ? "名称过长(最多 80 字)" : null) : "请输入相册名称") });
    if (!name) return;
    let storage = "local";
    if (me?.features.s3) {
      const pick = await dlg.choose({ title: "选择存储位置", message: "新相册的原文件存放在哪里?", options: [{ value: "local", label: "本地数据目录", kind: "primary" }, { value: "s3", label: "对象存储 S3" }] });
      if (!pick) return;
      storage = pick;
    }
    const parent = path.length ? path[path.length - 1] : null;
    try {
      await api("/albums", { method: "POST", json: { name, storage, visibility: "private", parent } });
      await load();
    } catch (e) {
      await dlg.alert((e as Error).message, "操作失败");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" onClick={create}>＋ 新建受管相册</button>
        {can("album.mount") && <button className="btn" onClick={() => setMountOpen(true)}>📂 挂载服务器目录</button>}
        <span className="muted text-xs">受管相册 = 文件保存在数据目录 / S3;挂载相册 = 就地索引服务器上的已有目录。</span>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* 文件夹式导航:只显示当前层级的相册,子相册需点击文件夹图标进入 */}
      <div className="glass flex flex-wrap items-center gap-1 rounded-2xl px-3 py-2 text-sm">
        <button className="hover:underline" onClick={() => setPath([])}>全部相册</button>
        {crumbs.map((c, i) => (
          <span key={c.code} className="flex items-center gap-1">
            <span className="muted">/</span>
            <button className="hover:underline" onClick={() => setPath(path.slice(0, i + 1))}>{c.name}</button>
          </span>
        ))}
        {path.length > 0 && (
          <button className="btn ml-auto !px-2 !py-0.5 text-xs" onClick={() => setPath(path.slice(0, -1))}>⬆ 上一级</button>
        )}
      </div>

      <div className="space-y-2">
        {current.map((a) => {
          const kids = childCount(a.code);
          return (
            <div key={a.code} className="glass rounded-2xl p-3">
              <div className="flex flex-wrap items-center gap-2">
                {kids > 0 ? (
                  <button
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-md hover:bg-black/10"
                    title={`进入「${a.name}」查看 ${kids} 个子相册`}
                    aria-label={`进入 ${a.name}`}
                    onClick={() => setPath([...path, a.code])}
                  >
                    📁
                  </button>
                ) : (
                  <span className="grid h-6 w-6 shrink-0 place-items-center opacity-45" title="没有子相册">📄</span>
                )}
                <span className="font-medium">{a.name}</span>
                <span className="chip">{a.visibility === "public" ? "公开" : "私有"}</span>
                <span className="chip">{a.kind === "mounted" ? "挂载" : a.storage === "s3" ? "受管·S3" : "受管·本地"}</span>
                <code className="muted text-xs">{a.code}</code>
                <span className="muted text-xs">{a.counts.media} 项 · {bytes(a.counts.size)}</span>
                {kids > 0 && (
                  <button className="chip cursor-pointer" onClick={() => setPath([...path, a.code])}>{kids} 个子相册 ›</button>
                )}
                {a.counts.pending > 0 && <span className="chip">处理中 {a.counts.pending}</span>}
                {a.counts.failed > 0 && <span className="chip" style={{ color: "#c0392b" }}>失败 {a.counts.failed}</span>}
              </div>
              {a.rootPath && <p className="muted mt-0.5 break-all text-xs">📂 {a.rootPath}{a.lastScanAt && ` · 上次扫描 ${dateTime(a.lastScanAt)}`}</p>}
              <div className="mt-2"><AlbumActions album={a} onChanged={load} /></div>
            </div>
          );
        })}
        {!current.length && <p className="muted text-sm">{path.length ? "该相册下没有子相册。" : "还没有相册。"}</p>}
      </div>
      {mountOpen && <MountDialog albums={albums} onClose={() => setMountOpen(false)} onDone={load} />}
    </div>
  );
}

/* ============ 下载密钥 ============ */

interface KeyRow { id: string; hint: string; label: string; expiresAt: string | null; createdAt: string; lastUsedAt: string | null; useCount: number; expired: boolean }

export function KeysTab() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [expires, setExpires] = useState("never");
  const [hours, setHours] = useState(72);
  const [created, setCreated] = useState("");
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => api<{ keys: KeyRow[] }>("/keys").then((r) => setKeys(r.keys)).catch((e) => setErr(e.message)), []);
  useEffect(() => void load(), [load]);

  async function create() {
    setErr("");
    try {
      const r = await api<{ key: string }>("/keys", { method: "POST", json: { key: key || undefined, label, expires, ttlHours: expires === "custom" ? hours : undefined } });
      setCreated(r.key);
      setKey("");
      setLabel("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <section className="glass rounded-2xl p-5">
        <h2 className="mb-1 font-semibold">设置下载密钥</h2>
        <p className="muted mb-3 text-xs">游客通过文件链接只能获得缩略图/预览图;在链接后追加 <code>?key=密钥</code> 才能下载服务器原图/原分辨率视频。选择 24 小时后过期的密钥会被自动删除。</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <input className="field sm:col-span-2" placeholder="自定义密钥(留空自动生成,8-128 位字母数字_-)" value={key} onChange={(e) => setKey(e.target.value)} />
          <input className="field" placeholder="备注标签(可选)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <select className="field" value={expires} onChange={(e) => setExpires(e.target.value)}>
            <option value="never">永不过期</option>
            <option value="24h">24 小时后过期并删除</option>
            <option value="custom">自定义小时数</option>
          </select>
          {expires === "custom" && <input className="field" type="number" min={1} value={hours} onChange={(e) => setHours(Number(e.target.value))} />}
        </div>
        <button className="btn btn-primary mt-3" onClick={create}>创建 / 更新密钥</button>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        {created && (
          <div className="mt-3 rounded-xl p-3 text-sm" style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)" }}>
            密钥(仅此一次显示,请妥善保存):<code className="select-all break-all font-semibold">{created}</code>
            <button
              className="btn ml-2 !py-0.5 text-xs"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* 剪贴板不可用时静默失败 */
                }
              }}
            >
              {copied ? "✓ 已复制" : "复制"}
            </button>
          </div>
        )}
      </section>
      <section className="glass rounded-2xl p-5">
        <h2 className="mb-2 font-semibold">已有密钥</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="muted text-xs"><tr><th className="py-1">提示</th><th>标签</th><th>过期时间</th><th>使用次数</th><th>最近使用</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-t border-line/40">
                  <td className="py-1.5"><code>{k.hint}</code></td>
                  <td>{k.label || "—"}</td>
                  <td>{k.expiresAt ? (k.expired ? "已过期" : dateTime(k.expiresAt)) : "永不过期"}</td>
                  <td>{k.useCount}</td>
                  <td>{k.lastUsedAt ? dateTime(k.lastUsedAt) : "—"}</td>
                  <td className="text-right"><button className="btn btn-danger !py-0.5 text-xs" onClick={async () => { await api(`/keys/${k.id}`, { method: "DELETE" }); await load(); }}>删除</button></td>
                </tr>
              ))}
              {!keys.length && <tr><td colSpan={6} className="muted py-3 text-center">暂无密钥</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/* ============ 用户 ============ */

interface UserRow { id: string; username: string; role: string; disabled: boolean; source: string; createdAt: string; lastLoginAt: string | null }

const ROLE_DESC: Record<string, string> = {
  admin: "最高权限(等同环境变量管理员)",
  manager: "管理相册/文件/备注,可直接下载原文件,不可改设置与用户",
  uploader: "可上传、可浏览私有相册缩略图,不可下载原文件",
  viewer: "只读,可浏览私有相册缩略图,不可下载原文件",
};

export function UsersTab() {
  const dlg = useDialog();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [f, setF] = useState({ username: "", password: "", role: "viewer" });
  const [err, setErr] = useState("");

  const load = useCallback(() => api<{ users: UserRow[]; roles: string[] }>("/users").then((r) => (setUsers(r.users), setRoles(r.roles))).catch((e) => setErr(e.message)), []);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setErr("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <section className="glass rounded-2xl p-5">
        <h2 className="mb-3 font-semibold">添加用户</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <input className="field" placeholder="用户名" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
          <input className="field" type="password" placeholder="密码(至少 8 位)" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <select className="field" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{r}</option>)}</select>
          <button className="btn btn-primary" onClick={() => act(async () => { await api("/users", { method: "POST", json: f }); setF({ username: "", password: "", role: "viewer" }); })}>添加</button>
        </div>
        <ul className="muted mt-3 space-y-0.5 text-xs">{Object.entries(ROLE_DESC).map(([k, v]) => <li key={k}><b>{k}</b>:{v}</li>)}</ul>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      </section>
      <section className="glass rounded-2xl p-5">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="muted text-xs"><tr><th className="py-1">用户名</th><th>角色</th><th>来源</th><th>最近登录</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-line/40">
                  <td className="py-1.5">{u.username} {u.disabled && <span className="chip">已禁用</span>}</td>
                  <td>
                    {u.source === "env" ? <span className="chip">{u.role}</span> : (
                      <select className="field !w-auto !py-0.5" value={u.role} onChange={(e) => act(() => api(`/users/${u.id}`, { method: "PATCH", json: { role: e.target.value } }))}>
                        {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    )}
                  </td>
                  <td>{u.source === "env" ? "环境变量" : "接口创建"}</td>
                  <td>{u.lastLoginAt ? dateTime(u.lastLoginAt) : "—"}</td>
                  <td className="space-x-1 text-right">
                    {u.source !== "env" && (
                      <>
                        <button className="btn !py-0.5 text-xs" onClick={async () => { const p = await dlg.prompt({ title: `重置 ${u.username} 的密码`, label: "新密码(至少 8 位)", password: true, confirmText: "重置", validate: (v) => (v.length < 8 ? "密码至少 8 位" : v.length > 200 ? "密码过长" : null) }); if (p) void act(() => api(`/users/${u.id}`, { method: "PATCH", json: { password: p } })); }}>重置密码</button>
                        <button className="btn !py-0.5 text-xs" onClick={() => act(() => api(`/users/${u.id}`, { method: "PATCH", json: { disabled: !u.disabled } }))}>{u.disabled ? "启用" : "禁用"}</button>
                        <button className="btn btn-danger !py-0.5 text-xs" onClick={async () => { if (await dlg.confirm({ title: "删除用户", message: `确定删除用户「${u.username}」吗?`, confirmText: "删除", danger: true })) void act(() => api(`/users/${u.id}`, { method: "DELETE" })); }}>删除</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/* ============ 删除黑名单 ============ */

interface BlockRow {
  id: string;
  mediaId: string | null;
  albumId: string | null;
  albumCode: string | null;
  albumName: string | null;
  kind: string;
  filename: string;
  mime: string;
  size: number;
  storage: string;
  storageKey: string;
  note: string;
  createdBy: string | null;
  createdAt: string;
}

export function BlocklistTab() {
  const dlg = useDialog();
  const [items, setItems] = useState<BlockRow[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [q, setQ] = useState("");

  const load = useCallback(() => {
    api<{ items: BlockRow[] }>("/blocklist")
      .then((r) => {
        setItems(r.items);
        setErr("");
      })
      .catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(() => void load(), [load]);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? items.filter((i) => i.filename.toLowerCase().includes(k) || i.storageKey.toLowerCase().includes(k)) : items;
  }, [items, q]);

  async function restore(it: BlockRow) {
    setBusy(it.id);
    try {
      await api(`/blocklist/${it.id}/restore`, { method: "POST" });
      await load();
      window.dispatchEvent(new Event("pgs:albums"));
      window.dispatchEvent(new Event("pgs:changed"));
    } catch (e) {
      await dlg.alert((e as Error).message, "解除失败");
    } finally {
      setBusy("");
    }
  }

  async function purge(it: BlockRow) {
    if (!(await dlg.confirm({ title: "彻底删除源文件", message: `将从服务器删除源文件:\n${it.storageKey}\n\n此操作不可恢复。`, confirmText: "彻底删除", danger: true }))) return;
    setBusy(it.id);
    try {
      await api(`/blocklist/${it.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      await dlg.alert((e as Error).message, "删除失败");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-3">
      <section className="glass rounded-2xl p-5">
        <h2 className="mb-1 font-semibold">删除黑名单</h2>
        <p className="muted text-xs leading-relaxed">
          在图片/视频详情页删除时,若未勾选「同时删除服务器上的原文件」,记录会出现在这里:源文件仍保留在服务器上,但被本项目排除,挂载目录重新扫描也不会再入库。
          点击「解除」即可恢复记录并重新生成缩略图/预览图;点击「彻底删除」才会真正移除源文件。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input className="field min-w-0 flex-1" placeholder="按文件名或路径筛选…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={load}>↻ 刷新</button>
          <span className="muted text-xs">{items.length} 条</span>
        </div>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      </section>

      <div className="space-y-2">
        {shown.map((it) => (
          <div key={it.id} className="glass rounded-2xl p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-all">{it.filename}</span>
              <span className="chip">{it.kind === "video" ? "视频" : "图片"}</span>
              <span className="chip">{it.storage}</span>
              <span className="muted text-xs">{bytes(it.size)}</span>
              {it.albumName || it.albumCode ? <span className="chip">原相册:{it.albumName ?? it.albumCode}</span> : <span className="chip">未归类</span>}
            </div>
            <p className="muted mt-0.5 break-all text-xs">{it.storageKey}</p>
            <p className="muted mt-0.5 text-xs">加入时间 {dateTime(it.createdAt)}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button className="btn btn-primary !py-1 text-xs" disabled={busy === it.id} onClick={() => restore(it)}>↩ 解除黑名单</button>
              <button className="btn btn-danger !py-1 text-xs" disabled={busy === it.id} onClick={() => purge(it)}>🗑 彻底删除源文件</button>
            </div>
          </div>
        ))}
        {!shown.length && <p className="muted text-sm">{items.length ? "没有匹配的记录。" : "黑名单为空。"}</p>}
      </div>
    </div>
  );
}
