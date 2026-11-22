// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { config } from "./config";
import { E } from "./http";

/** 账户、角色权限、密码哈希、会话令牌。 */

export type Role = "admin" | "manager" | "uploader" | "viewer";
export const ROLES: Role[] = ["admin", "manager", "uploader", "viewer"];

export type Perm =
  | "browse.private" // 浏览私有相册(缩略图/预览)
  | "upload"
  | "media.edit" // 备注、移动、重处理
  | "media.delete"
  | "album.manage" // 创建/改名/改可见性/删除受管相册
  | "album.mount" // 挂载绝对路径、浏览服务器目录
  | "original" // 无需密钥直接取原文件
  | "keys"
  | "users"
  | "settings"
  | "status";

const ROLE_PERMS: Record<Role, Perm[]> = {
  admin: [
    "browse.private", "upload", "media.edit", "media.delete", "album.manage", "album.mount",
    "original", "keys", "users", "settings", "status",
  ],
  manager: [
    "browse.private", "upload", "media.edit", "media.delete", "album.manage", "original", "status",
  ],
  uploader: ["browse.private", "upload"],
  viewer: ["browse.private"],
};

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
}

export function can(user: AuthUser | null, perm: Perm): boolean {
  return !!user && ROLE_PERMS[user.role]?.includes(perm) === true;
}

export function permsOf(user: AuthUser | null): Perm[] {
  return user ? ROLE_PERMS[user.role] ?? [] : [];
}

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as string[]).includes(v);
}

/* ---------- 密码 ---------- */

function scryptAsync(pw: string, salt: Buffer, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pw, salt, len, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, 32);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scryptAsync(pw, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

export function validatePasswordStrength(pw: string) {
  if (typeof pw !== "string" || pw.length < 8) throw E.badRequest("密码至少 8 位");
  if (pw.length > 200) throw E.badRequest("密码过长");
}

/* ---------- 令牌(HMAC 签名,无状态) ---------- */

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function mac(body: string): string {
  return createHmac("sha256", config.sessionSecret).update(body).digest("base64url");
}

export function signToken(payload: Record<string, unknown>): string {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${mac(body)}`;
}

export function verifyToken<T = Record<string, unknown>>(token: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = mac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "pgs_session";

export function issueSession(userId: string): { token: string; maxAge: number } {
  const maxAge = config.sessionDays * 86400;
  return { token: signToken({ uid: userId, exp: Math.floor(Date.now() / 1000) + maxAge }), maxAge };
}

export function sessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? "; Secure" : ""}`;
}

export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 视频播放令牌:绑定媒体 id,短时有效 */
export function issueStreamToken(mediaId: string, ttlSec = 6 * 3600): string {
  return signToken({ m: mediaId, exp: Math.floor(Date.now() / 1000) + ttlSec });
}

export function verifyStreamToken(token: string | null, mediaId: string): boolean {
  if (!token) return false;
  const p = verifyToken<{ m?: string; s?: string }>(token);
  // 带 scope 的令牌(如高清预览令牌)不得当作播放令牌使用,保证权限隔离
  return !!p && p.s === undefined && p.m === mediaId;
}

/* ---------- 请求鉴权 ---------- */

const userCache = new Map<string, { user: AuthUser | null; at: number }>();
const basicCache = new Map<string, { id: string; at: number }>();

export function invalidateUserCache() {
  userCache.clear();
  basicCache.clear();
}

async function loadUser(id: string): Promise<AuthUser | null> {
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < 15_000) return hit.user;
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const user = row && !row.disabled && isRole(row.role) ? { id: row.id, username: row.username, role: row.role } : null;
  userCache.set(id, { user, at: Date.now() });
  return user;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** 依次尝试: Bearer 令牌 → Basic(用户名密码) → 会话 Cookie */
export async function authenticate(req: Request): Promise<AuthUser | null> {
  const header = req.headers.get("authorization");
  if (header) {
    const [scheme, value] = [header.slice(0, header.indexOf(" ")), header.slice(header.indexOf(" ") + 1)];
    if (/^bearer$/i.test(scheme)) {
      const p = verifyToken<{ uid?: string }>(value.trim());
      return p?.uid ? loadUser(p.uid) : null;
    }
    if (/^basic$/i.test(scheme)) {
      const decoded = Buffer.from(value.trim(), "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i < 0) return null;
      return verifyCredentials(decoded.slice(0, i), decoded.slice(i + 1));
    }
  }
  const cookie = cookieValue(req.headers.get("cookie"), SESSION_COOKIE);
  if (cookie) {
    const p = verifyToken<{ uid?: string }>(cookie);
    if (p?.uid) return loadUser(p.uid);
  }
  return null;
}

/** 校验用户名密码(带 60 秒成功缓存,便于 CLI 高频调用) */
export async function verifyCredentials(username: string, password: string): Promise<AuthUser | null> {
  const ck = createHash("sha256").update(`${username}\u0000${password}`).digest("hex");
  const hit = basicCache.get(ck);
  if (hit && Date.now() - hit.at < 60_000) return loadUser(hit.id);
  const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!row || row.disabled) {
    await hashPassword("timing-equalizer").catch(() => undefined);
    return null;
  }
  if (!(await verifyPassword(password, row.passwordHash))) return null;
  basicCache.set(ck, { id: row.id, at: Date.now() });
  return loadUser(row.id);
}

/* ---------- 启动时同步 env 管理员 ---------- */

export async function syncEnvAdmin(): Promise<void> {
  const hash = await hashPassword(config.adminPassword);
  const [envRow] = await db.select().from(users).where(eq(users.source, "env")).limit(1);
  if (envRow) {
    const patch: Partial<typeof users.$inferInsert> = {};
    if (envRow.username !== config.adminUser) patch.username = config.adminUser;
    if (!(await verifyPassword(config.adminPassword, envRow.passwordHash))) patch.passwordHash = hash;
    if (envRow.role !== "admin") patch.role = "admin";
    if (envRow.disabled) patch.disabled = false;
    if (Object.keys(patch).length) {
      // 若新用户名已被其它账户占用,先让位
      if (patch.username) await db.delete(users).where(eq(users.username, patch.username));
      await db.update(users).set(patch).where(eq(users.id, envRow.id));
    }
  } else {
    const [same] = await db.select().from(users).where(eq(users.username, config.adminUser)).limit(1);
    if (same) {
      await db.update(users).set({ role: "admin", source: "env", passwordHash: hash, disabled: false }).where(eq(users.id, same.id));
    } else {
      await db.insert(users).values({ id: randomUUID(), username: config.adminUser, passwordHash: hash, role: "admin", source: "env" });
    }
  }
  invalidateUserCache();
}

/* ---------- 登录失败限流(内存) ---------- */

const fails = new Map<string, { n: number; first: number }>();

export function checkLoginRate(ip: string) {
  const f = fails.get(ip);
  if (f && Date.now() - f.first > 10 * 60_000) fails.delete(ip);
  const cur = fails.get(ip);
  if (cur && cur.n >= 10) throw E.tooMany("登录失败次数过多,请 10 分钟后再试");
}

export function recordLoginFailure(ip: string) {
  const f = fails.get(ip);
  if (!f) fails.set(ip, { n: 1, first: Date.now() });
  else f.n += 1;
}

export function clearLoginFailures(ip: string) {
  fails.delete(ip);
}
