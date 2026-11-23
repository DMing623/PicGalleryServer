// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { randomUUID } from "node:crypto";
import { authenticate, can, type AuthUser, type Perm } from "./auth";
import { config } from "./config";
import { ApiError, E, fail, ok } from "./http";
import { ensureReady } from "./ready";

/** 极简路由器:method + 路径模板 + 访问级别。所有 /api/v1 路由在 src/server/api/* 中注册。 */

export type Access = "public" | "user" | Perm;

export interface Ctx {
  req: Request;
  url: URL;
  q: URLSearchParams;
  params: Record<string, string>;
  /** 当前用户,游客为 null */
  user: AuthUser | null;
  ip: string;
  /** 请求 id,便于串联日志与错误响应 */
  requestId: string;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  segs: string[];
  access: Access;
  handler: Handler;
}

const routes: Route[] = [];

export function route(method: string, pattern: string, access: Access, handler: Handler) {
  routes.push({ method, segs: pattern.split("/").filter(Boolean), access, handler });
}

function match(segs: string[], parts: string[]): Record<string, string> | null {
  if (segs.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].startsWith(":")) {
      try {
        params[segs[i].slice(1)] = decodeURIComponent(parts[i]);
      } catch {
        // 非法的 % 转义:返回 400 而不是 500(issue §3.1)
        throw E.badRequest("路径参数编码无效");
      }
    } else if (segs[i] !== parts[i]) return null;
  }
  return params;
}

/**
 * 客户端 IP(issue §1.2)。
 *  - TRUST_PROXY=0(默认):只信任反代「覆盖写入」的 X-Real-IP,不读客户端可伪造的 XFF;
 *  - TRUST_PROXY=n:信任 n 层反代,取 X-Forwarded-For 的倒数第 n 段(而不是第一段)。
 * Next.js 的 Route Handler 拿不到 socket 地址,所以 0 时只能依赖反代覆盖 X-Real-IP。
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  const hops = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const n = config.trustProxy;
  let ip = "";
  if (n > 0 && hops.length >= n) ip = hops[hops.length - n];
  else if (real) ip = real;
  else if (hops.length) ip = hops[hops.length - 1]; // 未配置反代时取最后一段(最接近服务端)
  return (ip || "local").slice(0, 64);
}

export async function dispatch(req: Request, parts: string[]): Promise<Response> {
  const requestId = req.headers.get("x-request-id")?.slice(0, 64) || randomUUID();
  try {
    await ensureReady();
    const method = req.method === "HEAD" ? "GET" : req.method;
    let pathMatched = false;
    for (const r of routes) {
      let params: Record<string, string> | null = null;
      try {
        params = match(r.segs, parts);
      } catch (e) {
        return fail(e, requestId);
      }
      if (!params) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const ip = clientIp(req);
      // 登录接口本身不需要先鉴权:避免"用 Basic 登录"时先跑一次 scrypt 再跑一次
      const skipAuth = r.access === "public" && parts[0] === "auth" && parts[1] === "login";
      const user = skipAuth ? null : await authenticate(req, ip);
      if (r.access !== "public") {
        if (!user) throw E.unauthorized();
        if (r.access !== "user" && !can(user, r.access)) throw E.forbidden(`需要权限: ${r.access}`);
      }
      const url = new URL(req.url);
      const out = await r.handler({ req, url, q: url.searchParams, params, user, ip, requestId });
      if (out instanceof Response) {
        if (!out.headers.has("x-request-id")) out.headers.set("x-request-id", requestId);
        return out;
      }
      const res = ok(out);
      res.headers.set("x-request-id", requestId);
      return res;
    }
    if (pathMatched) return fail(new ApiError(405, "method_not_allowed", "不支持的请求方法"), requestId);
    throw E.notFound("接口不存在");
  } catch (err) {
    return fail(err, requestId);
  }
}
