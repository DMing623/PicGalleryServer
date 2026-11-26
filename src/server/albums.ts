// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, rawQuery } from "@/db";
import { albums, blocklist, media } from "@/db/schema";
import { can, type AuthUser } from "./auth";
import { blockedExtKeys, invalidateBlocklist } from "./blocklist";
import { config, dirs } from "./config";
import { E } from "./http";
import { removeDerived } from "./media/derive";
import { detectKind, randomId } from "./media/types";
import { cancelRetry, enqueue } from "./queue";
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
  /** 游客可见(自身及全部祖先 public)的相册 id 集合,随树一起缓存(issue §6.2) */
  publicIds: Set<string>;
  at: number;
}

let tree: Tree | null = null;
let treeInflight: Promise<Tree> | null = null;
/**
 * 缓存代数:每次 invalidateAlbums() 自增。
 * loadTree 在查询开始时记录代数,写回缓存前比对 —— 若期间发生过失效(例如并发建相册),
 * 旧查询的结果不再写回,避免"过期树覆盖新缓存"导致刚创建的相册查不到(幽灵 404)。
 */
let treeGen = 0;
let treeInflightGen = -1;
let stats: Stats | null = null;
let statsInflight: Promise<Stats> | null = null;

interface Stats {
  at: number;
  counts: Map<string, AlbumCounts>;
  covers: Map<string, string>;
}

/** 相册结构变化(建/改/删/挂载):立即失效 */
export function invalidateAlbums() {
  tree = null;
  stats = null;
  treeGen++; // 让所有"进行中"的树查询结果作废
}

/**
 * 媒体数量变化(每个文件入库都会调用):防抖失效,避免批量上传期间
 * 每个文件都触发一次全表聚合(issue §6.3)。
 */
let statsTimer: NodeJS.Timeout | null = null;
export function invalidateMediaCaches() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    stats = null;
  }, 2000);
  statsTimer.unref?.();
}

const collator = new Intl.Collator("zh");

export async function loadTree(): Promise<Tree> {
  if (tree && Date.now() - tree.at < 10_000) return tree;
  // 惊群合并:并发请求共用同一次查询。但若这次查询开始后缓存被失效过(代数变化),
  // 它返回的树可能缺少刚写入的相册,不能复用,必须重新查一次。
  if (treeInflight && treeInflightGen === treeGen) return treeInflight;
  const gen = treeGen;
  const p = (async () => {
    const rows = await db.select().from(albums);
    rows.sort((a, b) => a.sortOrder - b.sortOrder || collator.compare(a.name, b.name));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const children = new Map<string | null, AlbumRow[]>();
    for (const r of rows) {
      const k = r.parentId && byId.has(r.parentId) ? r.parentId : null;
      (children.get(k) ?? children.set(k, []).get(k)!).push(r);
    }
    const t: Tree = { rows, byId, byCode, children, publicIds: new Set(), at: Date.now() };
    for (const r of rows) if (effectivelyPublic(t, r)) t.publicIds.add(r.id);
    // 只有查询期间没有发生过失效才写回缓存:否则这次结果是过期的,写回会把新相册"盖掉"
    if (gen === treeGen) tree = t;
    return t;
  })().finally(() => {
    if (treeInflight === p) treeInflight = null;
  });
  treeInflight = p;
  treeInflightGen = gen;
  return p;
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
  if (!site.guestBrowse) return { t, allowed: EMPTY_SET };
  return { t, allowed: t.publicIds };
}

const EMPTY_SET: Set<string> = new Set();

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

async function loadStats(): Promise<Stats> {
  if (stats && Date.now() - stats.at < 5000) return stats;
  if (statsInflight) return statsInflight;
  statsInflight = (async () => {
    // 用 CAST(...) 而不是 pg 专有的 ::int / ::float8,让同一条 SQL 在 SQLite 上也能跑
    const rows = await rawQuery(sql`
      SELECT album_id,
             CAST(count(*) AS INTEGER) AS media,
             CAST(coalesce(sum(size),0) AS DOUBLE PRECISION) AS size,
             CAST(count(*) FILTER (WHERE status='pending') AS INTEGER) AS pending,
             CAST(count(*) FILTER (WHERE status='failed') AS INTEGER) AS failed,
             CAST(count(*) FILTER (WHERE kind='image') AS INTEGER) AS images,
             CAST(count(*) FILTER (WHERE kind='video') AS INTEGER) AS videos
      FROM pgs_media WHERE album_id IS NOT NULL AND missing_at IS NULL GROUP BY album_id`);
    const counts = new Map<string, AlbumCounts>();
    for (const r of rows.rows as Array<Record<string, unknown>>) {
      counts.set(String(r.album_id), {
        media: Number(r.media), size: Number(r.size), pending: Number(r.pending), failed: Number(r.failed),
        images: Number(r.images), videos: Number(r.videos),
      });
    }
    // 封面:每个相册取 sort_at 最新的一条(用窗口函数替代 pg 专有的 DISTINCT ON)
    const cov = await rawQuery(sql`
      SELECT album_id, id FROM (
        SELECT album_id, id, row_number() OVER (PARTITION BY album_id ORDER BY sort_at DESC) AS rn
        FROM pgs_media WHERE album_id IS NOT NULL AND status='ready' AND missing_at IS NULL
      ) AS ranked WHERE rn = 1`);
    const covers = new Map<string, string>();
    for (const r of cov.rows as Array<Record<string, unknown>>) covers.set(String(r.album_id), String(r.id));
    const v = { at: Date.now(), counts, covers };
    stats = v;
    return v;
  })().finally(() => {
    statsInflight = null;
  });
  return statsInflight;
}

const ZERO: AlbumCounts = { media: 0, size: 0, pending: 0, failed: 0, images: 0, videos: 0 };

export async function unsortedCount(): Promise<number> {
  const r = await rawQuery(sql`SELECT CAST(count(*) AS INTEGER) AS n FROM pgs_media WHERE album_id IS NULL AND missing_at IS NULL`);
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
      readonly: a.readonly,
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
  if (typeof v !== "string") throw E.badRequest("相册名称不能为空");
  // 去掉控制字符(含 NUL):PostgreSQL 的 text 不接受 \x00,会让 insert 抛 22021 并留下孤儿目录
  const n = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!n) throw E.badRequest("相册名称不能为空");
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
  const dir = storage === "local" ? path.join(dirs.albums, code) : null;
  if (dir) await fs.mkdir(dir, { recursive: true });
  try {
    await db.insert(albums).values(row);
  } catch (e) {
    // 建目录成功但入库失败:回滚目录,避免磁盘上留下数据库不可见的孤儿目录
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  invalidateAlbums();
  return code;
}

/** 解析真实路径(消除符号链接),失败时回落到原路径 */
export async function realPath(p: string): Promise<string> {
  return fs.realpath(p).catch(() => path.resolve(p));
}

/** 判断 child 是否位于 parent 之内(含相等) */
function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * 挂载路径白名单校验(issue §1.10):
 *  - 先 realpath,避免用符号链接逃出白名单;
 *  - 白名单为空时不再"完全不限制",而是只允许 DATA_DIR 与约定目录(/photos、/mnt、/media、/srv、/home、/volume1)
 *    以及它们的子目录;确实需要更宽范围请显式配置 ALLOWED_MOUNT_ROOTS。
 */
export async function assertMountAllowed(abs: string): Promise<string> {
  if (!path.isAbsolute(abs)) throw E.badRequest("路径必须是服务器上的绝对路径");
  const real = await realPath(abs);
  const roots = config.mountRoots.length
    ? await Promise.all(config.mountRoots.map((r) => realPath(r)))
    : [config.dataDir, "/photos", "/mnt", "/media", "/srv", "/home", "/volume1"];
  if (!roots.some((r) => within(real, r))) {
    throw E.forbidden(
      config.mountRoots.length
        ? "该路径不在 ALLOWED_MOUNT_ROOTS 允许范围内"
        : "该路径不在默认允许范围(数据目录、/photos、/mnt、/media、/srv、/home、/volume1);如需其它目录请配置 ALLOWED_MOUNT_ROOTS",
    );
  }
  return real;
}

/** 检查是否与已挂载目录存在祖先/后代重叠(两棵树会互相抢文件,见 issue §1.10) */
async function assertNoOverlap(real: string) {
  const rows = await db.select({ rootPath: albums.rootPath, name: albums.name }).from(albums).where(eq(albums.kind, "mounted"));
  for (const r of rows) {
    if (!r.rootPath) continue;
    const other = await realPath(r.rootPath);
    if (within(real, other) || within(other, real)) {
      throw E.conflict(`该目录与已挂载相册「${r.name}」(${r.rootPath})存在重叠,请勿嵌套挂载`);
    }
  }
}

export async function mountDir(input: {
  path: unknown; name?: unknown; parent?: string | null; recursive?: boolean; visibility?: unknown; scan?: boolean; readonly?: unknown;
}) {
  if (typeof input.path !== "string" || !input.path.trim()) throw E.badRequest("缺少 path");
  if (!path.isAbsolute(input.path.trim())) throw E.badRequest("路径必须是服务器上的绝对路径");
  const abs = await assertMountAllowed(path.resolve(input.path.trim()));
  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isDirectory()) throw E.badRequest("目录不存在或不是文件夹");
  const t = await loadTree();
  if (t.rows.some((r) => r.rootPath === abs)) throw E.conflict("该目录已挂载为相册");
  await assertNoOverlap(abs);
  const parent = parentOf(t, input.parent);
  const code = `dir_${randomId(8)}`;
  await db.insert(albums).values({
    id: randomId(14), code, name: input.name ? cleanName(input.name) : path.basename(abs) || abs, parentId: parent?.id ?? null,
    kind: "mounted", storage: "ext", rootPath: abs, visibility: cleanVisibility(input.visibility),
    // 默认只读:挂载的是用户自己的照片目录,不应被本系统改写
    readonly: input.readonly === undefined ? true : !!input.readonly,
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
  if (patch.readonly !== undefined) set.readonly = !!patch.readonly;
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
  if (!ids.length) return { removed: 0, failed: [] as Array<{ id: string; error: string }> };
  // 未勾选「同时删除源文件」时,默认把记录移入黑名单(源文件保留在服务器上)
  const block = opts.block ?? !purge;
  const failed: Array<{ id: string; error: string }> = [];
  // 只读挂载目录里的文件不属于本系统,即使管理员勾了 purge 也不能物理删除(issue §1.10)。
  // 这里直接整体拒绝,而不是「删记录、留文件」——后者会让用户以为已删除,且下次扫描又把文件重新入库。
  if (purge) {
    const t = await loadTree();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await db.select({ id: media.id, storage: media.storage, albumId: media.albumId }).from(media).where(inArray(media.id, chunk));
      for (const r of rows) {
        if (r.storage !== "ext") continue;
        const owner = r.albumId ? t.byId.get(r.albumId) : undefined;
        if (owner?.readonly) throw E.forbidden("源文件位于只读挂载目录,不能物理删除;如需删除请先在相册设置里关闭只读");
      }
    }
  }
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await db.select().from(media).where(inArray(media.id, chunk));
    if (!rows.length) continue;
    // 1) 先把「黑名单 + 删除记录」放进同一事务:任何一步失败都不会留下半截状态(issue §2.4)
    await db.transaction(async (tx) => {
      if (block) {
        const values: Array<typeof blocklist.$inferInsert> = rows.map((r) => ({
          id: randomId(14), mediaId: r.id, albumId: r.albumId, albumCode: null, kind: r.kind, filename: r.filename,
          mime: r.mime, size: r.size, storage: r.storage, storageKey: r.storageKey, hash: r.hash,
          takenAt: r.takenAt, sortAt: r.sortAt, meta: r.meta, note: r.note, createdBy: opts.user?.id ?? null,
        }));
        const albumIds = [...new Set(rows.map((r) => r.albumId).filter((v): v is string => !!v))];
        if (albumIds.length) {
          const codes = await tx.select({ id: albums.id, code: albums.code }).from(albums);
          const byId = new Map(codes.map((a) => [a.id, a.code]));
          for (const v of values) v.albumCode = v.albumId ? byId.get(v.albumId) ?? null : null;
        }
        await tx.insert(blocklist).values(values).onConflictDoNothing();
      }
      await tx.delete(media).where(inArray(media.id, chunk));
    });
    cancelRetry(chunk); // 退避重试中的已删除媒体不再入队
    // 2) 事务提交后再动物理文件:失败只记录并返回,不再"静默继续"(issue §2.4)
    for (const r of rows) {
      if (purge) {
        try {
          await (await driverFor(r.storage)).remove(r.storageKey);
        } catch (e) {
          failed.push({ id: r.id, error: String((e as Error)?.message ?? e) });
          console.error("[delete] remove original failed", r.id, e);
        }
      }
      await removeDerived(r.id).catch(() => undefined);
    }
  }
  if (block) invalidateBlocklist();
  invalidateAlbums();
  return { removed: ids.length - failed.length, failed };
}

/**
 * 把受管相册(local)里的文件真正移动到目标相册目录。
 * 返回新的 storageKey/filename;不需要移动时返回 null;移动失败会抛错。
 *
 * 与 relocateExtFile 同理:必须先搬文件、成功后再由调用方更新数据库,
 * 否则库里指向旧目录,原目录被清理后记录就成了孤儿。
 *
 * 注意:local 存储的 storageKey 是【相对 DATA_DIR 的路径】(如 albums/<code>/x.jpg),
 * 不能直接当文件系统路径用,必须经 localAbs() 解析。
 */
export async function relocateLocalFile(
  row: typeof media.$inferSelect,
  targetAlbumId: string | null,
): Promise<{ storageKey: string; filename: string } | null> {
  return withMoveLock(row.id, () => relocateLocalFileInner(row, targetAlbumId));
}

async function relocateLocalFileInner(
  row: typeof media.$inferSelect,
  targetAlbumId: string | null,
): Promise<{ storageKey: string; filename: string } | null> {
  if (row.storage !== "local") return null;
  const t = await loadTree();
  const target = targetAlbumId ? t.byId.get(targetAlbumId) : undefined;
  // 目标是挂载相册:文件仍留在数据目录内,不跨存储搬动
  if (target && target.kind === "mounted") return null;
  const dstDir = target ? path.join(dirs.albums, target.code) : path.join(dirs.albums, "_inbox");
  const src = localAbs(row.storageKey);
  if (path.dirname(src) === dstDir) return null;
  await fs.mkdir(dstDir, { recursive: true });
  const base = path.basename(src);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let dst = path.join(dstDir, base);
  for (let i = 0; i < 50; i++) {
    try {
      await moveNoOverwrite(src, dst);
      return { storageKey: localKey(dst), filename: path.basename(dst) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      dst = path.join(dstDir, `${stem}-${randomId(4)}${ext}`);
    }
  }
  throw E.conflict("目标目录重名文件过多,无法移动");
}

/** local 存储的相对 key → 绝对路径(与 storage/index.ts 的 localDriver 保持同一规则) */
function localAbs(key: string): string {
  const abs = path.resolve(config.dataDir, key);
  if (abs !== config.dataDir && !abs.startsWith(config.dataDir + path.sep)) throw E.badRequest("非法存储路径");
  return abs;
}

/** 绝对路径 → local 存储的相对 key */
function localKey(abs: string): string {
  return path.relative(config.dataDir, abs).split(path.sep).join("/");
}

/**
 * 把挂载相册(ext)里的文件真正移动到目标相册所在目录。
 * 返回新的 storageKey/filename;不需要移动时返回 null;移动失败会抛错(issue §2.2)。
 *
 * 顺序很重要:先移动文件,成功后才由调用方更新数据库。旧实现先改库后搬文件,
 * 搬失败时库里指向旧目录,下一次扫描会把记录当成"消失"而删掉。
 */
export async function relocateExtFile(
  row: typeof media.$inferSelect,
  targetAlbumId: string | null,
): Promise<{ storageKey: string; filename: string } | null> {
  return withMoveLock(row.id, () => relocateExtFileInner(row, targetAlbumId));
}

async function relocateExtFileInner(
  row: typeof media.$inferSelect,
  targetAlbumId: string | null,
): Promise<{ storageKey: string; filename: string } | null> {
  if (row.storage !== "ext" || !path.isAbsolute(row.storageKey)) return null;
  const t = await loadTree();
  const target = targetAlbumId ? t.byId.get(targetAlbumId) : undefined;
  // 挂载目录里的文件只能在挂载相册之间搬动;移到受管相册/未归类时若只改库不搬文件,
  // 记录会指向挂载目录却归属受管相册,造成"目录里有文件、相册里看不到"的不一致状态
  if (!target || target.kind !== "mounted" || !target.rootPath) {
    throw E.badRequest("挂载目录中的文件只能移动到其他挂载相册;如需放入受管相册,请使用「导入」复制一份");
  }
  if (target.readonly) throw E.forbidden("目标相册是只读挂载目录,不能写入文件");
  const srcAlbum = row.albumId ? t.byId.get(row.albumId) : undefined;
  if (srcAlbum?.readonly) throw E.forbidden("源相册是只读挂载目录,不能移动其中的文件");

  const dstDir = target.rootPath;
  const src = row.storageKey;
  if (path.dirname(src) === dstDir) return null;

  const base = path.basename(src);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  await fs.mkdir(dstDir, { recursive: true });
  let dst = path.join(dstDir, base);
  for (let i = 0; i < 50; i++) {
    // 用 link/copyFile(EXCL) 保证"目标已存在就失败",彻底消除 stat→rename 的 TOCTOU 覆盖窗口
    try {
      await moveNoOverwrite(src, dst);
      return { storageKey: dst, filename: path.basename(dst) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      dst = path.join(dstDir, `${stem}-${randomId(4)}${ext}`);
    }
  }
  throw E.conflict("目标目录重名文件过多,无法移动");
}

/** 不覆盖已有文件的移动:优先硬链接(同盘,原子),跨盘时用 COPYFILE_EXCL 复制 */
async function moveNoOverwrite(src: string, dst: string): Promise<void> {
  try {
    await fs.link(src, dst);
    // 链接已建立,源文件的删除失败不应让整个移动失败:
    // 并发搬同一文件时另一个请求可能已经删掉了源(ENOENT),此时目标文件是有效的
    await fs.unlink(src).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    });
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw e;
    if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP" || code === "EACCES" || code === "EMLINK") {
      await fs.copyFile(src, dst, fsConstants.COPYFILE_EXCL);
      await fs.unlink(src).catch((e2) => {
        if ((e2 as NodeJS.ErrnoException).code !== "ENOENT") throw e2;
      });
      return;
    }
    throw e;
  }
}

/**
 * 同一媒体的搬移串行化(键控互斥)。
 * 并发请求同时搬同一个文件时,link→unlink 会互相穿插:一方 link 成功后另一方 unlink 掉源,
 * 结果旧目录残留硬链接(nlink=2)而数据库已指向新路径,形成看不见的孤儿文件。
 */
const moveLocks = new Map<string, Promise<unknown>>();

export async function withMoveLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = moveLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const next = prev.then(() => gate).catch(() => gate);
  moveLocks.set(id, next);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (moveLocks.get(id) === next) moveLocks.delete(id);
  }
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
      // 媒体移交父相册:受管相册(local)必须真正搬文件,否则目录与归属脱节且永远无法清理(issue §2.6)
      const rows = await db.select().from(media).where(eq(media.albumId, a.id));
      for (const r of rows) {
        let storageKey = r.storageKey;
        let filename = r.filename;
        if (r.storage === "local") {
          const dstDir = parent ? path.join(dirs.albums, t.byId.get(parent)?.code ?? "") : path.join(dirs.albums, "_inbox");
          await fs.mkdir(dstDir, { recursive: true });
          // storageKey 是相对 DATA_DIR 的路径,必须先解析成绝对路径
          const srcAbs = localAbs(r.storageKey);
          const base = path.basename(srcAbs);
          const ext = path.extname(base);
          const stem = base.slice(0, base.length - ext.length);
          let dst = path.join(dstDir, base);
          let done = false;
          // 目标已有同名文件时换名重试,避免 moveNoOverwrite 抛 EEXIST 导致整个移交中断
          for (let i = 0; i < 50 && !done; i++) {
            try {
              await moveNoOverwrite(srcAbs, dst);
              storageKey = localKey(dst);
              filename = path.basename(dst);
              done = true;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
                console.error("[album] 移交文件失败,记录保持原归属", r.id, e);
                break;
              }
              dst = path.join(dstDir, `${stem}-${randomId(4)}${ext}`);
            }
          }
          if (!done) continue;
        }
        await db.update(media).set({ albumId: parent, storageKey, filename }).where(eq(media.id, r.id));
      }
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
  renamed: number;
  missing: number;
  albumsCreated: number;
  /** 目录消失后一并移除的相册数(含其子相册) */
  albumsRemoved: number;
  /** 目录改名后沿用原相册(保留记录与缩略图)的数量 */
  albumsMoved: number;
  /** 因超过 SCAN_MAX_DEPTH 而未下探的子目录数(非 0 时提示用户) */
  truncated: number;
  error: string | null;
}

const g = globalThis as typeof globalThis & { __pgsScan?: Map<string, ScanState>; __pgsScanLocks?: Set<string> };
export const scanStates: Map<string, ScanState> = (g.__pgsScan ??= new Map());
/** 扫描互斥锁(按相册代码)。必须在任何 await 之前同步占位,否则并发请求会同时通过检查。 */
const scanLocks: Set<string> = (g.__pgsScanLocks ??= new Set());

const SKIP_DIR = /^(\.|@eaDir|#recycle|\$RECYCLE\.BIN|System Volume Information|node_modules$|lost\+found)/i;

/** 软删除宽限期:文件连续缺失超过该时长才真正清理记录(issue §2.1) */
const MISSING_GRACE_MS = 7 * 86_400_000;

interface ScannedFile {
  abs: string;
  name: string;
  size: number;
  mtimeMs: number;
  kind: string;
  mime: string;
}

/**
 * 目录的"内容指纹":直接子文件的 (size:mtime) 多重集(排序后的数组)。
 * 用于识别"目录被改名"——改名不会改变文件大小与 mtime,因此指纹完全一致。
 * 注意必须用数组而不是 Set:同一目录里常有多个同尺寸同 mtime 的文件,
 * 用 Set 去重会让指纹数量对不上而漏判。
 * 只读一层(不递归),避免为每个候选目录做一次全量遍历。
 */
async function dirSignature(dir: string): Promise<string[] | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return null;
  const files = entries.filter((e) => e.isFile() && !e.name.startsWith(".") && detectKind(e.name)).map((e) => path.join(dir, e.name));
  if (!files.length) return null;
  const stats = await statAll(files);
  if (stats.length !== files.length) return null;
  return stats.map((x) => `${x.size}:${x.mtimeMs}`).sort();
}

/**
 * 把挂载相册的根路径迁移到新目录(目录改名场景),并同步更新其所有子孙相册的 rootPath 前缀。
 * 保留相册代码、记录与已生成的缩略图,用户不会看到"相册消失又新建"。
 */
async function moveAlbumRoot(album: AlbumRow, newRoot: string) {
  const oldRoot = album.rootPath!;
  const t = await loadTree();
  const sub = descendants(t, album.id);
  const rows = sub.map((id) => t.byId.get(id)).filter((r): r is AlbumRow & { rootPath: string } => !!r && !!r.rootPath);
  for (const r of rows) {
    const next = r.id === album.id ? newRoot : newRoot + r.rootPath.slice(oldRoot.length);
    // 目标路径可能已被别的相册占用(极端情况),跳过该条以免撞唯一索引
    const [dup] = await db.select({ id: albums.id }).from(albums).where(eq(albums.rootPath, next)).limit(1);
    if (dup && dup.id !== r.id) continue;
    await db.update(albums).set({ rootPath: next, name: r.id === album.id ? path.basename(newRoot) : r.name }).where(eq(albums.id, r.id));
    // ext 存储的 storage_key 就是绝对路径,必须一起改,否则缩略图仍在、但原图指向旧路径。
    // 用「新前缀 + 去掉旧前缀的剩余部分」而不是全局 replace,避免路径中段恰好含相同片段时被误替换。
    await db
      .update(media)
      .set({ storageKey: sql`${next} || substr(${media.storageKey}, ${r.rootPath.length + 1})`, missingAt: null })
      .where(and(eq(media.albumId, r.id), eq(media.storage, "ext")));
  }
  invalidateAlbums();
}

/** 受限并发地 stat 一批文件(网络文件系统上串行 stat 是扫描最慢的部分) */
async function statAll(paths: string[], concurrency = 8): Promise<Array<{ abs: string; size: number; mtimeMs: number }>> {
  const out: Array<{ abs: string; size: number; mtimeMs: number }> = [];
  let i = 0;
  const worker = async () => {
    while (i < paths.length) {
      const p = paths[i++];
      const st = await fs.stat(p).catch(() => null);
      if (st?.isFile()) out.push({ abs: p, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return out;
}

async function scanOne(a: AlbumRow, recursive: boolean, s: ScanState, depth: number, blocked: Set<string>): Promise<void> {
  if (!a.rootPath) return;
  const entries = await fs.readdir(a.rootPath, { withFileTypes: true });
  const candidates: Array<{ abs: string; name: string; kind: string; mime: string }> = [];
  const subdirs: string[] = [];
  for (const e of entries) {
    const abs = path.join(a.rootPath, e.name);
    if (e.isDirectory()) {
      if (!recursive || SKIP_DIR.test(e.name)) continue;
      if (depth >= config.scanMaxDepth) {
        // 超过深度上限:不再下探,但要计数并提示,避免"文件在却搜不到"的静默丢失
        s.truncated++;
        continue;
      }
      subdirs.push(abs);
    } else if (e.isFile() && !e.name.startsWith(".")) {
      const k = detectKind(e.name);
      if (!k) continue;
      // 已加入删除黑名单的文件:扫描时跳过,不会被重新入库
      if (blocked.has(abs)) continue;
      candidates.push({ abs, name: e.name, kind: k.kind, mime: k.mime });
    }
  }

  const stats = await statAll(candidates.map((c) => c.abs));
  const statByPath = new Map(stats.map((x) => [x.abs, x]));
  const files: ScannedFile[] = [];
  for (const c of candidates) {
    const st = statByPath.get(c.abs);
    if (st) files.push({ ...c, size: st.size, mtimeMs: st.mtimeMs });
  }

  const existing = await db
    .select({ id: media.id, key: media.storageKey, size: media.size, mtimeMs: media.mtimeMs, missingAt: media.missingAt })
    .from(media)
    .where(and(eq(media.albumId, a.id), eq(media.storage, "ext")));
  const known = new Map(existing.map((r) => [r.key, r]));
  const seen = new Set<string>();
  const fresh: Array<typeof media.$inferInsert> = [];
  const changed: string[] = [];
  const revived: string[] = [];
  for (const f of files) {
    seen.add(f.abs);
    const old = known.get(f.abs);
    if (!old) {
      fresh.push({
        id: randomId(12), albumId: a.id, kind: f.kind, filename: f.name, mime: f.mime, size: f.size, mtimeMs: f.mtimeMs,
        sortAt: new Date(f.mtimeMs), storage: "ext", storageKey: f.abs, searchText: f.name.toLowerCase(), status: "pending",
      });
    } else if (old.missingAt) {
      revived.push(old.id);
    } else if (old.size !== f.size || (old.mtimeMs !== null && old.mtimeMs !== f.mtimeMs)) {
      // 变更检测用 (size, mtime):同尺寸覆盖也能被发现(issue §2.3)
      changed.push(old.id);
      await db.update(media).set({ size: f.size, mtimeMs: f.mtimeMs, status: "pending" }).where(eq(media.id, old.id));
    }
  }
  if (revived.length) {
    // 文件重新出现:清掉缺失标记,记录与备注都保留
    await db.update(media).set({ missingAt: null }).where(inArray(media.id, revived));
  }

  // 重命名识别:消失的与新增的按 (size, mtime) 一对一配对,命中就改 storage_key 而不是删+建
  const goneRows = existing.filter((r) => !seen.has(r.key));
  const paired = new Set<string>();
  const renamePairs: Array<{ id: string; from: string; to: string; name: string }> = [];
  if (goneRows.length && fresh.length) {
    const bySig = new Map<string, typeof fresh>();
    for (const f of fresh) {
      const sig = `${f.size}:${f.mtimeMs}`;
      (bySig.get(sig) ?? bySig.set(sig, []).get(sig)!).push(f);
    }
    for (const r of goneRows) {
      if (r.mtimeMs === null) continue;
      const bucket = bySig.get(`${r.size}:${r.mtimeMs}`);
      const hit = bucket?.find((f) => !paired.has(f.storageKey as string));
      if (!hit) continue;
      paired.add(hit.storageKey as string);
      renamePairs.push({ id: r.id, from: r.key, to: hit.storageKey as string, name: path.basename(hit.storageKey as string) });
    }
  }

  // 消失的文件:先做熔断判断(在写入任何改动之前),再软删除,超过宽限期才真正清理。
  // 熔断只统计「本次新消失」的文件:已标记 missing_at 的记录属于既有状态,
  // 若把它们算进比例,一次合法的大批量删除会让后续每次扫描都超阈值而永久失败。
  const gone = goneRows.filter((r) => !renamePairs.some((p) => p.id === r.id));
  const newlyGone = gone.filter((r) => !r.missingAt);
  if (newlyGone.length) {
    const total = existing.length;
    const ratio = total ? newlyGone.length / total : 0;
    if (total >= config.scanPruneMinCount && ratio > config.scanPruneMaxRatio) {
      // 目录暂时为空 / 盘没挂上:中止清理,保留全部记录,让管理员确认(issue §2.1)
      throw new Error(
        `检测到 ${newlyGone.length}/${total} 个文件消失(${Math.round(ratio * 100)}%),已中止清理并保留现有记录。` +
          `若确属预期(如批量删除),请调大 SCAN_PRUNE_MAX_RATIO 或手动删除后再扫描。`,
      );
    }
  }

  for (const p of renamePairs) {
    await db.update(media).set({ storageKey: p.to, filename: p.name }).where(eq(media.id, p.id));
    s.renamed++;
  }

  const toInsert = fresh.filter((f) => !paired.has(f.storageKey as string));
  for (let i = 0; i < toInsert.length; i += 500) {
    const ins = await db.insert(media).values(toInsert.slice(i, i + 500)).onConflictDoNothing().returning({ id: media.id });
    s.added += ins.length;
    ins.forEach((r) => enqueue(r.id));
  }
  changed.forEach((id) => enqueue(id));
  s.updated += changed.length;

  // 软删除:首次缺失只打标记,超过宽限期才真正清理
  if (gone.length) {
    const now = Date.now();
    const expired: string[] = [];
    const newlyMissing: string[] = [];
    for (const r of gone) {
      if (r.missingAt && now - r.missingAt.getTime() > MISSING_GRACE_MS) expired.push(r.id);
      else if (!r.missingAt) newlyMissing.push(r.id);
    }
    if (newlyMissing.length) {
      await db.update(media).set({ missingAt: new Date() }).where(inArray(media.id, newlyMissing));
      s.missing += newlyMissing.length;
    }
    if (expired.length) {
      // 超过宽限期仍缺失:仅清理记录,不进入删除黑名单
      await deleteMediaByIds(expired, false, { block: false });
      s.removed += expired.length;
    }
  }

  // 子目录:递归扫描存在的;消失的清理相册(避免幽灵相册);改名的沿用原相册(保留记录与缩略图)
  if (recursive) {
    const t = await loadTree();
    const kids = t.children.get(a.id) ?? [];
    const seenDirs = new Set(subdirs);
    /** 目录已确实消失(ENOENT)的子相册 */
    const goneKids: AlbumRow[] = [];
    for (const child of kids) {
      if (child.kind !== "mounted" || !child.rootPath) continue;
      if (seenDirs.has(child.rootPath)) continue;
      const st = await fs.stat(child.rootPath).catch((e: NodeJS.ErrnoException) => e);
      if (st instanceof Error) {
        // 只有"确实不存在"才算消失;权限/IO 错误(网络盘抖动)一律保留,避免误删相册
        if (st.code === "ENOENT" || st.code === "ENOTDIR") goneKids.push(child);
        continue;
      }
      if (st.isDirectory()) continue; // 存在但本轮被跳过(SKIP_DIR / 深度上限),保留
      goneKids.push(child);
    }

    /** 本轮新出现、尚无对应相册的子目录 */
    const newDirs = subdirs.filter((d) => !kids.some((c) => c.rootPath === d));

    // 1) 目录改名识别:文件签名集合(数量 + size:mtime 多重集)完全一致 → 视为同一目录改名
    const claimed = new Set<string>();
    for (const dir of newDirs) {
      if (!goneKids.length) break;
      const sig = await dirSignature(dir);
      if (!sig) continue;
      for (const g of goneKids) {
        if (claimed.has(g.id) || !g.rootPath) continue;
        // 连同"已标记缺失"的记录一起比对:文件可能因网络盘短暂不可用被标记过,
        // 若把它们排除在外,改名就会识别失败并退化成"删旧建新"。
        const rows = await db
          .select({ size: media.size, mtimeMs: media.mtimeMs })
          .from(media)
          .where(and(eq(media.albumId, g.id), eq(media.storage, "ext")));
        if (!rows.length || rows.length !== sig.length) continue;
        const have = rows.map((r) => `${r.size}:${r.mtimeMs ?? 0}`).sort().join(",");
        if (have !== sig.join(",")) continue;
        await moveAlbumRoot(g, dir);
        claimed.add(g.id);
        s.albumsMoved++;
        break;
      }
    }

    // 2) 其余消失目录:按【整棵子树】处理,与文件级一致 —— 先软删除(打 missing_at)、
    //    受熔断保护,子树内所有记录都已缺失超过宽限期(或子树本来就没有任何记录)才移除相册子树。
    //    只看目录本层会误判:按年/月分层的中间目录自身没有图片,会被当成"空相册"在第一次扫描就整棵清空。
    const pending = goneKids.filter((g) => !claimed.has(g.id));
    if (pending.length) {
      const plans: Array<{ g: AlbumRow; sub: string[]; rows: Array<{ id: string; missingAt: Date | null }> }> = [];
      for (const g of pending) {
        const sub = descendants(t, g.id);
        const rows = await db.select({ id: media.id, missingAt: media.missingAt }).from(media).where(inArray(media.albumId, sub));
        plans.push({ g, sub, rows });
      }
      // 熔断(写入任何改动之前):本次新消失的记录占本相册子树全部记录的比例过高 → 多半是盘没挂上,中止并保留
      const newly = plans.reduce((n, p) => n + p.rows.filter((r) => !r.missingAt).length, 0);
      if (newly) {
        const [tot] = await db
          .select({ n: sql<number>`CAST(count(*) AS INTEGER)` })
          .from(media)
          .where(inArray(media.albumId, descendants(t, a.id)));
        const total = Number(tot?.n ?? 0);
        const ratio = total ? newly / total : 0;
        if (total >= config.scanPruneMinCount && ratio > config.scanPruneMaxRatio) {
          throw new Error(
            `检测到子目录消失导致 ${newly}/${total} 个文件缺失(${Math.round(ratio * 100)}%),已中止清理并保留现有记录。` +
              `若确属预期(如批量删除),请调大 SCAN_PRUNE_MAX_RATIO 或手动删除后再扫描。`,
          );
        }
      }
      const now = Date.now();
      for (const { g, sub, rows } of plans) {
        const fresh = rows.filter((r) => !r.missingAt);
        if (fresh.length) {
          await db.update(media).set({ missingAt: new Date() }).where(inArray(media.id, fresh.map((r) => r.id)));
          s.missing += fresh.length;
        }
        // 子树里每条记录都已缺失超过宽限期(空子树自然满足)→ 目录确实没了,移除相册子树(记录一并清理,不进黑名单)
        const expired = rows.every((r) => r.missingAt && now - r.missingAt.getTime() > MISSING_GRACE_MS);
        if (expired) {
          if (rows.length) await deleteMediaByIds(rows.map((r) => r.id), false, { block: false });
          await db.delete(albums).where(inArray(albums.id, sub));
          s.albumsRemoved += sub.length;
          invalidateAlbums();
        }
      }
    }

    // 3) 递归扫描(改名后的相册用新路径)
    for (const dir of subdirs) {
      let child = kids.find((c) => c.rootPath === dir);
      if (!child) {
        const [dup] = await db.select().from(albums).where(eq(albums.rootPath, dir)).limit(1);
        if (dup) child = dup;
        else {
          const [created] = await db
            .insert(albums)
            .values({
              id: randomId(14), code: `dir_${randomId(8)}`, name: path.basename(dir), parentId: a.id, kind: "mounted", storage: "ext",
              rootPath: dir, visibility: a.visibility, readonly: a.readonly,
            })
            .returning();
          child = created;
          s.albumsCreated++;
          invalidateAlbums();
        }
      }
      await scanOne(child, recursive, s, depth + 1, blocked);
    }
  }
  await db.update(albums).set({ lastScanAt: new Date() }).where(eq(albums.id, a.id));
}

export async function scanAlbum(code: string, recursive = true): Promise<ScanState> {
  // 竞态修复:先同步占位再 await。原先在 await loadTree() 之后才检查 running,
  // 多个并发请求会同时通过检查,导致同一目录被并行扫描(重复建相册/重复入队)。
  if (scanLocks.has(code)) throw E.conflict("该相册正在扫描中");
  scanLocks.add(code);
  let s: ScanState | null = null;
  try {
    const t = await loadTree();
    const a = t.byCode.get(code);
    if (!a) throw E.notFound("相册不存在");
    if (a.kind !== "mounted" || !a.rootPath) throw E.badRequest("只有挂载的目录相册可以扫描");
    // 互斥范围是整棵相册树:祖先正在递归扫描、或子孙正在扫描时,同一目录会被两个任务并发处理
    // (重复建相册/重复入队/重复标记缺失),所以祖先、子孙任一在扫描都拒绝
    const related = new Set<string>(descendants(t, a.id).filter((id) => id !== a.id).map((id) => t.byId.get(id)?.code ?? ""));
    for (let p = a.parentId ? t.byId.get(a.parentId) : undefined; p; p = p.parentId ? t.byId.get(p.parentId) : undefined) related.add(p.code);
    for (const c of related) {
      if (c && scanLocks.has(c)) {
        throw E.conflict("该相册的父相册或子相册正在扫描中");
      }
    }
    s = {
      running: true, startedAt: new Date().toISOString(), finishedAt: null, added: 0, removed: 0, updated: 0, renamed: 0,
      missing: 0, albumsCreated: 0, albumsRemoved: 0, albumsMoved: 0, truncated: 0, error: null,
    };
    scanStates.set(a.id, s);
    const st = await fs.stat(a.rootPath).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`目录不可访问: ${a.rootPath}(为避免误删,已保留现有记录)`);
    // 扫描开始时一次性取黑名单,避免长扫描里反复过期重查
    const blocked = await blockedExtKeys();
    await scanOne(a, recursive, s, 0, blocked);
  } catch (e) {
    if (s) s.error = String((e as Error).message ?? e);
    else throw e;
  } finally {
    if (s) {
      s.running = false;
      s.finishedAt = new Date().toISOString();
    }
    scanLocks.delete(code);
    invalidateAlbums();
  }
  if (s?.error) throw E.badRequest(s.error, "scan_failed");
  return s!;
}

/** 目录浏览(挂载对话框用):列出子目录 */
export async function browseDirs(p: string) {
  const abs = await assertMountAllowed(path.resolve(p || "/"));
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => {
    throw E.badRequest("无法读取该目录");
  });
  return {
    path: abs,
    parent: path.dirname(abs) === abs ? null : path.dirname(abs),
    dirs: entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort((a, b) => collator.compare(a, b)),
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
