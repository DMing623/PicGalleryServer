// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { hdCacheInfo } from "../hd/cache";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, invalidateUserCache, isRole, ROLES, validatePasswordStrength } from "../auth";
import { config } from "../config";
import { E, json, readJson, str, intParam } from "../http";
import { createKey, deleteKeyById, deleteKeyByValue, listKeys, verifyKey } from "../keys";
import { corruptSummary, purgeCorrupt } from "../media/corrupt";
import { invalidateAlbums, invalidateMediaCaches } from "../albums";
import { queueStats } from "../queue";
import { route } from "../router";
import { s3Available } from "../storage";

/** 下载密钥、用户账户、系统状态 */

/* ---------- 下载密钥 ---------- */

route("GET", "/keys", "keys", async () => ({ keys: await listKeys() }));

/** 创建或更新(相同密钥重复提交 = 更新有效期)。 body: {key?, label?, expires: never|24h|custom, ttlHours?} */
route("POST", "/keys", "keys", async (ctx) => {
  const b = await readJson(ctx.req);
  return json({ ok: true, data: await createKey({ ...b, createdBy: ctx.user!.id }) }, { status: 201 });
});

route("DELETE", "/keys/:id", "keys", async (ctx) => {
  if (!(await deleteKeyById(ctx.params.id))) throw E.notFound("密钥不存在");
  return { deleted: true };
});

/** 按明文密钥删除: DELETE /keys?key=xxxx(兼容旧写法) */
route("DELETE", "/keys", "keys", async (ctx) => {
  const k = ctx.q.get("key");
  if (!k) throw E.badRequest("缺少 key 参数");
  if (!(await deleteKeyByValue(k))) throw E.notFound("密钥不存在");
  return { deleted: true };
});

/** 推荐写法:密钥放 body,避免明文进访问日志(issue §1.5) */
route("POST", "/keys/revoke", "keys", async (ctx) => {
  const b = await readJson(ctx.req);
  const k = typeof b.key === "string" ? b.key : "";
  if (!k) throw E.badRequest("缺少 key");
  if (!(await deleteKeyByValue(k))) throw E.notFound("密钥不存在");
  return { deleted: true };
});

route("GET", "/keys/verify", "keys", async (ctx) => ({ valid: await verifyKey(ctx.q.get("key"), false) }));

route("POST", "/keys/verify", "keys", async (ctx) => {
  const b = await readJson(ctx.req);
  return { valid: await verifyKey(typeof b.key === "string" ? b.key : null, false) };
});

/* ---------- 用户 ---------- */

const USERNAME = /^[A-Za-z0-9_.-]{3,32}$/;

const userDto = (u: typeof users.$inferSelect) => ({
  id: u.id, username: u.username, role: u.role, disabled: u.disabled, source: u.source, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
});
route("GET", "/users", "users", async () => {
  const rows = await db.select().from(users).orderBy(users.createdAt);
  return { users: rows.map(userDto), roles: ROLES };
});

route("POST", "/users", "users", async (ctx) => {
  const b = await readJson(ctx.req);
  const username = str(b.username, "username");
  if (!USERNAME.test(username)) throw E.badRequest("用户名只能含字母数字 _ . -,长度 3~32");
  const role = b.role ?? "viewer";
  if (!isRole(role)) throw E.badRequest(`role 只能是 ${ROLES.join(" | ")}`);
  const password = str(b.password, "password");
  validatePasswordStrength(password);
  const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (dup) throw E.conflict("用户名已存在");
  const [row] = await db.insert(users).values({ id: randomUUID(), username, passwordHash: await hashPassword(password), role, source: "api" }).returning();
  return json({ ok: true, data: userDto(row) }, { status: 201 });
});

route("PATCH", "/users/:id", "users", async (ctx) => {
  const b = await readJson(ctx.req);
  const [row] = await db.select().from(users).where(eq(users.id, ctx.params.id)).limit(1);
  if (!row) throw E.notFound("用户不存在");
  const set: Partial<typeof users.$inferInsert> = {};
  if (b.role !== undefined) {
    if (!isRole(b.role)) throw E.badRequest("role 无效");
    if (row.source === "env") throw E.badRequest("环境变量管理员的角色不可修改");
    set.role = b.role;
  }
  if (b.disabled !== undefined) {
    if (row.source === "env" || row.id === ctx.user!.id) throw E.badRequest("不能禁用该账户");
    set.disabled = !!b.disabled;
  }
  if (b.password !== undefined) {
    if (row.source === "env") throw E.badRequest("环境变量管理员的密码由 ADMIN_PASSWORD 控制");
    const pw = str(b.password, "password");
    validatePasswordStrength(pw);
    set.passwordHash = await hashPassword(pw);
    // 管理员重置密码后,该用户的所有旧令牌立即失效(issue §1.4)
    set.tokenVersion = (row.tokenVersion ?? 0) + 1;
  }
  if (!Object.keys(set).length) throw E.badRequest("没有可更新的字段");
  await db.update(users).set(set).where(eq(users.id, row.id));
  invalidateUserCache();
  const [out] = await db.select().from(users).where(eq(users.id, row.id)).limit(1);
  return userDto(out);
});

route("DELETE", "/users/:id", "users", async (ctx) => {
  const [row] = await db.select().from(users).where(eq(users.id, ctx.params.id)).limit(1);
  if (!row) throw E.notFound("用户不存在");
  if (row.source === "env" || row.id === ctx.user!.id) throw E.badRequest("不能删除该账户");
  await db.delete(users).where(eq(users.id, row.id));
  invalidateUserCache();
  return { deleted: true };
});

/* ---------- 系统 ---------- */

/**
 * 健康检查(issue §3.1/§10.6):
 *  - /health       liveness:进程活着就返回 ok(供容器 HEALTHCHECK 用,不依赖数据库)
 *  - /health/ready readiness:数据库连通 + DATA_DIR 可写 + 磁盘剩余空间
 */
route("GET", "/health", "public", async () => ({ status: "ok", version: config.version }));

route("GET", "/health/ready", "public", async () => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  try {
    await db.execute(sql`select 1`);
    checks.db = { ok: true };
  } catch (e) {
    checks.db = { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  try {
    await fs.access(config.dataDir, fs.constants.W_OK);
    checks.dataDir = { ok: true };
  } catch {
    checks.dataDir = { ok: false, detail: "DATA_DIR 不可写" };
  }
  const disk = await fs.statfs(config.dataDir).catch(() => null);
  if (disk) {
    const freeMb = Math.round((Number(disk.bavail) * Number(disk.bsize)) / 1048576);
    // 与上传保护同一阈值:低于 MIN_FREE_DISK_MB 时上传已被拒绝(507),
    // readiness 也应随之降级,否则编排系统无法感知"服务已无法接收新文件"
    const floor = Math.max(64, config.minFreeDiskMb);
    checks.disk = { ok: freeMb > floor, detail: `剩余 ${freeMb}MB(阈值 ${floor}MB)` };
  }
  const ok = Object.values(checks).every((c) => c.ok);
  return json({ ok, data: { status: ok ? "ready" : "degraded", version: config.version, checks } }, { status: ok ? 200 : 503 });
});

let ffCache: { at: number; ffmpeg: boolean; ffprobe: boolean } | null = null;
function probeBin(bin: string): Promise<boolean> {
  return new Promise((r) => execFile(bin, ["-version"], { timeout: 5000 }, (e) => r(!e)));
}

let statusCache: { at: number; value: Record<string, unknown> } | null = null;

route("GET", "/status", "status", async () => {
  // 系统页每 3 秒轮询一次,全表聚合很贵:缓存 5 秒(issue §6.3)
  if (statusCache && Date.now() - statusCache.at < 5000) return statusCache.value;
  if (!ffCache || Date.now() - ffCache.at > 60_000) {
    ffCache = { at: Date.now(), ffmpeg: await probeBin(config.ffmpeg), ffprobe: await probeBin(config.ffprobe) };
  }
  const r = await db.execute(sql`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE kind='image')::int AS images, count(*) FILTER (WHERE kind='video')::int AS videos,
      count(*) FILTER (WHERE status='pending')::int AS pending, count(*) FILTER (WHERE status='failed')::int AS failed,
      count(*) FILTER (WHERE album_id IS NULL)::int AS unsorted,
      coalesce(sum(size),0)::float8 AS bytes,
      (SELECT count(*)::int FROM pgs_albums) AS albums,
      (SELECT count(*)::int FROM pgs_users) AS users,
      (SELECT count(*)::int FROM pgs_download_keys) AS keys
    FROM pgs_media`);
  const disk = await fs.statfs(config.dataDir).catch(() => null);
  const mem = process.memoryUsage();
  const value = {
    app: config.appName,
    version: config.version,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    counts: r.rows[0],
    queue: queueStats(),
    hd: await hdCacheInfo(),
    tools: { ffmpeg: ffCache.ffmpeg, ffprobe: ffCache.ffprobe, s3: s3Available() },
    memory: { rss: mem.rss, heapUsed: mem.heapUsed },
    disk: disk ? { freeBytes: Number(disk.bavail) * Number(disk.bsize), totalBytes: Number(disk.blocks) * Number(disk.bsize) } : null,
    config: {
      dataDir: config.dataDir, thumbConcurrency: config.thumbConcurrency, videoConcurrency: config.videoConcurrency,
      heicConcurrency: config.heicConcurrency, thumbWidth: config.thumbWidth, previewWidth: config.previewWidth,
      hdWidth: config.hd.width, hdCacheMaxMb: Math.round(config.hd.cacheMaxBytes / 1048576), hdCacheTtlDays: config.hd.cacheTtlMs / 86400000,
      hdConcurrency: config.hd.concurrency, maxUploadMb: config.maxUploadMb, scanIntervalMin: config.scanIntervalMin,
      guestMeta: config.guestMeta, trustProxy: config.trustProxy, sessionSecretSource: config.sessionSecretSource,
    },
  };
  statusCache = { at: Date.now(), value };
  return value;
});

route("GET", "/status/queue", "status", async () => queueStats());

/* ---------- 疑似损坏文件(处理失败) ---------- */

route("GET", "/status/corrupt", "status", async (ctx) => corruptSummary(intParam(ctx.q.get("limit"), 20, 1, 200)));

route("POST", "/status/corrupt/purge", "media.delete", async (ctx) => {
  const body = await readJson(ctx.req).catch(() => ({}) as Record<string, unknown>);
  const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 5000) : undefined;
  const r = await purgeCorrupt(ids?.length ? ids : undefined);
  invalidateMediaCaches();
  invalidateAlbums();
  return r;
});
