// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { E, readJson, str } from "../http";
import { createNotice, deleteNotice, listNotices, markAllRead, markRead, unreadCount, updateNotice } from "../notices";
import { route } from "../router";
import { getSite } from "../settings";

/** 站点通知:读取 / 未读数 / 发布 / 编辑 / 删除 / 已读 */

route("GET", "/notices", "public", async (ctx) => {
  const site = await getSite();
  const data = await listNotices(ctx.user);
  return { ...data, timezone: site.timezone };
});

route("GET", "/notices/unread", "public", async (ctx) => ({ unread: await unreadCount(ctx.user) }));

route("POST", "/notices/read-all", "user", async (ctx) => markAllRead(ctx.user!));

route("POST", "/notices/:id/read", "user", async (ctx) => {
  await markRead(ctx.user!, ctx.params.id);
  return { read: true };
});

route("POST", "/notices", "notice.publish", async (ctx) => {
  const b = await readJson(ctx.req);
  return createNotice(
    { title: str(b.title, "title", { max: 120 }), body: typeof b.body === "string" ? b.body : "", pinned: !!b.pinned },
    ctx.user!,
  );
});

route("PATCH", "/notices/:id", "notice.publish", async (ctx) => {
  const b = await readJson(ctx.req);
  return updateNotice(ctx.params.id, {
    title: b.title === undefined ? undefined : String(b.title),
    body: b.body === undefined ? undefined : String(b.body),
    pinned: b.pinned === undefined ? undefined : !!b.pinned,
  });
});

route("DELETE", "/notices/:id", "notice.publish", async (ctx) => {
  if (!ctx.params.id) throw E.badRequest("缺少通知 id");
  await deleteNotice(ctx.params.id);
  return { deleted: true };
});
