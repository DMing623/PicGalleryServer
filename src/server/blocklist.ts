// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db, isUniqueViolation } from "@/db";
import { albums, blocklist, media } from "@/db/schema";
import type { AuthUser } from "./auth";
import { E } from "./http";
import { randomId } from "./media/types";
import { enqueue } from "./queue";
import { driverFor } from "./storage";

/**
 * 删除黑名单(排除名单)。
 *
 * 删除媒体时若未勾选「同时删除源文件」,原文件保留在服务器上,只把记录移入本表:
 *  - 挂载目录扫描时按 (storage='ext', storage_key=绝对路径) 跳过,文件不会被重新入库
 *  - 设置页「删除黑名单」可解除(恢复记录并重新生成缩略图),或彻底删除源文件
 *
 * 本模块刻意不 import ./albums,避免与 albums.ts(需要调用 addToBlocklist)形成循环依赖。
 */

type Row = typeof media.$inferSelect;

/** 扫描时用于快速跳过的 ext 路径集合(5 秒内存缓存) */
let extCache: { at: number; keys: Set<string> } | null = null;

export function invalidateBlocklist() {
  extCache = null;
}

export async function blockedExtKeys(): Promise<Set<string>> {
  if (extCache && Date.now() - extCache.at < 5000) return extCache.keys;
  const rows = await db.select({ k: blocklist.storageKey }).from(blocklist).where(eq(blocklist.storage, "ext"));
  extCache = { at: Date.now(), keys: new Set(rows.map((r) => r.k)) };
  return extCache.keys;
}

/** 把即将删除的媒体记录写入黑名单(同 (storage,key) 已存在则忽略) */
export async function addToBlocklist(rows: Row[], user: AuthUser | null) {
  if (!rows.length) return;
  const values: Array<typeof blocklist.$inferInsert> = rows.map((r) => ({
    id: randomId(14),
    mediaId: r.id,
    albumId: r.albumId,
    albumCode: null,
    kind: r.kind,
    filename: r.filename,
    mime: r.mime,
    size: r.size,
    storage: r.storage,
    storageKey: r.storageKey,
    hash: r.hash,
    takenAt: r.takenAt,
    sortAt: r.sortAt,
    meta: r.meta,
    note: r.note,
    createdBy: user?.id ?? null,
  }));
  // 相册代码随记录一起保存,便于相册被删除后仍能说明来源
  const ids = [...new Set(rows.map((r) => r.albumId).filter((v): v is string => !!v))];
  if (ids.length) {
    const names = await db.select({ id: albums.id, code: albums.code }).from(albums);
    const byId = new Map(names.map((a) => [a.id, a.code]));
    for (const v of values) v.albumCode = v.albumId ? byId.get(v.albumId) ?? null : null;
  }
  await db.insert(blocklist).values(values).onConflictDoNothing();
  invalidateBlocklist();
}

export async function listBlocklist() {
  const rows = await db
    .select({
      id: blocklist.id,
      mediaId: blocklist.mediaId,
      albumId: blocklist.albumId,
      albumCode: blocklist.albumCode,
      kind: blocklist.kind,
      filename: blocklist.filename,
      mime: blocklist.mime,
      size: blocklist.size,
      storage: blocklist.storage,
      storageKey: blocklist.storageKey,
      note: blocklist.note,
      createdBy: blocklist.createdBy,
      createdAt: blocklist.createdAt,
      albumName: albums.name,
    })
    .from(blocklist)
    .leftJoin(albums, eq(blocklist.albumId, albums.id))
    .orderBy(desc(blocklist.createdAt));
  return rows;
}

async function getEntry(id: string) {
  const [b] = await db.select().from(blocklist).where(eq(blocklist.id, id)).limit(1);
  if (!b) throw E.notFound("黑名单记录不存在");
  return b;
}

/** 解除黑名单:恢复媒体记录(状态 pending)并重新生成缩略图/预览图 */
export async function unblock(id: string) {
  const b = await getEntry(id);
  const driver = await driverFor(b.storage);
  const info = await driver.stat(b.storageKey);
  if (!info) throw E.badRequest("源文件已不存在,无法恢复(可直接彻底删除该记录)", "source_missing");

  let albumId: string | null = null;
  if (b.albumId) {
    const [a] = await db.select({ id: albums.id }).from(albums).where(eq(albums.id, b.albumId)).limit(1);
    albumId = a?.id ?? null;
  }
  // 复用原 id:删除→反悔后 /f/<id> 外链仍然有效(issue §2.5)
  const reuseId = b.mediaId;
  let newId = reuseId && reuseId.length ? reuseId : randomId(12);
  const values = {
    albumId,
    kind: b.kind,
    filename: b.filename,
    mime: b.mime,
    size: info.size,
    hash: b.hash,
    takenAt: b.takenAt,
    sortAt: b.sortAt ?? new Date(),
    storage: b.storage,
    storageKey: b.storageKey,
    status: "pending" as const,
    note: b.note,
    meta: b.meta,
    searchText: b.filename.toLowerCase(),
  };
  try {
    await db.insert(media).values({ id: newId, ...values });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // id 或 (storage,storage_key) 冲突:先换新 id 再试一次;仍冲突说明同一源文件已有记录
    newId = randomId(12);
    try {
      await db.insert(media).values({ id: newId, ...values });
    } catch (e2) {
      if (isUniqueViolation(e2)) throw E.conflict("该文件已存在于相册中,无需恢复");
      throw e2;
    }
  }
  await db.delete(blocklist).where(eq(blocklist.id, id));
  invalidateBlocklist();
  enqueue(newId, true); // 重新生成缩略图与元数据
  return { id: newId, albumId };
}

/** 彻底删除:移除服务器上的源文件并删除黑名单记录 */
export async function purgeBlocked(id: string) {
  const b = await getEntry(id);
  // 挂载目录里的文件不归本系统管:只读挂载拒绝物理删除(issue §1.10)。
  // 不能只按 album_id 查 readonly:挂载登记被移除后相册行已不存在,会得到 undefined 而误放行。
  // 因此按源文件路径找覆盖它的已登记挂载(取最深的一层);找不到(登记已移除)同样拒绝。
  if (b.storage === "ext") {
    const mounts = await db.select({ rootPath: albums.rootPath, readonly: albums.readonly }).from(albums).where(eq(albums.kind, "mounted"));
    let best: { root: string; readonly: boolean } | null = null;
    for (const m of mounts) {
      if (!m.rootPath) continue;
      const root = path.resolve(m.rootPath);
      if ((b.storageKey === root || b.storageKey.startsWith(root + path.sep)) && (!best || root.length > best.root.length)) {
        best = { root, readonly: !!m.readonly };
      }
    }
    if (!best) throw E.forbidden("该文件所在的挂载目录已不在登记中,无法确认是否可写,不能物理删除(请先重新挂载为可写目录)");
    if (best.readonly) throw E.forbidden("该文件位于只读挂载目录,不能物理删除");
  }
  try {
    await (await driverFor(b.storage)).remove(b.storageKey);
  } catch (e) {
    console.error("[blocklist] remove source failed", b.storageKey, e);
    throw E.conflict(`删除源文件失败:${(e as Error)?.message ?? e}`);
  }
  await db.delete(blocklist).where(eq(blocklist.id, id));
  invalidateBlocklist();
  return { deleted: true };
}
