// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { Pool } from "pg";
import { config } from "@/server/config";
import * as schema from "./schema";

/**
 * 数据库连接层:同一套业务代码可跑在 PostgreSQL 或 SQLite 上。
 *
 *  - DB_DRIVER=postgres(默认,且设置了 DATABASE_URL 时)→ pg 连接池 + drizzle/node-postgres
 *  - DB_DRIVER=sqlite → Node 内置 node:sqlite(DatabaseSync)+ drizzle/sqlite-proxy
 *    无需任何外部服务,适合手机本地 / 小规模图库(单进程、单文件)。
 *
 * 关键点:
 *  1. 两种驱动都缓存到 globalThis —— 生产环境下 instrumentation / Route Handler 可能被打进
 *     不同 bundle,否则会各自建一个池。
 *  2. 必须监听 pool 的 'error' 事件:pg 的空闲连接出错(数据库重启、网络闪断)会以
 *     error 事件抛出,没有监听器就是未捕获异常,直接杀死进程。
 *  3. 惰性创建:构建期不需要真实的 DATABASE_URL(避免 Dockerfile 里的占位连接串)。
 *  4. 表定义沿用 pg-core(schema.ts),SQLite 模式下由 sqlite 方言生成 SQL;
 *     布尔列在 SQLite 里存 0/1,读回时统一还原为 true/false。
 *  5. 原始 SQL 一律走 rawQuery():pg 返回 {rows},sqlite 也返回 {rows},调用方无需分支。
 */

export type DbKind = "postgres" | "sqlite";

export const dbKind: DbKind = config.db.driver;

const g = globalThis as typeof globalThis & {
  __pgsPool?: Pool;
  __pgsSqlite?: SqliteHandle;
  __pgsDb?: NodePgDatabase<typeof schema>;
};

/* ---------- PostgreSQL ---------- */

function createPool(): Pool {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    // 不在这里 throw:构建期(收集页面数据)会 import 本模块。真正使用时才报错。
    console.error("[db] 警告:DATABASE_URL 未设置,数据库请求将失败");
  }
  const pool = new Pool({
    connectionString: url || "postgresql://invalid:invalid@127.0.0.1:1/invalid",
    max: config.db.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: config.db.connectionTimeoutMs,
    statement_timeout: config.db.statementTimeoutMs || undefined,
    application_name: "picgalleryserver",
    ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
  });
  pool.on("error", (e) => {
    // 空闲客户端出错:记录后由 pg 自行丢弃该连接,进程继续运行
    console.error("[db] idle client error", e instanceof Error ? e.message : e);
  });
  return pool;
}

/* ---------- SQLite(node:sqlite) ---------- */

/** node:sqlite 的 DatabaseSync 实例(仅 sqlite 模式存在) */
interface SqliteHandle {
  file: string;
  raw: {
    prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[]; run(...p: unknown[]): unknown };
    exec(sql: string): void;
    close(): void;
  };
}

/**
 * 布尔列名白名单:pg 驱动返回 true/false,而 SQLite 只有 0/1。
 * 读回时把这些列还原成布尔值,避免 API 里出现 1/0。
 */
const BOOL_COLUMNS = new Set(["disabled", "readonly", "pinned"]);

/** node:sqlite 只接受 null / number / bigint / string / Uint8Array / boolean */
function coerceParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === "boolean") return p ? 1 : 0;
    if (p && typeof p === "object" && !(p instanceof Uint8Array)) return JSON.stringify(p);
    return p;
  });
}

function openSqlite(): SqliteHandle {
  const file = config.db.sqliteFile;
  const getBuiltin = (process as unknown as { getBuiltinModule?: (n: string) => unknown }).getBuiltinModule;
  const mod = getBuiltin?.("node:sqlite") as
    | { DatabaseSync: new (f: string) => SqliteHandle["raw"] }
    | undefined;
  if (!mod?.DatabaseSync) {
    throw new Error(
      "当前 Node 运行时没有内置 SQLite(node:sqlite)。请使用 Node ≥ 22.5(需 --experimental-sqlite)或 Node ≥ 24;" +
        "也可以改用 PostgreSQL(设置 DATABASE_URL)。",
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new mod.DatabaseSync(file);
  // WAL:读写并发更友好;busy_timeout 避免偶发 SQLITE_BUSY
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec("PRAGMA foreign_keys = ON");
  // 兼容函数:pg 的 now() / gen_random_uuid() 在 SQLite 里没有,
  // 而 drizzle 的 defaultNow() 会生成 now(),这里补上(返回 ISO-8601 UTC 文本)。
  const fnHost = raw as unknown as {
    function?: (name: string, fn: (...args: unknown[]) => unknown) => void;
  };
  fnHost.function?.("now", () => new Date().toISOString());
  fnHost.function?.("gen_random_uuid", () => crypto.randomUUID());
  return { file, raw };
}

function sqliteDrizzle(h: SqliteHandle) {
  const callback = async (q: string, params: unknown[], method: string): Promise<{ rows: any[] }> => {
    const stmt = h.raw.prepare(q);
    const args = coerceParams(params ?? []);
    if (method === "run") {
      stmt.run(...args);
      return { rows: [] };
    }
    const objs = stmt.all(...args);
    const rows = objs.map((o) => {
      const keys = Object.keys(o);
      const vals = keys.map((k) => o[k]);
      for (let i = 0; i < keys.length; i++) {
        if (BOOL_COLUMNS.has(keys[i])) {
          const v = vals[i];
          if (v === 0 || v === 1) vals[i] = v === 1;
        }
      }
      return vals;
    });
    if (method === "get") return { rows: rows[0] as any };
    return { rows };
  };
  return drizzleSqliteProxy(callback);
}

/* ---------- 导出 ---------- */

function build() {
  if (dbKind === "sqlite") {
    const h = (g.__pgsSqlite ??= openSqlite());
    const d = sqliteDrizzle(h);
    return d as unknown as NodePgDatabase<typeof schema>;
  }
  const pool = (g.__pgsPool ??= createPool());
  return drizzlePg(pool, { schema }) as unknown as NodePgDatabase<typeof schema>;
}

export const db: NodePgDatabase<typeof schema> = (g.__pgsDb ??= build());

/** pg 连接池(sqlite 模式下为 null) */
export const pool: Pool | null = dbKind === "postgres" ? (g.__pgsPool ??= createPool()) : null;

const pgDialect = new PgDialect();
const liteDialect = new SQLiteSyncDialect();

/**
 * 执行原始 SQL,返回 { rows }。
 *  - pg:pool.query → 行对象数组
 *  - sqlite:方言编译后直接执行 → 行对象数组(列名与 SQL 里的别名一致)
 * 调用方拿到的结构与 drizzle 的 db.execute() 在 pg 下完全一致。
 */
export async function rawQuery<T = Record<string, unknown>>(q: SQL): Promise<{ rows: T[] }> {
  if (dbKind === "sqlite") {
    const h = (g.__pgsSqlite ??= openSqlite());
    const built = liteDialect.sqlToQuery(q);
    const stmt = h.raw.prepare(built.sql);
    const rows = stmt.all(...coerceParams(built.params)) as T[];
    return { rows };
  }
  const built = pgDialect.sqlToQuery(q);
  const p = pool as Pool;
  const r = await p.query(built.sql, built.params as unknown[]);
  return { rows: r.rows as T[] };
}

/** 简单连通性检查(健康检查用) */
export async function pingDb(): Promise<void> {
  await rawQuery(sql`select 1 as ok`);
}

/**
 * 判断错误链里是否含「唯一约束冲突」,两种驱动通用:
 *  - PostgreSQL:SQLSTATE `23505`;
 *  - SQLite(node:sqlite):`code` 为 `ERR_SQLITE_ERROR`,`errcode` 为 19(CONSTRAINT)/ 1555(PRIMARYKEY)/ 2067(UNIQUE),
 *    `message` 含 `UNIQUE constraint failed`。
 * Drizzle 会把底层错误包进 DrizzleQueryError,原始信息在 `cause` 上,故沿链查找。
 */
export function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const x = cur as { code?: unknown; errcode?: unknown; message?: unknown; cause?: unknown };
    if (x.code === "23505") return true;
    if (x.errcode === 1555 || x.errcode === 2067) return true;
    if (typeof x.message === "string" && /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(x.message)) return true;
    cur = x.cause;
  }
  return false;
}

/**
 * NULL 安全的等值比较:
 *  - PostgreSQL:`a IS NOT DISTINCT FROM b`
 *  - SQLite:`a IS b`(SQLite 的 IS 本身就是 NULL 安全的等值比较)
 */
export function nullSafeEq(col: SQL | unknown, val: unknown): SQL {
  return dbKind === "sqlite" ? sql`${col} IS ${val}` : sql`${col} IS NOT DISTINCT FROM ${val}`;
}

/** 关闭连接(测试脚本 / 优雅退出用) */
export async function closeDb(): Promise<void> {
  if (dbKind === "sqlite") {
    try {
      g.__pgsSqlite?.raw.close();
    } catch {
      /* ignore */
    }
    g.__pgsSqlite = undefined;
  } else {
    await pool?.end().catch(() => undefined);
    g.__pgsPool = undefined;
  }
  g.__pgsDb = undefined;
}
