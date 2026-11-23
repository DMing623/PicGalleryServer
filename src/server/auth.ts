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
  | "media.purge" // 物理删除源文件(仅 admin)
  | "album.manage" // 创建/改名/改可见性/删除受管相册
  | "album.mount" // 挂载绝对路径、浏览服务器目录
  | "original" // 无需密钥直接取原文件
  | "keys"
  | "users"
  | "settings"
  | "status";

const ROLE_PERMS: Record<Role, Perm[]> = {
  admin: [
    "browse.private", "upload", "media.edit", "media.delete", "media.purge", "album.manage", "album.mount",
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
  /** 令牌版本:改密码/重置/强制下线时自增,使旧令牌立即失效(issue §1.4) */
  tokenVersion: number;
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

/**
 * 时序均衡:用户名不存在时也要跑一次 scrypt,避免用户名枚举。
 * 这里复用同一个「随机密码的哈希」,每次失败只消耗 1 次 scrypt
 * (旧实现每次现算 hashPassword,失败路径 = 2 次 scrypt,可被当作 DoS 放大器,见 issue §11.2)。
 */
let timingHash: Promise<string> | null = null;
async function timingEqualizer(pw: string): Promise<void> {
  timingHash ??= hashPassword(randomBytes(16).toString("hex"));
  const h = await timingHash.catch(() => null);
  if (h) await verifyPassword(pw, h).catch(() => false);
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

export function issueSession(userId: string, tokenVersion = 0): { token: string; maxAge: number } {
  const maxAge = config.sessionDays * 86400;
  return { token: signToken({ uid: userId, v: tokenVersion, exp: Math.floor(Date.now() / 1000) + maxAge }), maxAge };
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

const USER_CACHE_MAX = 2000;
const BASIC_CACHE_MAX = 1000;

const userCache = new Map<string, { user: AuthUser | null; at: number }>();
/** key = sha256(username\0password),只缓存成功校验;带条目上限 + 惰性过期(issue §11.1) */
const basicCache = new Map<string, { id: string; at: number }>();

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  if (map.size >= max) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

export function invalidateUserCache() {
  userCache.clear();
  basicCache.clear();
}

async function loadUser(id: string): Promise<AuthUser | null> {
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < 15_000) return hit.user;
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const user =
    row && !row.disabled && isRole(row.role)
      ? { id: row.id, username: row.username, role: row.role, tokenVersion: row.tokenVersion ?? 0 }
      : null;
  lruSet(userCache, id, { user, at: Date.now() }, USER_CACHE_MAX);
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

/**
 * 依次尝试: Bearer 令牌 → Basic(用户名密码) → 会话 Cookie。
 * Basic 与登录接口共用同一套失败限流(issue §1.1):任何一次密码校验失败都会计入 IP 与用户名维度。
 */
export async function authenticate(req: Request, ip = "local"): Promise<AuthUser | null> {
  const header = req.headers.get("authorization");
  if (header) {
    const sp = header.indexOf(" ");
    const scheme = sp < 0 ? header : header.slice(0, sp);
    const value = sp < 0 ? "" : header.slice(sp + 1);
    if (/^bearer$/i.test(scheme)) {
      const p = verifyToken<{ uid?: string; v?: number }>(value.trim());
      if (!p?.uid) return null;
      const user = await loadUser(p.uid);
      // 令牌版本不匹配 = 密码已改/已被强制下线
      if (user && typeof p.v === "number" && p.v !== user.tokenVersion) return null;
      return user;
    }
    if (/^basic$/i.test(scheme)) {
      const decoded = Buffer.from(value.trim(), "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i < 0) return null;
      return verifyCredentials(decoded.slice(0, i), decoded.slice(i + 1), ip);
    }
  }
  const cookie = cookieValue(req.headers.get("cookie"), SESSION_COOKIE);
  if (cookie) {
    const p = verifyToken<{ uid?: string; v?: number }>(cookie);
    if (p?.uid) {
      const user = await loadUser(p.uid);
      if (user && typeof p.v === "number" && p.v !== user.tokenVersion) return null;
      return user;
    }
  }
  return null;
}

/**
 * 校验用户名密码(带 60 秒成功缓存,便于 CLI 高频调用)。
 * 失败路径:先查限流 → 1 次 scrypt(时序均衡或真实校验)→ 计入 IP 与用户名失败计数。
 */
export async function verifyCredentials(username: string, password: string, ip = "local"): Promise<AuthUser | null> {
  checkLoginRate(ip);
  checkUserRate(username);

  const ck = createHash("sha256").update(`${username}\u0000${password}`).digest("hex");
  const hit = basicCache.get(ck);
  if (hit && Date.now() - hit.at < 60_000) return loadUser(hit.id);

  const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!row || row.disabled) {
    await timingEqualizer(password);
    recordLoginFailure(ip, username);
    return null;
  }
  if (!(await verifyPassword(password, row.passwordHash))) {
    recordLoginFailure(ip, username);
    return null;
  }
  clearLoginFailures(ip, username);
  lruSet(basicCache, ck, { id: row.id, at: Date.now() }, BASIC_CACHE_MAX);
  return loadUser(row.id);
}

/** 让某个用户的全部令牌失效(改密码 / 管理员重置 / 强制下线) */
export async function bumpTokenVersion(userId: string): Promise<void> {
  const [row] = await db.select({ v: users.tokenVersion }).from(users).where(eq(users.id, userId)).limit(1);
  await db
    .update(users)
    .set({ tokenVersion: (row?.v ?? 0) + 1 })
    .where(eq(users.id, userId));
  invalidateUserCache();
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
      // 改名冲突时拒绝启动,绝不删除已有账户(旧实现会 delete 同名用户,见 issue §1.11)
      if (patch.username) {
        const [clash] = await db.select({ id: users.id }).from(users).where(eq(users.username, patch.username)).limit(1);
        if (clash && clash.id !== envRow.id) {
          throw new Error(
            `ADMIN_USER=${patch.username} 已被另一个账户占用。请改用其它用户名,或先删除/改名该账户后再启动。`,
          );
        }
      }
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

/* ---------- 登录失败限流(内存,IP + 用户名双维度) ---------- */

const FAIL_WINDOW_MS = 10 * 60_000;
const FAIL_MAX_IP = 10;
const FAIL_MAX_USER = 20;
const FAIL_MAP_MAX = 10_000;

const fails = new Map<string, { n: number; first: number }>();
const userFails = new Map<string, { n: number; first: number }>();

function bump(map: Map<string, { n: number; first: number }>, key: string, max: number) {
  const f = map.get(key);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) {
    if (map.size >= FAIL_MAP_MAX) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
    map.set(key, { n: 1, first: Date.now() });
  } else {
    f.n += 1;
    if (f.n > max * 4) f.first = Date.now(); // 长期攻击时滚动窗口,避免条目永不过期
  }
}

export function checkLoginRate(ip: string) {
  const f = fails.get(ip);
  if (f && Date.now() - f.first > FAIL_WINDOW_MS) fails.delete(ip);
  const cur = fails.get(ip);
  if (cur && cur.n >= FAIL_MAX_IP) throw E.tooMany("登录失败次数过多,请 10 分钟后再试", 600);
}

export function checkUserRate(username: string) {
  const key = username.toLowerCase();
  const f = userFails.get(key);
  if (f && Date.now() - f.first > FAIL_WINDOW_MS) userFails.delete(key);
  const cur = userFails.get(key);
  if (cur && cur.n >= FAIL_MAX_USER) throw E.tooMany("该账户失败次数过多,请稍后再试", 600);
}

export function recordLoginFailure(ip: string, username?: string) {
  bump(fails, ip, FAIL_MAX_IP);
  if (username) bump(userFails, username.toLowerCase(), FAIL_MAX_USER);
}

export function clearLoginFailures(ip: string, username?: string) {
  fails.delete(ip);
  if (username) userFails.delete(username.toLowerCase());
}
