// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import fs from "node:fs/promises";
import path from "node:path";
import { config, dirs } from "../config";
import { ApiError } from "../http";

/**
 * 高清预览专用限流 / 异常检测 / 安全日志(内存滑动窗口,与普通图片浏览互不影响)。
 *  - 维度: IP、用户、媒体;申请令牌(授权)单独计数
 *  - 异常: 短时间遍历大量不同图片 / 反复提交无效令牌 → 临时封禁该 IP
 *  - 触发限制统一返回 429,并写入安全日志(DATA_DIR/logs/security.log,JSON Lines)
 */

export class RateLimited extends ApiError {
  constructor(
    public retryAfter: number,
    public scope: string,
  ) {
    super(429, "too_many_requests", "高清预览请求过于频繁,请稍后再试");
  }
}

export interface SecurityEvent {
  at: string;
  event: string;
  ip?: string;
  user?: string | null;
  media?: string;
  detail?: string;
}

interface Guard {
  windows: Map<string, number[]>;
  distinct: Map<string, Map<string, number>>;
  strikes: Map<string, number[]>;
  blocked: Map<string, number>;
  events: SecurityEvent[];
  lastLogged: Map<string, number>;
  timer: NodeJS.Timeout | null;
}

const g = globalThis as typeof globalThis & { __pgsGuard?: Guard };
const S: Guard = (g.__pgsGuard ??= {
  windows: new Map(), distinct: new Map(), strikes: new Map(), blocked: new Map(), events: [], lastLogged: new Map(), timer: null,
});

function startGc() {
  if (S.timer) return;
  S.timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of S.windows) {
      const fresh = v.filter((t) => now - t < 60_000);
      if (fresh.length) S.windows.set(k, fresh);
      else S.windows.delete(k);
    }
    for (const [ip, m] of S.distinct) {
      for (const [id, t] of m) if (now - t > config.hd.rate.scanWindowSec * 1000) m.delete(id);
      if (!m.size) S.distinct.delete(ip);
    }
    for (const [k, v] of S.strikes) {
      const fresh = v.filter((t) => now - t < 60_000);
      if (fresh.length) S.strikes.set(k, fresh);
      else S.strikes.delete(k);
    }
    for (const [ip, until] of S.blocked) if (until < now) S.blocked.delete(ip);
    for (const [k, t] of S.lastLogged) if (now - t > 60_000) S.lastLogged.delete(k);
  }, 30_000);
  S.timer.unref();
}

export async function securityLog(event: string, data: Omit<SecurityEvent, "at" | "event"> = {}, throttleKey?: string) {
  const now = Date.now();
  if (throttleKey) {
    const last = S.lastLogged.get(throttleKey);
    if (last && now - last < 10_000) return; // 同一来源同一事件 10 秒内只记一条,防日志被刷爆
    S.lastLogged.set(throttleKey, now);
  }
  const ev: SecurityEvent = { at: new Date(now).toISOString(), event, ...data };
  S.events.push(ev);
  if (S.events.length > 300) S.events.splice(0, S.events.length - 300);
  console.warn("[security]", JSON.stringify(ev));
  try {
    await fs.mkdir(dirs.logs, { recursive: true });
    const file = path.join(dirs.logs, "security.log");
    const stt = await fs.stat(file).catch(() => null);
    if (stt && stt.size > 5 * 1024 * 1024) await fs.rename(file, `${file}.1`).catch(() => undefined);
    await fs.appendFile(file, `${JSON.stringify(ev)}\n`);
  } catch {
    /* 日志写入失败不影响请求 */
  }
}

export function recentSecurityEvents(limit = 100): SecurityEvent[] {
  return S.events.slice(-limit).reverse();
}

/** 滑动窗口计数:允许则记录并返回 0,否则返回需等待的秒数 */
function hit(key: string, limit: number, windowMs = 60_000): number {
  const now = Date.now();
  const arr = (S.windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    S.windows.set(key, arr);
    return Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000));
  }
  arr.push(now);
  S.windows.set(key, arr);
  return 0;
}

export interface HdWho {
  ip: string;
  userId: string | null;
  mediaId: string;
}

export async function guardHd(who: HdWho, kind: "token" | "serve"): Promise<void> {
  startGc();
  const r = config.hd.rate;
  const now = Date.now();
  const until = S.blocked.get(who.ip);
  if (until && until > now) {
    await securityLog("hd_blocked", { ip: who.ip, user: who.userId, media: who.mediaId }, `blk:${who.ip}`);
    throw new RateLimited(Math.ceil((until - now) / 1000), "blocked");
  }

  // 异常批量访问:窗口内访问的不同图片数过多
  const seen = S.distinct.get(who.ip) ?? new Map<string, number>();
  for (const [id, t] of seen) if (now - t > r.scanWindowSec * 1000) seen.delete(id);
  seen.set(who.mediaId, now);
  S.distinct.set(who.ip, seen);
  if (seen.size > r.scanDistinct) {
    S.blocked.set(who.ip, now + r.blockSec * 1000);
    seen.clear();
    await securityLog("hd_scan_detected", { ip: who.ip, user: who.userId, media: who.mediaId, detail: `>${r.scanDistinct} distinct media in ${r.scanWindowSec}s; blocked ${r.blockSec}s` });
    throw new RateLimited(r.blockSec, "scan");
  }

  const checks: Array<[string, string, number]> =
    kind === "token"
      ? [["token-ip", `tok:ip:${who.ip}`, r.tokenIpPerMin]]
      : [
          ["ip", `ip:${who.ip}`, r.ipPerMin],
          ...(who.userId ? ([["user", `user:${who.userId}`, r.userPerMin]] as Array<[string, string, number]>) : []),
          ["media", `media:${who.mediaId}`, r.mediaPerMin],
        ];
  for (const [scope, key, limit] of checks) {
    const wait = hit(key, limit);
    if (wait) {
      await securityLog("hd_rate_limited", { ip: who.ip, user: who.userId, media: who.mediaId, detail: `scope=${scope} limit=${limit}/min` }, `rl:${scope}:${key}`);
      throw new RateLimited(wait, scope);
    }
  }
}

/** 记录一次可疑行为(无效/过期/跨媒体令牌、越权访问)。1 分钟内累计 20 次则封禁该 IP */
export async function hdStrike(ip: string, userId: string | null, mediaId: string, reason: string) {
  startGc();
  const now = Date.now();
  const arr = (S.strikes.get(ip) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  S.strikes.set(ip, arr);
  await securityLog("hd_denied", { ip, user: userId, media: mediaId, detail: reason }, `deny:${ip}:${reason}`);
  if (arr.length >= 20) {
    S.blocked.set(ip, now + config.hd.rate.blockSec * 1000);
    S.strikes.delete(ip);
    await securityLog("hd_abuse_blocked", { ip, user: userId, detail: `20 denied requests/min; blocked ${config.hd.rate.blockSec}s` });
  }
}

/** 测试/运维用:清空限流状态 */
export function resetHdGuard() {
  S.windows.clear();
  S.distinct.clear();
  S.strikes.clear();
  S.blocked.clear();
}
