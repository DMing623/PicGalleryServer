// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { db } from "@/db";
import { users } from "@/db/schema";
import { json } from "../http";
import { RateLimited, recentSecurityEvents } from "../hd/guard";
import { requestHdToken, serveHd } from "../hd/service";
import { userMarkCode } from "../hd/watermark";
import { route } from "../router";

/**
 * 高清预览接口(与原图下载 /f/:id、?key= 完全分离):
 *   GET /media/:id/hd-token?w=   申请 90 秒短期令牌(绑定媒体 id + 范围 + 用户)
 *   GET /media/:id/hd?t=&w=      凭令牌取得带水印的高清 WebP(每次请求都重新校验访问权限)
 *   GET /security/events         最近的安全事件(需 status 权限)
 *   GET /security/watermark?code=U-XXXXXX   反查动态水印对应的用户(需 users 权限)
 */

function limited(e: RateLimited): Response {
  return json(
    { ok: false, error: { code: "too_many_requests", message: e.message } },
    { status: 429, headers: { "retry-after": String(e.retryAfter), "cache-control": "private, no-store" } },
  );
}

route("GET", "/media/:id/hd-token", "public", async (ctx) => {
  try {
    return await requestHdToken(ctx.req, ctx.params.id, ctx.user, ctx.ip, ctx.q.get("w"));
  } catch (e) {
    if (e instanceof RateLimited) return limited(e);
    throw e;
  }
});

route("GET", "/media/:id/hd", "public", async (ctx) => {
  try {
    return await serveHd(ctx.req, ctx.params.id, ctx.user, ctx.ip);
  } catch (e) {
    if (e instanceof RateLimited) return limited(e);
    throw e;
  }
});

route("GET", "/security/events", "status", async (ctx) => ({ events: recentSecurityEvents(Math.min(300, Number(ctx.q.get("limit")) || 100)) }));

route("GET", "/security/watermark", "users", async (ctx) => {
  const code = (ctx.q.get("code") ?? "").trim().toUpperCase();
  const rows = await db.select({ id: users.id, username: users.username, role: users.role }).from(users);
  return { matches: rows.filter((u) => userMarkCode(u.id) === code) };
});
