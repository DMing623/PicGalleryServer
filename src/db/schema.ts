// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** 账户。role: admin | manager | uploader | viewer */
export const users = pgTable("pgs_users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("viewer"),
  disabled: boolean("disabled").notNull().default(false),
  /** env = 由环境变量同步的超级管理员, api = 经接口创建 */
  source: text("source").notNull().default("api"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

/** 相册分类。kind: managed(data 目录内) | mounted(挂载的绝对路径) */
export const albums = pgTable(
  "pgs_albums",
  {
    id: text("id").primaryKey(),
    /** 对外使用的相册代码: alb_xxxxxx(受管) / dir_xxxxxx(挂载) */
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    parentId: text("parent_id"),
    kind: text("kind").notNull().default("managed"),
    /** 存储代码: local | s3 | ext */
    storage: text("storage").notNull().default("local"),
    rootPath: text("root_path"),
    /** public | private */
    visibility: text("visibility").notNull().default("private"),
    coverMediaId: text("cover_media_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pgs_albums_parent_idx").on(t.parentId), uniqueIndex("pgs_albums_root_uq").on(t.rootPath)],
);

/** 媒体文件(图片/视频) */
export const media = pgTable(
  "pgs_media",
  {
    id: text("id").primaryKey(),
    albumId: text("album_id"),
    /** image | video */
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    width: integer("width"),
    height: integer("height"),
    duration: real("duration"),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    /** 排序时间 = takenAt ?? 文件修改时间 */
    sortAt: timestamp("sort_at", { withTimezone: true }).notNull().defaultNow(),
    storage: text("storage").notNull(),
    storageKey: text("storage_key").notNull(),
    hash: text("hash"),
    color: text("color"),
    /** pending | ready | failed */
    status: text("status").notNull().default("pending"),
    error: text("error"),
    note: text("note").notNull().default(""),
    meta: jsonb("meta"),
    searchText: text("search_text").notNull().default(""),
    uploadedBy: text("uploaded_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pgs_media_sort_idx").on(t.sortAt, t.id),
    index("pgs_media_album_sort_idx").on(t.albumId, t.sortAt, t.id),
    uniqueIndex("pgs_media_storage_uq").on(t.storage, t.storageKey),
    index("pgs_media_hash_idx").on(t.hash),
    index("pgs_media_status_idx").on(t.status),
  ],
);

/** 原文件下载密钥(仅存哈希) */
export const downloadKeys = pgTable("pgs_download_keys", {
  id: text("id").primaryKey(),
  keyHash: text("key_hash").notNull().unique(),
  hint: text("hint").notNull(),
  label: text("label").notNull().default(""),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  useCount: integer("use_count").notNull().default(0),
});

/** 键值设置 */
export const settings = pgTable("pgs_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
