// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { pool } from "./index";

/**
 * 幂等建表脚本,必须与 schema.ts 保持一致。
 * 应用启动时自动执行,因此部署时无需手动迁移。
 * 修改 schema.ts 后请同步修改这里(可用 `npx drizzle-kit export --sql` 对照)。
 *
 * 新增字段一律用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,老库可直接升级。
 */
const DDL = `
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
-- 老库升级:补齐新增字段(幂等)
ALTER TABLE "pgs_users" ADD COLUMN IF NOT EXISTS "token_version" integer DEFAULT 0 NOT NULL;
ALTER TABLE "pgs_albums" ADD COLUMN IF NOT EXISTS "readonly" boolean DEFAULT false NOT NULL;
ALTER TABLE "pgs_media" ADD COLUMN IF NOT EXISTS "mtime_ms" bigint;
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
`;

/**
 * 搜索优化(issue §6.4):
 *  - pg_trgm + GIN 索引让 LIKE '%词%' 能走索引,避免全表顺序扫描;
 *  - status 索引基数极低(几乎都是 ready),改成只索引未完成的记录。
 * 这些语句依赖 contrib 扩展,失败不影响启动(只是没有加速)。
 */
const SEARCH_DDL = `
CREATE INDEX IF NOT EXISTS "pgs_media_todo_idx" ON "pgs_media" ("id") WHERE "status" <> 'ready';
`;

/** 在 advisory lock 保护下建表,避免多实例并发启动冲突。 */
export async function runBootstrap(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(7351001)");
    await client.query(DDL);
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
      await client.query(
        `CREATE INDEX IF NOT EXISTS "pgs_media_search_trgm" ON "pgs_media" USING gin ("search_text" gin_trgm_ops)`,
      );
    } catch (e) {
      console.warn("[bootstrap] pg_trgm 不可用,搜索将退化为顺序扫描:", (e as Error).message);
    }
    await client.query(SEARCH_DDL);
  } finally {
    await client.query("SELECT pg_advisory_unlock(7351001)").catch(() => undefined);
    client.release();
  }
}
