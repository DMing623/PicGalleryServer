// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { dbKind, pool, rawQuery } from "./index";
import { sql } from "drizzle-orm";

/**
 * 幂等建表脚本,必须与 schema.ts 保持一致。
 * 应用启动时自动执行,因此部署时无需手动迁移。
 * 修改 schema.ts 后请同步修改这里(可用 `npx drizzle-kit export --sql` 对照)。
 *
 * 新增字段一律用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`(PostgreSQL)
 * 或「先查 PRAGMA table_info 再 ADD COLUMN」(SQLite),老库可直接升级。
 */

/* ---------- PostgreSQL ---------- */

const PG_DDL = `
CREATE TABLE IF NOT EXISTS "pgs_users" (
  "id" text PRIMARY KEY NOT NULL,
  "username" text NOT NULL,
  "password_hash" text NOT NULL,
  "role" text DEFAULT 'viewer' NOT NULL,
  "disabled" boolean DEFAULT false NOT NULL,
  "source" text DEFAULT 'api' NOT NULL,
  "token_version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_login_at" timestamp with time zone,
  CONSTRAINT "pgs_users_username_unique" UNIQUE("username")
);
CREATE TABLE IF NOT EXISTS "pgs_albums" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "parent_id" text,
  "kind" text DEFAULT 'managed' NOT NULL,
  "storage" text DEFAULT 'local' NOT NULL,
  "root_path" text,
  "visibility" text DEFAULT 'private' NOT NULL,
  "readonly" boolean DEFAULT false NOT NULL,
  "cover_media_id" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "last_scan_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pgs_albums_code_unique" UNIQUE("code")
);
CREATE TABLE IF NOT EXISTS "pgs_media" (
  "id" text PRIMARY KEY NOT NULL,
  "album_id" text,
  "kind" text NOT NULL,
  "filename" text NOT NULL,
  "mime" text NOT NULL,
  "size" bigint DEFAULT 0 NOT NULL,
  "mtime_ms" bigint,
  "attempts" integer DEFAULT 0 NOT NULL,
  "processing_started_ms" bigint,
  "width" integer,
  "height" integer,
  "duration" real,
  "taken_at" timestamp with time zone,
  "sort_at" timestamp with time zone DEFAULT now() NOT NULL,
  "storage" text NOT NULL,
  "storage_key" text NOT NULL,
  "hash" text,
  "color" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "error" text,
  "note" text DEFAULT '' NOT NULL,
  "meta" jsonb,
  "search_text" text DEFAULT '' NOT NULL,
  "missing_at" timestamp with time zone,
  "uploaded_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "pgs_blocklist" (
  "id" text PRIMARY KEY NOT NULL,
  "media_id" text,
  "album_id" text,
  "album_code" text,
  "kind" text NOT NULL,
  "filename" text NOT NULL,
  "mime" text NOT NULL,
  "size" bigint DEFAULT 0 NOT NULL,
  "storage" text NOT NULL,
  "storage_key" text NOT NULL,
  "hash" text,
  "taken_at" timestamp with time zone,
  "sort_at" timestamp with time zone,
  "meta" jsonb,
  "note" text DEFAULT '' NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "pgs_download_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "key_hash" text NOT NULL,
  "hint" text NOT NULL,
  "label" text DEFAULT '' NOT NULL,
  "expires_at" timestamp with time zone,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "use_count" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "pgs_download_keys_key_hash_unique" UNIQUE("key_hash")
);
CREATE TABLE IF NOT EXISTS "pgs_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "pgs_notices" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "body" text DEFAULT '' NOT NULL,
  "pinned" boolean DEFAULT false NOT NULL,
  "created_by" text,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "pgs_notice_reads" (
  "user_id" text NOT NULL,
  "notice_id" text NOT NULL,
  "read_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pgs_notice_reads_pk" PRIMARY KEY("user_id","notice_id")
);
-- 老库升级:补齐新增字段(幂等)
ALTER TABLE "pgs_users" ADD COLUMN IF NOT EXISTS "token_version" integer DEFAULT 0 NOT NULL;
ALTER TABLE "pgs_albums" ADD COLUMN IF NOT EXISTS "readonly" boolean DEFAULT false NOT NULL;
ALTER TABLE "pgs_media" ADD COLUMN IF NOT EXISTS "mtime_ms" bigint;
ALTER TABLE "pgs_media" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "pgs_media" ADD COLUMN IF NOT EXISTS "processing_started_ms" bigint;
ALTER TABLE "pgs_media" ADD COLUMN IF NOT EXISTS "missing_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "pgs_albums_parent_idx" ON "pgs_albums" USING btree ("parent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pgs_albums_root_uq" ON "pgs_albums" USING btree ("root_path");
CREATE INDEX IF NOT EXISTS "pgs_media_sort_idx" ON "pgs_media" USING btree ("sort_at","id");
CREATE INDEX IF NOT EXISTS "pgs_media_album_sort_idx" ON "pgs_media" USING btree ("album_id","sort_at","id");
CREATE UNIQUE INDEX IF NOT EXISTS "pgs_media_storage_uq" ON "pgs_media" USING btree ("storage","storage_key");
CREATE INDEX IF NOT EXISTS "pgs_media_hash_idx" ON "pgs_media" USING btree ("hash");
CREATE INDEX IF NOT EXISTS "pgs_media_status_idx" ON "pgs_media" USING btree ("status");
CREATE INDEX IF NOT EXISTS "pgs_media_missing_idx" ON "pgs_media" USING btree ("missing_at");
CREATE UNIQUE INDEX IF NOT EXISTS "pgs_blocklist_key_uq" ON "pgs_blocklist" USING btree ("storage","storage_key");
CREATE INDEX IF NOT EXISTS "pgs_blocklist_album_idx" ON "pgs_blocklist" USING btree ("album_id");
CREATE INDEX IF NOT EXISTS "pgs_notices_created_idx" ON "pgs_notices" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "pgs_notice_reads_user_idx" ON "pgs_notice_reads" USING btree ("user_id");
`;

/**
 * 搜索优化(issue §6.4):
 *  - pg_trgm + GIN 索引让 LIKE '%词%' 能走索引,避免全表顺序扫描;
 *  - status 索引基数极低(几乎都是 ready),改成只索引未完成的记录。
 * 这些语句依赖 contrib 扩展,失败不影响启动(只是没有加速)。
 */
const PG_SEARCH_DDL = `
CREATE INDEX IF NOT EXISTS "pgs_media_todo_idx" ON "pgs_media" ("id") WHERE "status" <> 'ready';
`;

/* ---------- SQLite ---------- */

/** SQLite:时间戳统一存 ISO-8601 文本(UTC),布尔存 0/1,jsonb 存 TEXT */
const LITE_DDL = `
CREATE TABLE IF NOT EXISTS "pgs_users" (
  "id" text PRIMARY KEY NOT NULL,
  "username" text NOT NULL UNIQUE,
  "password_hash" text NOT NULL,
  "role" text DEFAULT 'viewer' NOT NULL,
  "disabled" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'api' NOT NULL,
  "token_version" integer DEFAULT 0 NOT NULL,
  "created_at" text NOT NULL,
  "last_login_at" text
);
CREATE TABLE IF NOT EXISTS "pgs_albums" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "parent_id" text,
  "kind" text DEFAULT 'managed' NOT NULL,
  "storage" text DEFAULT 'local' NOT NULL,
  "root_path" text,
  "visibility" text DEFAULT 'private' NOT NULL,
  "readonly" integer DEFAULT 0 NOT NULL,
  "cover_media_id" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "last_scan_at" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
CREATE TABLE IF NOT EXISTS "pgs_media" (
  "id" text PRIMARY KEY NOT NULL,
  "album_id" text,
  "kind" text NOT NULL,
  "filename" text NOT NULL,
  "mime" text NOT NULL,
  "size" integer DEFAULT 0 NOT NULL,
  "mtime_ms" integer,
  "attempts" integer DEFAULT 0 NOT NULL,
  "processing_started_ms" integer,
  "width" integer,
  "height" integer,
  "duration" real,
  "taken_at" text,
  "sort_at" text NOT NULL,
  "storage" text NOT NULL,
  "storage_key" text NOT NULL,
  "hash" text,
  "color" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "error" text,
  "note" text DEFAULT '' NOT NULL,
  "meta" text,
  "search_text" text DEFAULT '' NOT NULL,
  "missing_at" text,
  "uploaded_by" text,
  "created_at" text NOT NULL
);
CREATE TABLE IF NOT EXISTS "pgs_blocklist" (
  "id" text PRIMARY KEY NOT NULL,
  "media_id" text,
  "album_id" text,
  "album_code" text,
  "kind" text NOT NULL,
  "filename" text NOT NULL,
  "mime" text NOT NULL,
  "size" integer DEFAULT 0 NOT NULL,
  "storage" text NOT NULL,
  "storage_key" text NOT NULL,
  "hash" text,
  "taken_at" text,
  "sort_at" text,
  "meta" text,
  "note" text DEFAULT '' NOT NULL,
  "created_by" text,
  "created_at" text NOT NULL
);
CREATE TABLE IF NOT EXISTS "pgs_download_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "key_hash" text NOT NULL UNIQUE,
  "hint" text NOT NULL,
  "label" text DEFAULT '' NOT NULL,
  "expires_at" text,
  "created_by" text,
  "created_at" text NOT NULL,
  "last_used_at" text,
  "use_count" integer DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "pgs_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text,
  "updated_at" text NOT NULL
);
CREATE TABLE IF NOT EXISTS "pgs_notices" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "body" text DEFAULT '' NOT NULL,
  "pinned" integer DEFAULT 0 NOT NULL,
  "created_by" text,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
CREATE TABLE IF NOT EXISTS "pgs_notice_reads" (
  "user_id" text NOT NULL,
  "notice_id" text NOT NULL,
  "read_at" text NOT NULL,
  PRIMARY KEY("user_id","notice_id")
);
CREATE INDEX IF NOT EXISTS "pgs_albums_parent_idx" ON "pgs_albums" ("parent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pgs_albums_root_uq" ON "pgs_albums" ("root_path");
CREATE INDEX IF NOT EXISTS "pgs_media_sort_idx" ON "pgs_media" ("sort_at","id");
CREATE INDEX IF NOT EXISTS "pgs_media_album_sort_idx" ON "pgs_media" ("album_id","sort_at","id");
CREATE UNIQUE INDEX IF NOT EXISTS "pgs_media_storage_uq" ON "pgs_media" ("storage","storage_key");
CREATE INDEX IF NOT EXISTS "pgs_media_hash_idx" ON "pgs_media" ("hash");
CREATE INDEX IF NOT EXISTS "pgs_media_status_idx" ON "pgs_media" ("status");
CREATE INDEX IF NOT EXISTS "pgs_media_missing_idx" ON "pgs_media" ("missing_at");
CREATE UNIQUE INDEX IF NOT EXISTS "pgs_blocklist_key_uq" ON "pgs_blocklist" ("storage","storage_key");
CREATE INDEX IF NOT EXISTS "pgs_blocklist_album_idx" ON "pgs_blocklist" ("album_id");
CREATE INDEX IF NOT EXISTS "pgs_notices_created_idx" ON "pgs_notices" ("created_at");
CREATE INDEX IF NOT EXISTS "pgs_notice_reads_user_idx" ON "pgs_notice_reads" ("user_id");
`;

/** 老库升级:SQLite 不支持 ADD COLUMN IF NOT EXISTS,先查表结构再补列 */
const LITE_UPGRADE: Array<{ table: string; column: string; ddl: string }> = [
  { table: "pgs_users", column: "token_version", ddl: 'ALTER TABLE "pgs_users" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL' },
  { table: "pgs_albums", column: "readonly", ddl: 'ALTER TABLE "pgs_albums" ADD COLUMN "readonly" integer DEFAULT 0 NOT NULL' },
  { table: "pgs_media", column: "mtime_ms", ddl: 'ALTER TABLE "pgs_media" ADD COLUMN "mtime_ms" integer' },
  { table: "pgs_media", column: "attempts", ddl: 'ALTER TABLE "pgs_media" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL' },
  { table: "pgs_media", column: "processing_started_ms", ddl: 'ALTER TABLE "pgs_media" ADD COLUMN "processing_started_ms" integer' },
  { table: "pgs_media", column: "missing_at", ddl: 'ALTER TABLE "pgs_media" ADD COLUMN "missing_at" text' },
];

async function runPostgresBootstrap(): Promise<void> {
  const client = await (pool as NonNullable<typeof pool>).connect();
  try {
    await client.query("SELECT pg_advisory_lock(7351001)");
    await client.query(PG_DDL);
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
      await client.query(
        `CREATE INDEX IF NOT EXISTS "pgs_media_search_trgm" ON "pgs_media" USING gin ("search_text" gin_trgm_ops)`,
      );
    } catch (e) {
      console.warn("[bootstrap] pg_trgm 不可用,搜索将退化为顺序扫描:", (e as Error).message);
    }
    await client.query(PG_SEARCH_DDL);
  } finally {
    await client.query("SELECT pg_advisory_unlock(7351001)").catch(() => undefined);
    client.release();
  }
}

async function runSqliteBootstrap(): Promise<void> {
  // node:sqlite 的 exec 支持多语句;drizzle 的 sql.raw 只能执行单条,这里直接用底层句柄
  const h = (globalThis as unknown as { __pgsSqlite?: { raw: { exec(s: string): void; prepare(s: string): { all(...p: unknown[]): Array<Record<string, unknown>> } } } })
    .__pgsSqlite;
  if (!h) {
    // 触发一次 rawQuery 以惰性创建句柄
    await rawQuery(sql`select 1 as ok`);
  }
  const handle = (globalThis as unknown as { __pgsSqlite?: { raw: { exec(s: string): void; prepare(s: string): { all(...p: unknown[]): Array<Record<string, unknown>> } } } })
    .__pgsSqlite!;
  handle.raw.exec(LITE_DDL);
  for (const u of LITE_UPGRADE) {
    const cols = handle.raw.prepare(`PRAGMA table_info("${u.table}")`).all();
    if (!cols.some((c) => String(c.name) === u.column)) handle.raw.exec(u.ddl);
  }
}

/** 在 advisory lock 保护下建表,避免多实例并发启动冲突。 */
export async function runBootstrap(): Promise<void> {
  if (dbKind === "sqlite") {
    await runSqliteBootstrap();
    return;
  }
  await runPostgresBootstrap();
}
