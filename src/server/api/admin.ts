import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, invalidateUserCache, isRole, ROLES, validatePasswordStrength } from "../auth";
import { config } from "../config";
import { E, json, readJson, str } from "../http";
import { createKey, deleteKeyById, deleteKeyByValue, listKeys, verifyKey } from "../keys";
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

/** 按明文密钥删除: DELETE /keys?key=xxxx */
route("DELETE", "/keys", "keys", async (ctx) => {
  const k = ctx.q.get("key");
  if (!k) throw E.badRequest("缺少 key 参数");
  if (!(await deleteKeyByValue(k))) throw E.notFound("密钥不存在");
  return { deleted: true };
});

route("GET", "/keys/verify", "keys", async (ctx) => ({ valid: await verifyKey(ctx.q.get("key"), false) }));

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

route("GET", "/health", "public", async () => {
  await db.execute(sql`select 1`);
  return { status: "ok", version: config.version };
});

let ffCache: { at: number; ffmpeg: boolean; ffprobe: boolean } | null = null;
function probeBin(bin: string): Promise<boolean> {
  return new Promise((r) => execFile(bin, ["-version"], { timeout: 5000 }, (e) => r(!e)));
}

route("GET", "/status", "status", async () => {
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
  return {
    app: config.appName,
    version: config.version,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    counts: r.rows[0],
    queue: queueStats(),
    tools: { ffmpeg: ffCache.ffmpeg, ffprobe: ffCache.ffprobe, s3: s3Available() },
    memory: { rss: mem.rss, heapUsed: mem.heapUsed },
    disk: disk ? { freeBytes: Number(disk.bavail) * Number(disk.bsize), totalBytes: Number(disk.blocks) * Number(disk.bsize) } : null,
    config: { dataDir: config.dataDir, thumbConcurrency: config.thumbConcurrency, thumbWidth: config.thumbWidth, previewWidth: config.previewWidth, maxUploadMb: config.maxUploadMb, scanIntervalMin: config.scanIntervalMin },
  };
});

route("GET", "/status/queue", "status", async () => queueStats());
