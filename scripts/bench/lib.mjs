// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * bench-hd / bench-queue 共用:连接目标服务(自启动临时 SQLite 实例,或连接已有服务)、
 * 进程峰值内存读取、素材生成、统计与 Markdown/JSON 报告。零第三方依赖,不需要 root。
 *
 * 目标服务二选一:
 *   默认(自启动)  用本机 `next start`(需先 npm run build)起一个临时 SQLite 实例,数据放在 --work 目录(默认 os.tmpdir()/pgs-bench-run-<pid>),
 *                  结束后清理。此模式能直接读 /proc/<pid>/status 得到干净的 VmHWM 峰值。
 *   --base URL     连接已有服务(Docker/远程),需要 --password;峰值改用 /status 的 rssPeak10m 与 cgroup 工作集(精度较低)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Client, ROOT, startServer, sleep } from "../lib/harness.mjs";

export function parseArgs(argv = process.argv.slice(2)) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) {
      a._.push(t);
      continue;
    }
    const k = t.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) a[k] = true;
    else {
      a[k] = next;
      i++;
    }
  }
  return a;
}

/** 解析 --env K=V,K2=V2 */
export function parseEnv(s) {
  const env = {};
  for (const kv of String(s || "").split(",").filter(Boolean)) {
    const i = kv.indexOf("=");
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return env;
}

/**
 * 连接服务,返回 { client, admin, peak: {reset(), read()}, stop(), mode, env }
 * peak.read() 返回自上次 reset 以来的进程峰值 RSS(MB),读不到返回 null。
 */
export async function connect(a, { extraEnv = {} } = {}) {
  const password = a.password || process.env.ADMIN_PASSWORD || "bench-pass-123";
  if (a.base) {
    const client = new Client(String(a.base), { user: a.user || "admin", password });
    const admin = await client.login(a.user || "admin", password);
    let lastPeak = 0;
    return {
      mode: "remote", client, admin, env: {}, password,
      peak: {
        reset: async () => {
          lastPeak = 0;
        },
        read: async () => {
          await sleep(5200); // /status 有 5 秒缓存
          const m = (await admin.get("/status")).data?.memory;
          const v = m ? Math.max(m.rssPeak10m ?? 0, m.workingSetPeak10m ?? 0) / 1048576 : null;
          lastPeak = v ?? lastPeak;
          return v;
        },
      },
      stop: async () => undefined,
    };
  }
  const work = path.resolve(String(a.work || path.join(process.env.TEST_TMP || os.tmpdir(), `pgs-bench-run-${process.pid}`)));
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const port = Number(a.port || 3300);
  const env = {
    ADMIN_PASSWORD: password,
    // 压测会远超默认限流/异常检测阈值,调大;ALLOWED_HOSTS 让游客水印成品缓存生效
    ALLOWED_HOSTS: `127.0.0.1:${port},127.0.0.1`,
    HD_RATE_IP_PER_MIN: "100000", HD_RATE_USER_PER_MIN: "100000", HD_RATE_MEDIA_PER_MIN: "100000", HD_RATE_TOKEN_PER_MIN: "100000",
    HD_SCAN_DISTINCT: "100000", SEARCH_RATE_PER_MIN: "100000",
    ...extraEnv,
    ...parseEnv(a.env),
  };
  const srv = await startServer({ driver: "sqlite", port, dataDir: path.join(work, "data"), tag: "bench", env });
  const client = new Client(srv.base, { user: "admin", password });
  const admin = await client.login("admin", password);
  const pid = srv.child.pid;
  const procStatus = () => fs.readFileSync(`/proc/${pid}/status`, "utf8");
  const hwm = () => {
    try {
      return Number(/VmHWM:\s+(\d+)/.exec(procStatus())[1]) / 1024;
    } catch {
      return null;
    }
  };
  return {
    mode: "spawn", client, admin, env, password, work,
    peak: {
      reset: async () => {
        try {
          fs.writeFileSync(`/proc/${pid}/clear_refs`, "5"); // 把 VmHWM 重置为当前 RSS(进程属主即可,无需 root)
        } catch {
          /* 非 Linux 或无权限:read() 返回自启动以来的峰值 */
        }
      },
      read: async () => hwm(),
      rss: async () => {
        try {
          return Number(/VmRSS:\s+(\d+)/.exec(procStatus())[1]) / 1024;
        } catch {
          return null;
        }
      },
    },
    stop: async () => {
      await srv.stop();
      if (!a.keep) fs.rmSync(work, { recursive: true, force: true });
    },
  };
}

/** 生成「唯一内容」的 JPEG:渐变 + 高斯噪声(每张字节不同,避免被去重) */
export async function uniqueJpeg(w, h, { quality = 88 } = {}) {
  const noise = await sharp({ create: { width: w, height: h, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 22 } } }).jpeg({ quality }).toBuffer();
  const grad = Buffer.allocUnsafe(w * h * 3);
  const [r, g, b] = [Math.random() * 120, Math.random() * 120, Math.random() * 120];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      grad[i] = r + (x / w) * 100;
      grad[i + 1] = g + (y / h) * 100;
      grad[i + 2] = b + ((x + y) / (w + h)) * 100;
    }
  return sharp(grad, { raw: { width: w, height: h, channels: 3 } }).composite([{ input: noise, blend: "overlay" }]).jpeg({ quality }).toBuffer();
}

export const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

/** 打印 Markdown 表并支持 --save / --compare(内存与耗时一起对比) */
export function report({ title, env, rows, columns, keyOf, a }) {
  console.log(`\n## ${title}\n\n环境:${JSON.stringify(env)}\n`);
  const base = a.compare ? JSON.parse(fs.readFileSync(String(a.compare), "utf8")) : null;
  const baseMap = new Map((base?.rows ?? []).map((r) => [keyOf(r), r]));
  const f = (x) => (x == null ? "-" : typeof x === "number" ? Math.round(x * 10) / 10 : String(x));
  const delta = (cur, old) => (typeof cur !== "number" || typeof old !== "number" || !old ? "" : ` (${cur >= old ? "+" : ""}${Math.round(((cur - old) / old) * 100)}%)`);
  console.log(`| ${columns.map((c) => c.title).join(" | ")} |`);
  console.log(`|${columns.map((c) => (c.num ? "---:" : "---")).join("|")}|`);
  for (const r of rows) {
    const b = baseMap.get(keyOf(r));
    console.log(`| ${columns.map((c) => f(r[c.key]) + (c.cmp ? delta(r[c.key], b?.[c.key]) : "")).join(" | ")} |`);
  }
  if (base) console.log("\n括号内为相对基线的变化:内存与耗时要一起看,防止「峰值降了、时间翻倍」。");
  if (a.save) fs.writeFileSync(String(a.save), JSON.stringify({ env, rows }, null, 2));
}

export function envInfo(ctx) {
  return {
    node: process.version, platform: `${process.platform}/${process.arch}`, cpus: os.availableParallelism?.(), mode: ctx.mode,
    jemalloc: /jemalloc/.test(process.env.LD_PRELOAD ?? ""), mallocArenaMax: process.env.MALLOC_ARENA_MAX ?? null,
    serverEnv: Object.fromEntries(Object.entries(ctx.env).filter(([k]) => !/PASSWORD|SECRET/.test(k) && !/^HD_(RATE|SCAN)/.test(k) && k !== "ALLOWED_HOSTS")),
    createdAt: new Date().toISOString(),
  };
}

export { ROOT };
