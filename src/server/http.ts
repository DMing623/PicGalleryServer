// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/** 统一的错误类型与 JSON 响应封装。成功: {ok:true,data}; 失败: {ok:false,error:{code,message}} */
import { config } from "./config";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    /** 附加响应头(如 retry-after) */
    public headers?: Record<string, string>,
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
  payloadTooLarge: (msg = "请求体过大") => new ApiError(413, "payload_too_large", msg),
  tooMany: (msg = "请求过于频繁", retryAfter = 60) =>
    new ApiError(429, "too_many_requests", msg, { "retry-after": String(retryAfter) }),
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

export function fail(err: unknown, requestId?: string): Response {
  const rid = requestId ? { "x-request-id": requestId } : undefined;
  if (err instanceof ApiError) {
    return json(
      { ok: false, error: { code: err.code, message: err.message, requestId } },
      { status: err.status, headers: { ...(err.headers ?? {}), ...(rid ?? {}) } },
    );
  }
  console.error("[api] unhandled error", requestId ?? "", err);
  return json(
    { ok: false, error: { code: "internal_error", message: "服务器内部错误", requestId } },
    { status: 500, headers: rid },
  );
}

/** 读取 JSON 请求体,带体积上限与 Content-Type 校验(issue §1.8) */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const limit = Math.max(8 * 1024, config.jsonBodyMaxKb * 1024);
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw E.payloadTooLarge("请求体过大");
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct && !ct.startsWith("application/json")) throw E.badRequest("请求体必须是 application/json");
  let text: string;
  try {
    text = await readTextLimited(req, limit);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw E.badRequest("请求体必须是合法 JSON 对象");
  }
  try {
    if (!text.trim()) return {} as T;
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object") throw new Error("not object");
    return v as T;
  } catch {
    throw E.badRequest("请求体必须是合法 JSON 对象");
  }
}

/** 流式读取文本并限制总字节数,避免未认证请求用超大 body 撑爆内存 */
async function readTextLimited(req: Request, limit: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw E.payloadTooLarge("请求体过大");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
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
