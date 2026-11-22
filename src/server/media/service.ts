// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { and, asc, desc, eq, inArray, like, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { media } from "@/db/schema";
import { can, issueStreamToken, type AuthUser } from "../auth";
import { breadcrumbs, deleteMediaByIds, invalidateAlbums, loadTree, resolveAlbum, scopeIds, visibleIds } from "../albums";
import { config } from "../config";
import { E } from "../http";
import { enqueue } from "../queue";
import { buildSearchText, type MediaMeta } from "./metadata";

/** 媒体查询、DTO 与更新。所有读取都经过可见性过滤。 */

type Row = typeof media.$inferSelect;

const listCols = {
  id: media.id, albumId: media.albumId, kind: media.kind, filename: media.filename, mime: media.mime, size: media.size,
  width: media.width, height: media.height, duration: media.duration, takenAt: media.takenAt, sortAt: media.sortAt,
  status: media.status, color: media.color, note: media.note,
};
type ListRow = Pick<Row, keyof typeof listCols>;

export function mediaDto(r: ListRow, albumCode: string | null) {
  return {
    id: r.id, kind: r.kind, filename: r.filename, mime: r.mime, size: r.size, width: r.width, height: r.height,
    duration: r.duration, takenAt: r.takenAt, sortAt: r.sortAt, status: r.status, color: r.color,
    album: albumCode, hasNote: !!r.note,
    thumbUrl: `/api/v1/media/${r.id}/thumb`, previewUrl: `/api/v1/media/${r.id}/preview`,
  };
}

const enc = (ts: Date, id: string) => Buffer.from(JSON.stringify([ts.toISOString(), id])).toString("base64url");
function dec(c: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string" && !Number.isNaN(Date.parse(v[0]))) return [v[0], v[1]];
  } catch {
    /* fallthrough */
  }
  throw E.badRequest("cursor 无效");
}

export interface ListOptions {
  user: AuthUser | null;
  /** 相册代码;"_unsorted" = 未归类(需登录);空 = 全局 */
  album?: string | null;
  q?: string | null;
  kind?: string | null;
  /** 是否包含子相册。全局搜索无意义 */
  recursive?: boolean;
  cursor?: string | null;
  limit?: number;
  order?: "asc" | "desc";
  from?: string | null;
  to?: string | null;
}

export async function listMedia(o: ListOptions) {
  const { t, allowed } = await visibleIds(o.user);
  const conds: SQL[] = [];

  if (o.album === "_unsorted") {
    if (!o.user) throw E.notFound("相册不存在");
    conds.push(sql`${media.albumId} IS NULL`);
  } else if (o.album) {
    // 相册内搜索/浏览:范围严格限定在该相册(及可选的子相册)
    const { album } = await resolveAlbum(o.album, o.user);
    const ids = scopeIds(t, album, o.recursive !== false, allowed);
    if (!ids.length) return { items: [], nextCursor: null };
    conds.push(inArray(media.albumId, ids));
  } else if (allowed) {
    if (!allowed.size) return { items: [], nextCursor: null };
    conds.push(inArray(media.albumId, [...allowed]));
  }

  if (o.kind === "image" || o.kind === "video") conds.push(eq(media.kind, o.kind));
  if (o.from && !Number.isNaN(Date.parse(o.from))) conds.push(sql`${media.sortAt} >= ${new Date(o.from).toISOString()}::timestamptz`);
  if (o.to && !Number.isNaN(Date.parse(o.to))) conds.push(sql`${media.sortAt} <= ${new Date(o.to).toISOString()}::timestamptz`);
  const terms = (o.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  for (const term of terms) conds.push(like(media.searchText, `%${term.replace(/[\\%_]/g, "\\$&")}%`));

  const asc_ = o.order === "asc";
  if (o.cursor) {
    const [ts, id] = dec(o.cursor);
    conds.push(asc_ ? sql`(${media.sortAt}, ${media.id}) > (${ts}::timestamptz, ${id})` : sql`(${media.sortAt}, ${media.id}) < (${ts}::timestamptz, ${id})`);
  }
  const limit = Math.min(200, Math.max(1, o.limit ?? 60));
  const rows = await db
    .select(listCols)
    .from(media)
    .where(and(...conds))
    .orderBy(asc_ ? asc(media.sortAt) : desc(media.sortAt), asc_ ? asc(media.id) : desc(media.id))
    .limit(limit + 1);
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => mediaDto(r, r.albumId ? t.byId.get(r.albumId)?.code ?? null : null)),
    nextCursor: more && last ? enc(last.sortAt, last.id) : null,
  };
}

/** 取媒体行并校验可见性 */
export async function getVisible(id: string, user: AuthUser | null): Promise<Row> {
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
  if (!row) throw E.notFound("文件不存在");
  if (!(await canSee(row.albumId, user))) throw E.notFound("文件不存在");
  return row;
}

export async function canSee(albumId: string | null, user: AuthUser | null): Promise<boolean> {
  if (user) return true;
  if (!albumId) return false;
  const { allowed } = await visibleIds(null);
  return !!allowed?.has(albumId);
}

export function baseUrl(req: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  return `${proto}://${host}`;
}

export async function mediaDetail(id: string, user: AuthUser | null, req: Request) {
  const row = await getVisible(id, user);
  const t = await loadTree();
  const album = row.albumId ? t.byId.get(row.albumId) : undefined;
  const base = baseUrl(req);
  const fileUrl = `${base}/f/${row.id}`;
  const privileged = can(user, "album.mount");
  return {
    ...mediaDto(row, album?.code ?? null),
    note: row.note,
    error: row.error,
    meta: (row.meta as MediaMeta | null) ?? null,
    storage: row.storage,
    storageKey: privileged ? row.storageKey : null,
    hash: privileged ? row.hash : null,
    createdAt: row.createdAt,
    breadcrumbs: album ? breadcrumbs(t, album) : [],
    canEdit: can(user, "media.edit"),
    canOriginal: can(user, "original"),
    links: {
      file: fileUrl,
      thumb: `${base}/api/v1/media/${row.id}/thumb`,
      preview: `${base}/api/v1/media/${row.id}/preview`,
      /** 原文件需追加 ?key=<下载密钥> */
      originalTemplate: `${fileUrl}?key=<KEY>`,
      html: row.kind === "video" ? `<video src="${fileUrl}?key=<KEY>" controls></video>` : `<img src="${fileUrl}" alt="${row.filename.replace(/"/g, "&quot;")}">`,
      markdown: row.kind === "video" ? `[${row.filename}](${fileUrl}?key=<KEY>)` : `![${row.filename}](${fileUrl})`,
    },
    streamUrl: row.kind === "video" ? `/api/v1/media/${row.id}/stream?t=${issueStreamToken(row.id)}` : null,
  };
}

export async function updateMedia(id: string, patch: Record<string, unknown>) {
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
  if (!row) throw E.notFound("文件不存在");
  const set: Partial<typeof media.$inferInsert> = {};
  if (patch.note !== undefined) {
    if (typeof patch.note !== "string") throw E.badRequest("note 必须是字符串");
    if (patch.note.length > 5000) throw E.badRequest("备注过长(最多 5000 字符)");
    set.note = patch.note;
    set.searchText = buildSearchText(row.filename, patch.note, row.meta as MediaMeta | null);
  }
  if (patch.album !== undefined) {
    if (patch.album === null || patch.album === "") set.albumId = null;
    else {
      const t = await loadTree();
      const a = t.byCode.get(String(patch.album));
      if (!a) throw E.badRequest("目标相册不存在", "album_not_found");
      set.albumId = a.id;
    }
  }
  if (!Object.keys(set).length) throw E.badRequest("没有可更新的字段");
  await db.update(media).set(set).where(eq(media.id, id));
  invalidateAlbums();
}

export async function batchAction(body: { action?: unknown; ids?: unknown; album?: unknown; purge?: unknown }, user: AuthUser) {
  if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 2000) throw E.badRequest("ids 必须是 1~2000 个 id 的数组");
  const ids = body.ids.map(String);
  switch (body.action) {
    case "delete":
      if (!can(user, "media.delete")) throw E.forbidden("需要权限: media.delete");
      await deleteMediaByIds(ids, body.purge === true);
      return { affected: ids.length };
    case "move": {
      const t = await loadTree();
      let albumId: string | null = null;
      if (body.album) {
        const a = t.byCode.get(String(body.album));
        if (!a) throw E.badRequest("目标相册不存在", "album_not_found");
        albumId = a.id;
      }
      await db.update(media).set({ albumId }).where(inArray(media.id, ids));
      invalidateAlbums();
      return { affected: ids.length };
    }
    case "reprocess":
      await db.update(media).set({ status: "pending", error: null }).where(inArray(media.id, ids));
      ids.forEach((i) => enqueue(i, true));
      return { affected: ids.length };
    default:
      throw E.badRequest("action 只能是 delete | move | reprocess");
  }
}

export async function reprocessFailed(): Promise<number> {
  const rows = await db.select({ id: media.id }).from(media).where(inArray(media.status, ["failed", "pending"]));
  rows.forEach((r) => enqueue(r.id));
  return rows.length;
}
