/** 统一的错误类型与 JSON 响应封装。成功: {ok:true,data}; 失败: {ok:false,error:{code,message}} */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const E = {
  badRequest: (msg = "请求参数无效", code = "bad_request") => new ApiError(400, code, msg),
  unauthorized: (msg = "需要登录或提供有效凭据") => new ApiError(401, "unauthorized", msg),
  forbidden: (msg = "权限不足") => new ApiError(403, "forbidden", msg),
  notFound: (msg = "资源不存在") => new ApiError(404, "not_found", msg),
  conflict: (msg = "资源冲突") => new ApiError(409, "conflict", msg),
  tooMany: (msg = "请求过于频繁") => new ApiError(429, "too_many_requests", msg),
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function ok(data: unknown = null, init: ResponseInit = {}): Response {
  return json({ ok: true, data }, init);
}

export function fail(err: unknown): Response {
  if (err instanceof ApiError) {
    return json({ ok: false, error: { code: err.code, message: err.message } }, { status: err.status });
  }
  console.error("[api] unhandled error", err);
  return json({ ok: false, error: { code: "internal_error", message: "服务器内部错误" } }, { status: 500 });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const text = await req.text();
    if (!text.trim()) return {} as T;
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object") throw new Error("not object");
    return v as T;
  } catch {
    throw E.badRequest("请求体必须是合法 JSON 对象");
  }
}

export function str(v: unknown, name: string, opts: { max?: number; optional?: boolean } = {}): string {
  if (v === undefined || v === null || v === "") {
    if (opts.optional) return "";
    throw E.badRequest(`缺少参数 ${name}`);
  }
  if (typeof v !== "string") throw E.badRequest(`参数 ${name} 必须是字符串`);
  const s = v.trim();
  if (opts.max && s.length > opts.max) throw E.badRequest(`参数 ${name} 过长`);
  return s;
}

export function intParam(v: string | null | undefined, def: number, min: number, max: number): number {
  if (v === null || v === undefined || v === "") return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function boolParam(v: string | null | undefined, def = false): boolean {
  if (v === null || v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
