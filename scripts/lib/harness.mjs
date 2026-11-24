// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 测试公共库:断言计数、HTTP 客户端、服务进程管理、轮询工具。
 * 被 scripts/test-*.mjs 复用,零第三方依赖(仅 Node 内置)。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/* ---------------- 断言 ---------------- */
export function createSuite(title) {
  const s = { title, passed: 0, failed: 0, skipped: 0, failures: [] };
  s.section = (t) => console.log(`\n# ${t}`);
  s.ok = (cond, name, extra = "") => {
    if (cond) s.passed++;
    else {
      s.failed++;
      s.failures.push(name + (extra ? ` → ${extra}` : ""));
    }
    console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${name}${!cond && extra ? `  → ${extra}` : ""}`);
    return !!cond;
  };
  s.eq = (actual, expected, name) => s.ok(Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), name, `期望 ${JSON.stringify(expected)},实际 ${JSON.stringify(actual)}`);
  s.skip = (name, why = "") => {
    s.skipped++;
    console.log(`  - SKIP ${name}${why ? `(${why})` : ""}`);
  };
  s.summary = () => {
    console.log(`\n==== ${title}: ${s.passed} 通过 / ${s.failed} 失败 / ${s.skipped} 跳过 ====`);
    if (s.failed) for (const f of s.failures) console.log(`   ✗ ${f}`);
    return s.failed === 0;
  };
  return s;
}

/* ---------------- HTTP 客户端 ---------------- */
let ipSeq = 1;
/** 每个请求用不同的伪造来源 IP(服务端默认 TRUST_PROXY=0 信 X-Real-IP),避免测试互相触发限流 */
const newIp = () => `10.77.${Math.floor(ipSeq / 250) % 250}.${(ipSeq++ % 250) + 1}`;

export class Client {
  /**
   * @param {string} base 如 http://127.0.0.1:3100
   * @param {{user?:string,password?:string,fixedIp?:string}} [opt]
   */
  constructor(base, opt = {}) {
    this.base = base.replace(/\/$/, "");
    this.user = opt.user;
    this.password = opt.password;
    this.token = null;
    this.fixedIp = opt.fixedIp;
  }
  /** 发请求。auth: 'basic'(默认,有账号时)|'token'|'none'|自定义 Authorization 值 */
  async req(method, p, o = {}) {
    const url = p.startsWith("http") ? p : this.base + (o.site || p.startsWith("/f/") || p.startsWith("/api/") ? p : "/api/v1" + p);
    const h = { "x-real-ip": o.ip || this.fixedIp || newIp(), ...(o.headers || {}) };
    const auth = o.auth ?? (this.token ? "token" : this.user ? "basic" : "none");
    if (auth === "basic") h.authorization = "Basic " + Buffer.from(`${this.user}:${this.password}`).toString("base64");
    else if (auth === "token") h.authorization = `Bearer ${this.token}`;
    else if (auth !== "none") h.authorization = auth;
    let body;
    if (o.json !== undefined) {
      h["content-type"] = "application/json";
      body = JSON.stringify(o.json);
    } else if (o.form) body = o.form;
    else if (o.body !== undefined) body = o.body;
    const r = await fetch(url, { method, headers: h, body, redirect: o.redirect || "manual", signal: AbortSignal.timeout(o.timeout || 120_000) });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("json")) {
      try {
        json = JSON.parse(buf.toString("utf8"));
      } catch {
        /* ignore */
      }
    }
    return { status: r.status, headers: r.headers, buf, json, data: json?.ok ? json.data : undefined, err: json && json.ok === false ? json.error : undefined, ok: r.ok };
  }
  get = (p, o) => this.req("GET", p, o);
  post = (p, json, o = {}) => this.req("POST", p, { ...o, ...(json !== undefined ? { json } : {}) });
  patch = (p, json, o = {}) => this.req("PATCH", p, { ...o, json });
  put = (p, json, o = {}) => this.req("PUT", p, { ...o, json });
  del = (p, o) => this.req("DELETE", p, o);
  /** 以 Bearer token 登录并返回新 Client */
  async login(user, password) {
    const c = new Client(this.base, { user, password });
    const r = await c.req("POST", "/auth/login", { json: { username: user, password }, auth: "none" });
    if (!r.data?.token) throw new Error(`登录失败 ${user}: ${r.status} ${r.buf.toString().slice(0, 200)}`);
    c.token = r.data.token;
    return c;
  }
  /** multipart 上传。files: [{name, data(Buffer)|path, filename?}] */
  async upload(query, files, o = {}) {
    const form = new FormData();
    for (const f of files) {
      const buf = f.data ?? fs.readFileSync(f.path);
      form.append(f.field || "f", new Blob([buf]), f.filename || f.name || path.basename(f.path));
    }
    for (const [k, v] of Object.entries(o.fields || {})) form.append(k, String(v));
    const qs = new URLSearchParams(query || {}).toString();
    return this.req("POST", `/media/upload${qs ? "?" + qs : ""}`, { form, ...o });
  }
}

/* ---------------- 工具 ---------------- */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 60_000, interval = 400, what = "条件" } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* retry */
    }
    await sleep(interval);
  }
  throw new Error(`等待超时:${what}`);
}

/** 等待相关媒体处理结束(status 不再是 pending) */
export async function waitProcessed(c, ids, { timeout = 120_000 } = {}) {
  const want = new Set(ids);
  const done = {};
  await waitFor(
    async () => {
      for (const id of [...want]) {
        const r = await c.get(`/media/${id}`);
        const st = r.data?.status;
        if (st && st !== "pending") {
          done[id] = r.data;
          want.delete(id);
        }
      }
      return want.size === 0;
    },
    { timeout, interval: 700, what: `媒体处理完成(剩 ${want.size})` },
  );
  return done;
}

export function newTmpDir(prefix) {
  return fs.mkdtempSync(path.join(process.env.TEST_TMP || "/tmp", prefix));
}

export function listFilesRec(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRec(p));
    else out.push(p);
  }
  return out;
}

/* ---------------- 服务进程 ---------------- */
/**
 * 启动 `next start`(需已 build)。返回 { base, stop(), logFile, env }。
 * @param {{driver:'postgres'|'sqlite', port:number, dataDir:string, pgDb?:string, env?:Record<string,string>, tag?:string}} o
 */
const children = new Set();
for (const ev of ["exit", "SIGINT", "SIGTERM"])
  process.on(ev, () => {
    for (const c of children) c.kill("SIGKILL");
    if (ev !== "exit") process.exit(130);
  });

async function portFree(port) {
  const net = await import("node:net");
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once("error", () => res(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => res(true)));
  });
}

export async function startServer(o) {
  const { driver, port, dataDir } = o;
  if (!(await portFree(port))) throw new Error(`端口 ${port} 已被占用(有残留测试服务?)`);
  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(path.dirname(dataDir), `pgs-${o.tag || driver}-${port}.log`);
  const out = fs.openSync(logFile, "w");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DB_DRIVER: driver,
    DATA_DIR: dataDir,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "test-pass-123",
    SESSION_SECRET: "test-secret",
    MIN_FREE_DISK_MB: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    ...(driver === "postgres" ? { DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:5432/${o.pgDb}` } : { DATABASE_URL: "", SQLITE_FILE: path.join(dataDir, "pgs.sqlite") }),
    ...(o.env || {}),
  };
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port)], { cwd: ROOT, env, stdio: ["ignore", out, out] });
  let exited = false;
  children.add(child);
  let stopping = false;
  child.on("exit", (code, signal) => {
    if (!stopping) console.error(`\n!! 服务进程意外退出 code=${code} signal=${signal}(日志 ${logFile})`);
    exited = true;
    children.delete(child);
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(
      async () => {
        if (exited) throw new Error("服务进程已退出,见 " + logFile);
        const r = await fetch(base + "/api/v1/health/ready").catch(() => null);
        return r && r.status === 200;
      },
      { timeout: 90_000, interval: 500, what: "服务就绪 " + base },
    );
  } catch (e) {
    child.kill("SIGKILL");
    console.error(fs.readFileSync(logFile, "utf8").slice(-3000));
    throw e;
  }
  return {
    base,
    logFile,
    env,
    child,
    stop: async () => {
      if (exited) return;
      stopping = true;
      child.kill("SIGTERM");
      await Promise.race([new Promise((r) => child.on("exit", r)), sleep(8000)]);
      if (!exited) child.kill("SIGKILL");
    },
  };
}

/** 重建一个空的 PostgreSQL 数据库(需要本机 psql 与 postgres 超级用户) */
export async function resetPgDb(name, adminUrl = process.env.PG_ADMIN_URL || "postgresql://postgres:postgres@127.0.0.1:5432/postgres") {
  const run = (sql) =>
    new Promise((res, rej) => {
      const p = spawn("psql", [adminUrl, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { stdio: ["ignore", "pipe", "pipe"] });
      let e = "";
      p.stderr.on("data", (d) => (e += d));
      p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`psql: ${e}`))));
    });
  await run(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await run(`CREATE DATABASE ${name}`);
}

export function sizeOfDir(dir) {
  return listFilesRec(dir).reduce((n, f) => n + fs.statSync(f).size, 0);
}
