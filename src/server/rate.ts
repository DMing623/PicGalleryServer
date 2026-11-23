// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { E } from "./http";

/**
 * 通用内存限流(滑动窗口)。用于公开接口的廉价防护:
 *  - 匿名搜索(issue §6.4)
 *  - 无效下载密钥校验(issue §10.5:未认证的 key 校验本身构成放大)
 *
 * 单实例有效;多实例部署时每个实例各自计数(见 README「仅支持单实例」)。
 */

interface Bucket {
  hits: number[];
}

const g = globalThis as typeof globalThis & { __pgsRate?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (g.__pgsRate ??= new Map());
const MAX_KEYS = 20_000;

let gcTimer: NodeJS.Timeout | null = null;
function startGc() {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (!b.hits.length || now - b.hits[b.hits.length - 1] > 600_000) buckets.delete(k);
    }
  }, 60_000);
  gcTimer.unref?.();
}

/** 记一次访问;超过上限时抛 429。 */
export function hit(key: string, perMinute: number, message = "请求过于频繁,请稍后再试") {
  startGc();
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_KEYS) {
      const oldest = buckets.keys().next();
      if (!oldest.done) buckets.delete(oldest.value);
    }
    b = { hits: [] };
    buckets.set(key, b);
  }
  b.hits = b.hits.filter((t) => now - t < 60_000);
  if (b.hits.length >= perMinute) throw E.tooMany(message, 60);
  b.hits.push(now);
}

/** 记一次访问(不抛错) */
export function count(key: string) {
  startGc();
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_KEYS) {
      const oldest = buckets.keys().next();
      if (!oldest.done) buckets.delete(oldest.value);
    }
    b = { hits: [] };
    buckets.set(key, b);
  }
  b.hits = b.hits.filter((t) => now - t < 60_000);
  b.hits.push(now);
}

/** 只检查不计数(用于先判断是否已超限) */
export function overLimit(key: string, perMinute: number): boolean {
  const b = buckets.get(key);
  if (!b) return false;
  const now = Date.now();
  return b.hits.filter((t) => now - t < 60_000).length >= perMinute;
}
