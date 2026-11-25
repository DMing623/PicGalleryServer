// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { and, asc, desc, eq, inArray, like, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { media } from "@/db/schema";
import { can, issueStreamToken, type AuthUser } from "../auth";
import { breadcrumbs, deleteMediaByIds, invalidateAlbums, loadTree, relocateExtFile, relocateLocalFile, resolveAlbum, scopeIds, visibleIds } from "../albums";
import { config } from "../config";
import { E } from "../http";
import { enqueue } from "../queue";
import { buildSearchText, type MediaMeta, type Scalar } from "./metadata";

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
  /** 是否包含子相册。默认 false:父相册只显示自身文件,子相册文件仅在子相册内显示 */
  recursive?: boolean;
  cursor?: string | null;
  limit?: number;
  order?: "asc" | "desc";
  from?: string | null;
  to?: string | null;
  /** 是否包含处理失败(疑似损坏)的记录。默认 false:这类文件没有缩略图也不可看,统一在系统状态页处理 */
  includeFailed?: boolean;
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
    const ids = scopeIds(t, album, o.recursive === true, allowed);
    if (!ids.length) return { items: [], nextCursor: null };
    conds.push(inArray(media.albumId, ids));
  } else if (allowed) {
    if (!allowed.size) return { items: [], nextCursor: null };
    conds.push(inArray(media.albumId, [...allowed]));
  }

  if (o.kind === "image" || o.kind === "video") conds.push(eq(media.kind, o.kind));
  if (o.from && !Number.isNaN(Date.parse(o.from))) conds.push(sql`${media.sortAt} >= ${new Date(o.from).toISOString()}`);
  if (o.to && !Number.isNaN(Date.parse(o.to))) conds.push(sql`${media.sortAt} <= ${new Date(o.to).toISOString()}`);
  // 软删除(扫描时暂时消失)的记录不参与列表与搜索
  conds.push(sql`${media.missingAt} IS NULL`);
  // 处理失败的记录(损坏/伪造文件)默认不展示:没有缩略图、也打不开,
  // 集中到「系统状态 → 疑似损坏文件」里一键清理(见 media/corrupt.ts)
  if (!o.includeFailed) conds.push(sql`${media.status} <> 'failed'`);
  const terms = (o.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  for (const term of terms) {
    const pat = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    // 备注只对登录用户参与匹配:公开搜索若包含 note 会形成逐字探测备注的侧信道(issue §11.3)
    conds.push(
      o.user
        ? sql`(${media.searchText} LIKE ${pat} OR lower(${media.note}) LIKE ${pat})`
        : like(media.searchText, pat),
    );
  }

  const asc_ = o.order === "asc";
  if (o.cursor) {
    const [ts, id] = dec(o.cursor);
    conds.push(asc_ ? sql`(${media.sortAt}, ${media.id}) > (${ts}, ${id})` : sql`(${media.sortAt}, ${media.id}) < (${ts}, ${id})`);
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
  if (!row || row.missingAt) throw E.notFound("文件不存在");
  if (!(await canSee(row.albumId, user))) throw E.notFound("文件不存在");
  return row;
}

export async function canSee(albumId: string | null, user: AuthUser | null): Promise<boolean> {
  if (user) return true;
  if (!albumId) return false;
  const { allowed } = await visibleIds(null);
  return !!allowed?.has(albumId);
}

/**
 * 生成对外链接的基地址(issue §1.9)。
 * 未配置 PUBLIC_BASE_URL 时用请求头拼,但必须经过 ALLOWED_HOSTS / PUBLIC_BASE_URL 白名单校验,
 * 防止攻击者用伪造 Host 让接口返回指向恶意域名的链接(链接投毒),也防止水印层缓存被刷爆。
 */
export function baseUrl(req: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const allowed = config.allowedHosts.length ? config.allowedHosts : [new URL(req.url).host.toLowerCase()];
  const bare = host.toLowerCase().split(":")[0];
  if (!allowed.includes(host.toLowerCase()) && !allowed.includes(bare)) {
    // 不在白名单:回落到请求自身 host(而不是攻击者提供的值)
    return `${proto}://${new URL(req.url).host}`;
  }
  return `${proto}://${host}`;
}

/**
 * 按角色裁剪元数据(issue §1.7):
 *  - 登录用户:完整 meta;
 *  - 游客 basic:去掉 GPS、机身序列号、原始段 raw、作者/版权邮箱等敏感字段;
 *  - 游客 none:不返回 meta。
 */
function guestMetaView(meta: MediaMeta | null): MediaMeta | null {
  if (!meta || config.guestMeta === "full") return meta;
  if (config.guestMeta === "none") return null;
  const summary = meta.summary;
  // 字段名与 metadata.ts 的 summary 结构保持一致
  const camera: Record<string, Scalar> = { ...summary.camera };
  delete camera.serial;
  const authoring: Record<string, Scalar> = { ...summary.authoring };
  for (const k of ["artist", "copyright", "userComment"]) delete authoring[k];
  return {
    summary: { ...summary, camera, authoring, gps: {} },
    ai: meta.ai,
    video: meta.video,
    text: {},
    raw: {},
  };
}

export async function mediaDetail(id: string, user: AuthUser | null, req: Request) {
  const row = await getVisible(id, user);
  const t = await loadTree();
  const album = row.albumId ? t.byId.get(row.albumId) : undefined;
  const base = baseUrl(req);
  const fileUrl = `${base}/f/${row.id}`;
  const privileged = can(user, "album.mount");
  const isGuest = !user;
  return {
    ...mediaDto(row, album?.code ?? null),
    // 备注默认只对登录用户可见;错误信息可能含服务器路径,同样只给登录用户(issue §11.4)
    note: isGuest && !config.guestNote ? null : row.note,
    error: isGuest ? null : row.error,
    meta: isGuest ? guestMetaView((row.meta as MediaMeta | null) ?? null) : ((row.meta as MediaMeta | null) ?? null),
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
  }
  if (patch.album !== undefined) {
    if (patch.album === null || patch.album === "") set.albumId = null;
    else {
      const t = await loadTree();
      const a = t.byCode.get(String(patch.album));
      if (!a) throw E.badRequest("目标相册不存在", "album_not_found");
      if (a.readonly) throw E.forbidden("目标相册是只读挂载目录,不能移入文件");
      set.albumId = a.id;
    }
  }
  if (!Object.keys(set).length) throw E.badRequest("没有可更新的字段");
  // 先移动文件、成功后再改库:搬失败时记录仍指向旧路径,不会被下一次扫描误删(issue §2.2)
  if (set.albumId !== undefined && set.albumId !== row.albumId) {
    if (row.storage === "ext") {
      const moved = await relocateExtFile(row, set.albumId);
      if (moved) {
        set.storageKey = moved.storageKey;
        set.filename = moved.filename;
      }
    } else if (row.storage === "local") {
      const moved = await relocateLocalFile(row, set.albumId);
      if (moved) {
        set.storageKey = moved.storageKey;
        set.filename = moved.filename;
      }
    }
  }
  await db.update(media).set(set).where(eq(media.id, id));
  invalidateAlbums();
}

export async function batchAction(body: { action?: unknown; ids?: unknown; album?: unknown; purge?: unknown }, user: AuthUser) {
  if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 2000) throw E.badRequest("ids 必须是 1~2000 个 id 的数组");
  const ids = body.ids.map(String);
  switch (body.action) {
    case "delete": {
      if (!can(user, "media.delete")) throw E.forbidden("需要权限: media.delete");
      // 物理删除源文件需要更高权限(admin),manager 的"删除"保持"排除/回收站"语义(issue §1.10)
      if (body.purge === true && !can(user, "media.purge")) throw E.forbidden("物理删除源文件需要管理员权限");
      const r = await deleteMediaByIds(ids, body.purge === true, { user });
      return { affected: r.removed, purge: body.purge === true, failed: r.failed };
    }
    case "move": {
      const t = await loadTree();
      let albumId: string | null = null;
      if (body.album) {
        const a = t.byCode.get(String(body.album));
        if (!a) throw E.badRequest("目标相册不存在", "album_not_found");
        if (a.readonly) throw E.forbidden("目标相册是只读挂载目录,不能移入文件");
        albumId = a.id;
      }
      const rows = await db.select().from(media).where(inArray(media.id, ids));
      // 逐项结果:某个文件搬失败不影响其它文件,调用方能看到具体原因(issue §2.2)
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      for (const r of rows) {
        try {
          const set: Partial<typeof media.$inferInsert> = { albumId };
          if (r.storage === "ext" && albumId !== r.albumId) {
            const moved = await relocateExtFile(r, albumId);
            if (moved) {
              set.storageKey = moved.storageKey;
              set.filename = moved.filename;
            }
          } else if (r.storage === "local" && albumId !== r.albumId) {
            // 受管相册的文件也要真正搬到目标目录,否则目录与归属脱节(与 §2.6 同理)
            const moved = await relocateLocalFile(r, albumId);
            if (moved) {
              set.storageKey = moved.storageKey;
              set.filename = moved.filename;
            }
          }
          await db.update(media).set(set).where(eq(media.id, r.id));
          results.push({ id: r.id, ok: true });
        } catch (e) {
          results.push({ id: r.id, ok: false, error: String((e as Error)?.message ?? e) });
        }
      }
      invalidateAlbums();
      return { affected: results.filter((r) => r.ok).length, results };
    }
    case "reprocess":
      await db.update(media).set({ status: "pending", error: null, attempts: 0, processingStartedMs: null }).where(inArray(media.id, ids));
      ids.forEach((i) => enqueue(i, true));
      return { affected: ids.length };
    default:
      throw E.badRequest("action 只能是 delete | move | reprocess");
  }
}

export async function reprocessFailed(): Promise<number> {
  const rows = await db.select({ id: media.id }).from(media).where(inArray(media.status, ["failed", "pending"]));
  // 用户主动「重新处理」:清零中断计数,[INTERRUPTED] / [LIMIT] 的文件也给一次机会
  await db.update(media).set({ status: "pending", error: null, attempts: 0, processingStartedMs: null }).where(inArray(media.status, ["failed"]));
  rows.forEach((r) => enqueue(r.id));
  return rows.length;
}
