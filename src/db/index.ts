// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "@/server/config";

/**
 * 数据库连接池(issue §5.4)。
 *
 * 关键点:
 *  1. 无条件缓存到 globalThis —— 生产环境下 instrumentation / Route Handler 可能被打进
 *     不同 bundle,否则会各自建一个池(每个 max=10 连接)。
 *  2. 必须监听 pool 的 'error' 事件:pg 的空闲连接出错(数据库重启、网络闪断)会以
 *     error 事件抛出,没有监听器就是未捕获异常,直接杀死进程。
 *  3. 惰性创建:构建期不需要真实的 DATABASE_URL(避免 Dockerfile 里的占位连接串)。
 */

const g = globalThis as typeof globalThis & { __pgsPool?: Pool };

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

export const pool: Pool = (g.__pgsPool ??= createPool());

export const db = drizzle(pool);
