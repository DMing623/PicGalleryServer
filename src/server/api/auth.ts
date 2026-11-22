// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  can, checkLoginRate, clearCookie, clearLoginFailures, hashPassword, invalidateUserCache, issueSession, permsOf,
  recordLoginFailure, sessionCookie, validatePasswordStrength, verifyCredentials, verifyPassword,
} from "../auth";
import { config, dirs } from "../config";
import { E, ok, readJson, str } from "../http";
import { parseUpload } from "../media/upload";
import { route } from "../router";
import { getSite, patchSite, publicSite, setIcon } from "../settings";
import { s3Available } from "../storage";

/** 认证、站点公开配置、品牌图标、站点设置 */

route("POST", "/auth/login", "public", async (ctx) => {
  checkLoginRate(ctx.ip);
  const body = await readJson(ctx.req);
  const user = await verifyCredentials(str(body.username, "username", { max: 64 }), str(body.password, "password", { max: 200 }));
  if (!user) {
    recordLoginFailure(ctx.ip);
    throw E.unauthorized("用户名或密码错误");
  }
  clearLoginFailures(ctx.ip);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  const { token, maxAge } = issueSession(user.id);
  return ok({ user, perms: permsOf(user), token, expiresInSec: maxAge }, { headers: { "set-cookie": sessionCookie(token, maxAge) } });
});

route("POST", "/auth/logout", "public", () => ok(null, { headers: { "set-cookie": clearCookie() } }));

route("GET", "/auth/me", "public", async (ctx) => {
  const site = await getSite();
  return {
    user: ctx.user,
    perms: permsOf(ctx.user),
    site: publicSite(site),
    features: { s3: s3Available(), thumbConcurrency: config.thumbConcurrency },
  };
});

route("POST", "/auth/password", "user", async (ctx) => {
  const body = await readJson(ctx.req);
  const [row] = await db.select().from(users).where(eq(users.id, ctx.user!.id)).limit(1);
  if (row.source === "env") throw E.badRequest("环境变量管理员的密码由 ADMIN_PASSWORD 控制,请修改 .env 后重启");
  if (!(await verifyPassword(str(body.oldPassword, "oldPassword"), row.passwordHash))) throw E.forbidden("原密码错误");
  const np = str(body.newPassword, "newPassword");
  validatePasswordStrength(np);
  await db.update(users).set({ passwordHash: await hashPassword(np) }).where(eq(users.id, row.id));
  invalidateUserCache();
  return { changed: true };
});

/* ---------- 站点配置 / 图标 ---------- */

route("GET", "/site", "public", async () => publicSite(await getSite()));

const DEFAULT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8946f"/><stop offset="1" stop-color="#c15f3c"/></linearGradient></defs><rect width="128" height="128" rx="30" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><rect x="26" y="40" width="76" height="52" rx="12"/><circle cx="64" cy="66" r="14"/><path d="M48 40l6-9h20l6 9"/></g></svg>`;

route("GET", "/branding/icon", "public", async () => {
  const site = await getSite();
  const headers: Record<string, string> = {
    "cache-control": "public, max-age=86400",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
  if (site.iconVersion > 0) {
    const buf = await fs.readFile(path.join(dirs.branding, "icon")).catch(() => null);
    if (buf) return new Response(new Uint8Array(buf), { headers: { ...headers, "content-type": site.iconMime || "image/png" } });
  }
  return new Response(DEFAULT_ICON, { headers: { ...headers, "content-type": "image/svg+xml" } });
});

route("POST", "/settings/icon", "settings", async (ctx) => {
  const { files } = await parseUpload(ctx.req);
  const f = files[0];
  if (!f) throw E.badRequest("缺少图标文件(multipart 字段名任意)");
  try {
    if (f.size > 2 * 1024 * 1024 || f.truncated) throw E.badRequest("图标不能超过 2MB");
    const head = (await fs.readFile(f.tmp)).subarray(0, 4096);
    const isSvg = /\.svg$/i.test(f.name) && /<svg[\s>]/i.test(head.toString("utf8"));
    let out: Buffer;
    let mime: string;
    if (isSvg) {
      out = await fs.readFile(f.tmp);
      mime = "image/svg+xml";
    } else {
      // 统一转 256x256 PNG,同时剥离任何内嵌脚本/元数据
      out = await sharp(f.tmp, { failOn: "none" }).resize(256, 256, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      mime = "image/png";
    }
    await fs.mkdir(dirs.branding, { recursive: true });
    await fs.writeFile(path.join(dirs.branding, "icon"), out);
    const s = await setIcon(Date.now(), mime);
    return { iconUrl: publicSite(s).iconUrl };
  } catch (e) {
    if (e instanceof Error && e.name === "Error" && /Input|unsupported|Invalid/i.test(e.message)) throw E.badRequest("不支持的图片格式(请使用 PNG/JPG/WebP/SVG)");
    throw e;
  } finally {
    await Promise.all(files.map((x) => fs.unlink(x.tmp).catch(() => undefined)));
  }
});

route("DELETE", "/settings/icon", "settings", async () => {
  await fs.unlink(path.join(dirs.branding, "icon")).catch(() => undefined);
  const s = await setIcon(0, "");
  return { iconUrl: publicSite(s).iconUrl };
});

route("GET", "/settings", "settings", async () => getSite());

route("PUT", "/settings", "settings", async (ctx) => {
  const s = await patchSite(await readJson(ctx.req));
  return { ...s, can: can(ctx.user, "settings") };
});
