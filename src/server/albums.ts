// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { albums, media } from "@/db/schema";
import { can, type AuthUser } from "./auth";
import { addToBlocklist, blockedExtKeys } from "./blocklist";
import { config, dirs } from "./config";
import { E } from "./http";
import { removeDerived } from "./media/derive";
import { detectKind, randomId } from "./media/types";
import { enqueue } from "./queue";
import { driverFor, isStorageCode, s3Available } from "./storage";
import { getSite } from "./settings";

/**
 * 相册分类:树结构、可见性、挂载目录扫描。
 * 相册代码: alb_xxxxxxxx = 受管相册(数据存放于 DATA_DIR 或 S3); dir_xxxxxxxx = 挂载的服务器绝对路径目录。
 * 可见性: 游客仅可见 "自身及全部祖先均为 public" 的相册;登录用户(任意角色)可见全部。
 */

export type AlbumRow = typeof albums.$inferSelect;

interface Tree {
  rows: AlbumRow[];
  byId: Map<string, AlbumRow>;
  byCode: Map<string, AlbumRow>;
  children: Map<string | null, AlbumRow[]>;
  at: number;
}

let tree: Tree | null = null;
let stats: { at: number; counts: Map<string, AlbumCounts>; covers: Map<string, string> } | null = null;

export function invalidateAlbums() {
  tree = null;
  stats = null;
}

export async function loadTree(): Promise<Tree> {
  if (tree && Date.now() - tree.at < 10_000) return tree;
  const rows = await db.select().from(albums);
  rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "zh"));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const children = new Map<string | null, AlbumRow[]>();
  for (const r of rows) {
    const k = r.parentId && byId.has(r.parentId) ? r.parentId : null;
    (children.get(k) ?? children.set(k, []).get(k)!).push(r);
  }
  tree = { rows, byId, byCode, children, at: Date.now() };
  return tree;
}

export function effectivelyPublic(t: Tree, a: AlbumRow): boolean {
  let cur: AlbumRow | undefined = a;
  let guard = 0;
  while (cur && guard++ < 64) {
    if (cur.visibility !== "public") return false;
    cur = cur.parentId ? t.byId.get(cur.parentId) : undefined;
  }
  return true;
}

export function descendants(t: Tree, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    for (const c of t.children.get(cur) ?? []) stack.push(c.id);
  }
  return out;
}

export function breadcrumbs(t: Tree, a: AlbumRow): Array<{ code: string; name: string }> {
  const out: Array<{ code: string; name: string }> = [];
  let cur: AlbumRow | undefined = a;
  let guard = 0;
  while (cur && guard++ < 64) {
    out.unshift({ code: cur.code, name: cur.name });
    cur = cur.parentId ? t.byId.get(cur.parentId) : undefined;
  }
  return out;
}

/** 当前访问者可见的相册 id 集合;null 表示不受限(含未归类媒体) */
export async function visibleIds(user: AuthUser | null): Promise<{ t: Tree; allowed: Set<string> | null }> {
  const t = await loadTree();
  if (user) return { t, allowed: null };
  const site = await getSite();
  if (!site.guestBrowse) return { t, allowed: new Set() };
  return { t, allowed: new Set(t.rows.filter((r) => effectivelyPublic(t, r)).map((r) => r.id)) };
}

/** 按代码取相册并校验可见性;不可见一律 404(不泄露存在性) */
export async function resolveAlbum(code: string, user: AuthUser | null): Promise<{ t: Tree; album: AlbumRow }> {
  const { t, allowed } = await visibleIds(user);
  const album = t.byCode.get(code);
  if (!album || (allowed && !allowed.has(album.id))) throw E.notFound("相册不存在");
  return { t, album };
}

/** 展开 album(+后代) 的 id 列表,并与可见集合求交 */
export function scopeIds(t: Tree, album: AlbumRow, recursive: boolean, allowed: Set<string> | null): string[] {
  const ids = recursive ? descendants(t, album.id) : [album.id];
  return allowed ? ids.filter((i) => allowed.has(i)) : ids;
}

/* ---------- 统计 ---------- */

interface AlbumCounts {
  media: number;
  size: number;
  pending: number;
  failed: number;
  images: number;
  videos: number;
}

async function loadStats() {
  if (stats && Date.now() - stats.at < 5000) return stats;
  const rows = await db.execute(sql`
    SELECT album_id,
           count(*)::int AS media,
           coalesce(sum(size),0)::float8 AS size,
           count(*) FILTER (WHERE status='pending')::int AS pending,
           count(*) FILTER (WHERE status='failed')::int AS failed,
           count(*) FILTER (WHERE kind='image')::int AS images,
           count(*) FILTER (WHERE kind='video')::int AS videos
    FROM pgs_media WHERE album_id IS NOT NULL GROUP BY album_id`);
  const counts = new Map<string, AlbumCounts>();
  for (const r of rows.rows as Array<Record<string, unknown>>) {
    counts.set(String(r.album_id), {
      media: Number(r.media), size: Number(r.size), pending: Number(r.pending), failed: Number(r.failed),
      images: Number(r.images), videos: Number(r.videos),
    });
  }
  const cov = await db.execute(sql`
    SELECT DISTINCT ON (album_id) album_id, id FROM pgs_media
    WHERE album_id IS NOT NULL AND status='ready' ORDER BY album_id, sort_at DESC`);
  const covers = new Map<string, string>();
  for (const r of cov.rows as Array<Record<string, unknown>>) covers.set(String(r.album_id), String(r.id));
  stats = { at: Date.now(), counts, covers };
  return stats;
}

const ZERO: AlbumCounts = { media: 0, size: 0, pending: 0, failed: 0, images: 0, videos: 0 };

export async function unsortedCount(): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM pgs_media WHERE album_id IS NULL`);
  return Number((r.rows[0] as { n: number }).n);
}

export async function albumDtos(
  rows: AlbumRow[],
  t: Tree,
  user: AuthUser | null,
  allowed: Set<string> | null,
) {
  const st = await loadStats();
  const showPath = can(user, "album.mount");
  const coverOf = (a: AlbumRow, depth = 0): string | null => {
    if (a.coverMediaId) return a.coverMediaId;
    const own = st.covers.get(a.id);
    if (own) return own;
    if (depth > 6) return null;
    for (const c of t.children.get(a.id) ?? []) {
      if (allowed && !allowed.has(c.id)) continue;
      const v = coverOf(c, depth + 1);
      if (v) return v;
    }
    return null;
  };
  return rows.map((a) => {
    const ids = scopeIds(t, a, true, allowed);
    const total = ids.reduce(
      (acc, id) => {
        const c = st.counts.get(id) ?? ZERO;
        return { media: acc.media + c.media, size: acc.size + c.size };
      },
      { media: 0, size: 0 },
    );
    const own = st.counts.get(a.id) ?? ZERO;
    const parent = a.parentId ? t.byId.get(a.parentId) : undefined;
    return {
      code: a.code,
      name: a.name,
      description: a.description,
      parent: parent?.code ?? null,
      kind: a.kind,
      storage: a.storage,
      rootPath: showPath ? a.rootPath : null,
      visibility: a.visibility,
      effectivePublic: effectivelyPublic(t, a),
      coverId: coverOf(a),
      sortOrder: a.sortOrder,
      counts: {
        media: own.media, images: own.images, videos: own.videos, size: own.size,
        mediaTotal: total.media, sizeTotal: total.size,
        pending: own.pending, failed: own.failed,
        children: (t.children.get(a.id) ?? []).filter((c) => !allowed || allowed.has(c.id)).length,
      },
      lastScanAt: a.lastScanAt,
      createdAt: a.createdAt,
    };
  });
}

/** 列出相册。parent: undefined=全部(平铺) | null=顶层 | code=某相册的直接子相册 */
export async function listAlbums(user: AuthUser | null, parent?: string | null) {
  const { t, allowed } = await visibleIds(user);
  let rows = t.rows;
  if (parent === null) rows = rows.filter((r) => !r.parentId || !t.byId.has(r.parentId));
  else if (typeof parent === "string") {
    const p = t.byCode.get(parent);
    if (!p || (allowed && !allowed.has(p.id))) throw E.notFound("父相册不存在");
    rows = t.children.get(p.id) ?? [];
  }
  if (allowed) rows = rows.filter((r) => allowed.has(r.id));
  return albumDtos(rows, t, user, allowed);
}

export async function albumDetail(code: string, user: AuthUser | null) {
  const { t, album } = await resolveAlbum(code, user);
  const { allowed } = await visibleIds(user);
  const [dto] = await albumDtos([album], t, user, allowed);
  const kids = (t.children.get(album.id) ?? []).filter((c) => !allowed || allowed.has(c.id));
  return { ...dto, breadcrumbs: breadcrumbs(t, album), children: await albumDtos(kids, t, user, allowed) };
}

/* ---------- 创建 / 修改 / 删除 ---------- */

function parentOf(t: Tree, code: string | null | undefined): AlbumRow | null {
  if (!code) return null;
  const p = t.byCode.get(code);
  if (!p) throw E.badRequest(`父相册不存在: ${code}`, "parent_not_found");
  return p;
}

function cleanName(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw E.badRequest("相册名称不能为空");
  const n = v.trim();
  if (n.length > 80) throw E.badRequest("相册名称过长(最多 80 字符)");
  return n;
}

function cleanVisibility(v: unknown, def: "public" | "private" = "private"): "public" | "private" {
  if (v === undefined || v === null || v === "") return def;
  if (v !== "public" && v !== "private") throw E.badRequest("visibility 只能是 public 或 private");
  return v;
}

export async function createManaged(input: {
  name: unknown; parent?: string | null; visibility?: unknown; description?: unknown; storage?: unknown; sortOrder?: unknown;
}) {
  const t = await loadTree();
  const parent = parentOf(t, input.parent);
  const storage = input.storage === undefined || input.storage === "" ? parent && parent.kind === "managed" ? parent.storage : "local" : input.storage;
  if (!isStorageCode(storage) || storage === "ext") throw E.badRequest("受管相册的 storage 只能是 local 或 s3");
  if (storage === "s3" && !s3Available()) throw E.badRequest("未配置对象存储", "s3_not_configured");
  const code = `alb_${randomId(8)}`;
  const row: typeof albums.$inferInsert = {
    id: randomId(14), code, name: cleanName(input.name), parentId: parent?.id ?? null, kind: "managed", storage,
    visibility: cleanVisibility(input.visibility), description: typeof input.description === "string" ? input.description.slice(0, 500) : "",
    sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : 0,
  };
  if (storage === "local") await fs.mkdir(path.join(dirs.albums, code), { recursive: true });
  await db.insert(albums).values(row);
  invalidateAlbums();
  return code;
}

export function assertMountAllowed(abs: string) {
  if (!path.isAbsolute(abs)) throw E.badRequest("路径必须是服务器上的绝对路径");
  if (config.mountRoots.length) {
    const okRoot = config.mountRoots.some((r) => abs === r || abs.startsWith(r + path.sep));
    if (!okRoot) throw E.forbidden("该路径不在 ALLOWED_MOUNT_ROOTS 允许范围内");
  }
}

export async function mountDir(input: {
  path: unknown; name?: unknown; parent?: string | null; recursive?: boolean; visibility?: unknown; scan?: boolean;
}) {
  if (typeof input.path !== "string" || !input.path.trim()) throw E.badRequest("缺少 path");
  const abs = path.resolve(input.path.trim());
  assertMountAllowed(abs);
  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isDirectory()) throw E.badRequest("目录不存在或不是文件夹");
  const t = await loadTree();
  if (t.rows.some((r) => r.rootPath === abs)) throw E.conflict("该目录已挂载为相册");
  const parent = parentOf(t, input.parent);
  const code = `dir_${randomId(8)}`;
  await db.insert(albums).values({
    id: randomId(14), code, name: input.name ? cleanName(input.name) : path.basename(abs) || abs, parentId: parent?.id ?? null,
    kind: "mounted", storage: "ext", rootPath: abs, visibility: cleanVisibility(input.visibility),
  });
  invalidateAlbums();
  if (input.scan !== false) void scanAlbum(code, input.recursive !== false).catch((e) => console.error("[scan]", e));
  return code;
}

export async function updateAlbum(code: string, patch: Record<string, unknown>) {
  const t = await loadTree();
  const a = t.byCode.get(code);
  if (!a) throw E.notFound("相册不存在");
  const set: Partial<typeof albums.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = cleanName(patch.name);
  if (patch.description !== undefined) set.description = String(patch.description).slice(0, 500);
  if (patch.visibility !== undefined) set.visibility = cleanVisibility(patch.visibility);
  if (patch.sortOrder !== undefined) set.sortOrder = Number(patch.sortOrder) || 0;
  if (patch.cover !== undefined) set.coverMediaId = patch.cover ? String(patch.cover) : null;
  if (patch.parent !== undefined) {
    const p = parentOf(t, patch.parent as string | null);
    if (p && descendants(t, a.id).includes(p.id)) throw E.badRequest("不能把相册移动到自己的子相册下");
    set.parentId = p?.id ?? null;
  }
  await db.update(albums).set(set).where(eq(albums.id, a.id));
  // 可见性变更时,同步子孙(便于“整树公开/私有”);用 cascade=true 触发
  if (patch.visibility !== undefined && patch.cascade === true) {
    await db.update(albums).set({ visibility: set.visibility! }).where(inArray(albums.id, descendants(t, a.id)));
  }
  invalidateAlbums();
}

export async function deleteMediaByIds(
  ids: string[],
  purge: boolean,
  opts: { user?: AuthUser | null; block?: boolean } = {},
) {
  if (!ids.length) return;
  // 未勾选「同时删除源文件」时,默认把记录移入黑名单(源文件保留在服务器上)
  const block = opts.block ?? !purge;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await db.select().from(media).where(inArray(media.id, chunk));
    if (block && rows.length) await addToBlocklist(rows, opts.user ?? null);
    for (const r of rows) {
      // 只有 purge=true 才物理删除源文件;进入黑名单时源文件保留在服务器上,便于解除后恢复
      if (purge) {
        try {
          await (await driverFor(r.storage)).remove(r.storageKey);
        } catch (e) {
          console.error("[delete] remove original failed", r.id, e);
        }
      }
      await removeDerived(r.id);
    }
    await db.delete(media).where(inArray(media.id, chunk));
  }
  invalidateAlbums();
}

/**
 * 把挂载相册(ext)里的文件真正移动到目标相册所在目录,并更新 storage_key。
 * 用于「移动文件」操作:避免父相册与子相册目录各存一份同一张图片。
 * 目标不是挂载目录(或目标目录不可写)时只改数据库归属,不动文件。
 */
export async function relocateExtFile(
  row: typeof media.$inferSelect,
  targetAlbumId: string | null,
): Promise<void> {
  if (row.storage !== "ext" || !path.isAbsolute(row.storageKey)) return;
  const t = await loadTree();
  const target = targetAlbumId ? t.byId.get(targetAlbumId) : undefined;
  if (!target || target.kind !== "mounted" || !target.rootPath) return;
  const dstDir = target.rootPath;
  const src = row.storageKey;
  if (path.dirname(src) === dstDir) return;
  if (!src.startsWith(dstDir + path.sep) && !dstDir.startsWith(path.dirname(src) + path.sep)) {
    // 两个挂载目录互不包含(不同磁盘/不同挂载点):仍允许移动,但需确认目标可写
  }
  const base = path.basename(src);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let dst = path.join(dstDir, base);
  for (let i = 0; i < 50; i++) {
    const exists = await fs.stat(dst).catch(() => null);
    if (!exists) break;
    dst = path.join(dstDir, `${stem}-${randomId(4)}${ext}`);
  }
  try {
    await fs.mkdir(dstDir, { recursive: true });
    await fs.rename(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") {
      console.error("[move] rename failed, keep record only", src, dst, e);
      return;
    }
    try {
      await fs.copyFile(src, dst);
      await fs.unlink(src);
    } catch (e2) {
      console.error("[move] copy+unlink failed, keep record only", src, dst, e2);
      return;
    }
  }
  await db.update(media).set({ storageKey: dst, filename: path.basename(dst) }).where(eq(media.id, row.id));
}

export async function deleteAlbum(code: string, opts: { media: "move" | "delete"; purge: boolean; user?: AuthUser | null }) {
  const t = await loadTree();
  const a = t.byCode.get(code);
  if (!a) throw E.notFound("相册不存在");
  if (a.kind === "mounted") {
    // 挂载相册:仅解除登记(连同自动生成的子相册),绝不删除服务器上的文件(除非 purge)
    const ids = descendants(t, a.id);
    const rows = await db.select({ id: media.id }).from(media).where(inArray(media.albumId, ids));
    // 解除挂载只清理登记信息:不进入删除黑名单(重新挂载该目录时文件仍会被索引)
    await deleteMediaByIds(rows.map((r) => r.id), opts.purge, { user: opts.user, block: false });
    await db.delete(albums).where(inArray(albums.id, ids));
  } else {
    const parent = a.parentId ?? null;
    if (opts.media === "delete") {
      const rows = await db.select({ id: media.id }).from(media).where(eq(media.albumId, a.id));
      // 受管相册的文件属于本系统自己的数据,删除相册时一并物理删除(不进入黑名单)
      await deleteMediaByIds(rows.map((r) => r.id), true, { user: opts.user, block: false });
    } else {
      await db.update(media).set({ albumId: parent }).where(eq(media.albumId, a.id));
    }
    await db.update(albums).set({ parentId: parent }).where(eq(albums.parentId, a.id));
    await db.delete(albums).where(eq(albums.id, a.id));
    if (a.storage === "local") await fs.rmdir(path.join(dirs.albums, a.code)).catch(() => undefined);
  }
  invalidateAlbums();
}

export async function albumStatus(code: string, user: AuthUser | null) {
  const { t, album } = await resolveAlbum(code, user);
  const { allowed } = await visibleIds(user);
  const [dto] = await albumDtos([album], t, user, allowed);
  return { ...dto, scan: scanStates.get(album.id) ?? null, descendants: descendants(t, album.id).length - 1 };
}

/* ---------- 挂载目录扫描 ---------- */

interface ScanState {
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  added: number;
  removed: number;
  updated: number;
  albumsCreated: number;
  error: string | null;
}

const g = globalThis as typeof globalThis & { __pgsScan?: Map<string, ScanState> };
export const scanStates: Map<string, ScanState> = (g.__pgsScan ??= new Map());

const SKIP_DIR = /^(\.|@eaDir|#recycle|\$RECYCLE\.BIN|System Volume Information|node_modules$|lost\+found)/i;

async function scanOne(a: AlbumRow, recursive: boolean, s: ScanState, depth: number): Promise<void> {
  if (!a.rootPath) return;
  const blocked = await blockedExtKeys();
  const entries = await fs.readdir(a.rootPath, { withFileTypes: true });
  const files: Array<{ abs: string; name: string; size: number; mtime: Date; kind: string; mime: string }> = [];
  for (const e of entries) {
    const abs = path.join(a.rootPath, e.name);
    if (e.isDirectory() && recursive && depth < 12 && !SKIP_DIR.test(e.name)) {
      const t = await loadTree();
      let child = (t.children.get(a.id) ?? []).find((c) => c.rootPath === abs);
      if (!child) {
        const [dup] = await db.select().from(albums).where(eq(albums.rootPath, abs)).limit(1);
        if (dup) child = dup;
        else {
          const [created] = await db
            .insert(albums)
            .values({
              id: randomId(14), code: `dir_${randomId(8)}`, name: e.name, parentId: a.id, kind: "mounted", storage: "ext",
              rootPath: abs, visibility: a.visibility,
            })
            .returning();
          child = created;
          s.albumsCreated++;
          invalidateAlbums();
        }
      }
      await scanOne(child, recursive, s, depth + 1);
    } else if (e.isFile() && !e.name.startsWith(".")) {
      const k = detectKind(e.name);
      if (!k) continue;
      const abs = path.join(a.rootPath, e.name);
      // 已加入删除黑名单的文件:扫描时跳过,不会被重新入库
      if (blocked.has(abs)) continue;
      const st = await fs.stat(abs).catch(() => null);
      if (st) files.push({ abs, name: e.name, size: st.size, mtime: st.mtime, kind: k.kind, mime: k.mime });
    }
  }
  const existing = await db
    .select({ id: media.id, key: media.storageKey, size: media.size })
    .from(media)
    .where(and(eq(media.albumId, a.id), eq(media.storage, "ext")));
  const known = new Map(existing.map((r) => [r.key, r]));
  const seen = new Set<string>();
  const fresh: Array<typeof media.$inferInsert> = [];
  const changed: string[] = [];
  for (const f of files) {
    seen.add(f.abs);
    const old = known.get(f.abs);
    if (!old) {
      fresh.push({
        id: randomId(12), albumId: a.id, kind: f.kind, filename: f.name, mime: f.mime, size: f.size, sortAt: f.mtime,
        storage: "ext", storageKey: f.abs, searchText: f.name.toLowerCase(), status: "pending",
      });
    } else if (old.size !== f.size) {
      changed.push(old.id);
      await db.update(media).set({ size: f.size, status: "pending" }).where(eq(media.id, old.id));
    }
  }
  for (let i = 0; i < fresh.length; i += 500) {
    const ins = await db.insert(media).values(fresh.slice(i, i + 500)).onConflictDoNothing().returning({ id: media.id });
    s.added += ins.length;
    ins.forEach((r) => enqueue(r.id));
  }
  changed.forEach((id) => enqueue(id));
  s.updated += changed.length;
  const gone = existing.filter((r) => !seen.has(r.key)).map((r) => r.id);
  if (gone.length) {
    // 磁盘上已消失的文件:仅清理记录,不进入删除黑名单
    await deleteMediaByIds(gone, false, { block: false });
    s.removed += gone.length;
  }
  await db.update(albums).set({ lastScanAt: new Date() }).where(eq(albums.id, a.id));
}

export async function scanAlbum(code: string, recursive = true): Promise<ScanState> {
  const t = await loadTree();
  const a = t.byCode.get(code);
  if (!a) throw E.notFound("相册不存在");
  if (a.kind !== "mounted" || !a.rootPath) throw E.badRequest("只有挂载的目录相册可以扫描");
  if (scanStates.get(a.id)?.running) throw E.conflict("该相册正在扫描中");
  const s: ScanState = {
    running: true, startedAt: new Date().toISOString(), finishedAt: null, added: 0, removed: 0, updated: 0, albumsCreated: 0, error: null,
  };
  scanStates.set(a.id, s);
  try {
    const st = await fs.stat(a.rootPath).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`目录不可访问: ${a.rootPath}(为避免误删,已保留现有记录)`);
    await scanOne(a, recursive, s, 0);
  } catch (e) {
    s.error = String((e as Error).message ?? e);
  } finally {
    s.running = false;
    s.finishedAt = new Date().toISOString();
    invalidateAlbums();
  }
  if (s.error) throw E.badRequest(s.error, "scan_failed");
  return s;
}

/** 目录浏览(挂载对话框用):列出子目录 */
export async function browseDirs(p: string) {
  const abs = path.resolve(p || "/");
  assertMountAllowed(abs);
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => {
    throw E.badRequest("无法读取该目录");
  });
  return {
    path: abs,
    parent: path.dirname(abs) === abs ? null : path.dirname(abs),
    dirs: entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort((a, b) => a.localeCompare(b)),
  };
}

/** 周期扫描所有顶层挂载相册 */
export async function scanAllMounted() {
  const t = await loadTree();
  for (const a of t.rows) {
    const parent = a.parentId ? t.byId.get(a.parentId) : undefined;
    if (a.kind === "mounted" && !(parent && parent.kind === "mounted")) {
      await scanAlbum(a.code, true).catch(() => undefined);
    }
  }
}
