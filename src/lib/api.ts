// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/** 浏览器端 API 客户端:自动解包 {ok,data} 信封,错误统一抛 ApiErr。 */

export class ApiErr extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: (RequestInit & { json?: unknown }) = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`/api/v1${path}`, { ...init, headers, body, credentials: "same-origin" });
  let payload: { ok?: boolean; data?: T; error?: { code: string; message: string; details?: unknown } } | null = null;
  try {
    payload = await res.json();
  } catch {
    /* 非 JSON */
  }
  if (!res.ok || !payload?.ok) {
    throw new ApiErr(res.status, payload?.error?.code ?? "error", payload?.error?.message ?? `请求失败 (${res.status})`, payload?.error?.details);
  }
  return payload.data as T;
}

export const qs = (o: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
