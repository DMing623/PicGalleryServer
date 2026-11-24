// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { noticeReads, notices } from "@/db/schema";
import type { AuthUser } from "./auth";
import { E } from "./http";
import { randomId } from "./media/types";

/**
 * 站点通知:管理者及以上发布,所有登录用户可读。
 *
 * 已读状态按「用户 × 通知」记录在 pgs_notice_reads 里;游客没有账户,
 * 其已读状态保存在浏览器 localStorage(前端处理),服务端只返回空列表。
 */

export interface NoticeDto {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  createdByName: string;
  read: boolean;
}

const MAX_NOTICES = 300;

export async function listNotices(user: AuthUser | null): Promise<{ items: NoticeDto[]; unread: number; total: number }> {
  if (!user) return { items: [], unread: 0, total: 0 };
  const rows = await db
    .select()
    .from(notices)
    .orderBy(desc(notices.createdAt))
    .limit(MAX_NOTICES);
  const reads = rows.length
    ? await db
        .select({ noticeId: noticeReads.noticeId })
        .from(noticeReads)
        .where(and(eq(noticeReads.userId, user.id), inArray(noticeReads.noticeId, rows.map((r) => r.id))))
    : [];
  const readSet = new Set(reads.map((r) => r.noticeId));
  const items = rows.map<NoticeDto>((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    pinned: !!r.pinned,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    createdBy: r.createdBy ?? null,
    createdByName: r.createdByName ?? "",
    read: readSet.has(r.id),
  }));
  return { items, unread: items.filter((i) => !i.read).length, total: items.length };
}

/** 未读数(铃铛红点用),不返回正文,开销很小 */
export async function unreadCount(user: AuthUser | null): Promise<number> {
  if (!user) return 0;
  const [total] = await db.select({ n: sql<number>`CAST(count(*) AS INTEGER)` }).from(notices);
  const [read] = await db
    .select({ n: sql<number>`CAST(count(*) AS INTEGER)` })
    .from(noticeReads)
    .where(eq(noticeReads.userId, user.id));
  return Math.max(0, Number(total?.n ?? 0) - Number(read?.n ?? 0));
}

export async function createNotice(input: { title: string; body: string; pinned?: boolean }, user: AuthUser): Promise<NoticeDto> {
  const title = String(input.title ?? "").trim();
  if (!title) throw E.badRequest("标题不能为空");
  if (title.length > 120) throw E.badRequest("标题最多 120 字");
  const body = String(input.body ?? "");
  if (body.length > 100_000) throw E.badRequest("正文过长(上限 100000 字符)");
  const now = new Date();
  const row = {
    id: randomId(14),
    title,
    body,
    pinned: !!input.pinned,
    createdBy: user.id,
    createdByName: user.username,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(notices).values(row);
  // 发布者自己视为已读,避免刚发完就给自己亮红点
  await db.insert(noticeReads).values({ userId: user.id, noticeId: row.id, readAt: now }).onConflictDoNothing();
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    pinned: row.pinned,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    createdBy: user.id,
    createdByName: user.username,
    read: true,
  };
}

export async function updateNotice(id: string, patch: { title?: string; body?: string; pinned?: boolean }): Promise<NoticeDto> {
  const [row] = await db.select().from(notices).where(eq(notices.id, id)).limit(1);
  if (!row) throw E.notFound("通知不存在");
  const set: Partial<typeof notices.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) {
    const t = String(patch.title).trim();
    if (!t) throw E.badRequest("标题不能为空");
    if (t.length > 120) throw E.badRequest("标题最多 120 字");
    set.title = t;
  }
  if (patch.body !== undefined) {
    const b = String(patch.body);
    if (b.length > 100_000) throw E.badRequest("正文过长(上限 100000 字符)");
    set.body = b;
  }
  if (patch.pinned !== undefined) set.pinned = !!patch.pinned;
  await db.update(notices).set(set).where(eq(notices.id, id));
  const [out] = await db.select().from(notices).where(eq(notices.id, id)).limit(1);
  return {
    id: out.id,
    title: out.title,
    body: out.body,
    pinned: !!out.pinned,
    createdAt: out.createdAt.toISOString(),
    updatedAt: out.updatedAt.toISOString(),
    createdBy: out.createdBy ?? null,
    createdByName: out.createdByName ?? "",
    read: true,
  };
}

export async function deleteNotice(id: string): Promise<boolean> {
  const gone = await db.delete(notices).where(eq(notices.id, id)).returning({ id: notices.id });
  if (!gone.length) return false;
  await db.delete(noticeReads).where(eq(noticeReads.noticeId, id));
  return true;
}

/** 一键已读:把当前所有通知标记为已读 */
export async function markAllRead(user: AuthUser): Promise<{ marked: number }> {
  const rows = await db.select({ id: notices.id }).from(notices).limit(MAX_NOTICES);
  if (!rows.length) return { marked: 0 };
  const existing = await db
    .select({ noticeId: noticeReads.noticeId })
    .from(noticeReads)
    .where(eq(noticeReads.userId, user.id));
  const done = new Set(existing.map((r) => r.noticeId));
  const todo = rows.filter((r) => !done.has(r.id));
  if (todo.length) {
    const now = new Date();
    await db
      .insert(noticeReads)
      .values(todo.map((r) => ({ userId: user.id, noticeId: r.id, readAt: now })))
      .onConflictDoNothing();
  }
  return { marked: todo.length };
}

export async function markRead(user: AuthUser, id: string): Promise<void> {
  await db.insert(noticeReads).values({ userId: user.id, noticeId: id, readAt: new Date() }).onConflictDoNothing();
}
