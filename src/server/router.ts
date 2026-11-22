// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { authenticate, can, type AuthUser, type Perm } from "./auth";
import { E, fail, ok } from "./http";
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
    if (segs[i].startsWith(":")) params[segs[i].slice(1)] = decodeURIComponent(parts[i]);
    else if (segs[i] !== parts[i]) return null;
  }
  return params;
}

export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  return (xf?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local").slice(0, 64);
}

export async function dispatch(req: Request, parts: string[]): Promise<Response> {
  try {
    await ensureReady();
    const method = req.method === "HEAD" ? "GET" : req.method;
    let pathMatched = false;
    for (const r of routes) {
      const params = match(r.segs, parts);
      if (!params) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const user = await authenticate(req);
      if (r.access !== "public") {
        if (!user) throw E.unauthorized();
        if (r.access !== "user" && !can(user, r.access)) throw E.forbidden(`需要权限: ${r.access}`);
      }
      const url = new URL(req.url);
      const out = await r.handler({ req, url, q: url.searchParams, params, user, ip: clientIp(req) });
      return out instanceof Response ? out : ok(out);
    }
    if (pathMatched) return fail(new (await import("./http")).ApiError(405, "method_not_allowed", "不支持的请求方法"));
    throw E.notFound("接口不存在");
  } catch (err) {
    return fail(err);
  }
}
