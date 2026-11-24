// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
  /** 令牌版本:改密码/重置/强制下线时自增,旧令牌立即失效(issue §1.4) */
  tokenVersion: integer("token_version").notNull().default(0),
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
    /** 挂载相册是否只读:只读时拒绝上传/移动/物理删除(issue §1.10) */
    readonly: boolean("readonly").notNull().default(false),
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
    /** 源文件修改时间(毫秒):与 size 一起做变更检测,并用于重命名配对(issue §2.3) */
    mtimeMs: bigint("mtime_ms", { mode: "number" }),
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
    /** 软删除标记:扫描发现文件暂时消失时只打标记,连续缺失超过阈值才真正清理(issue §2.1) */
    missingAt: timestamp("missing_at", { withTimezone: true }),
    uploadedBy: text("uploaded_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pgs_media_sort_idx").on(t.sortAt, t.id),
    index("pgs_media_album_sort_idx").on(t.albumId, t.sortAt, t.id),
    uniqueIndex("pgs_media_storage_uq").on(t.storage, t.storageKey),
    index("pgs_media_hash_idx").on(t.hash),
    index("pgs_media_status_idx").on(t.status),
    index("pgs_media_missing_idx").on(t.missingAt),
  ],
);

/**
 * 删除黑名单:从相册中删除但保留源文件的记录。
 *  - 扫描挂载目录时按 (storage, storage_key) 跳过这些文件,不再重新入库
 *  - 可在设置页「删除黑名单」中解除,解除后重新生成缩略图并回到原相册
 */
export const blocklist = pgTable(
  "pgs_blocklist",
  {
    id: text("id").primaryKey(),
    /** 原媒体 id(仅用于追溯;解除黑名单时优先复用它,保证 /f/<id> 外链不失效) */
    mediaId: text("media_id"),
    albumId: text("album_id"),
    /** 删除时所属相册代码(相册被删后仍可读) */
    albumCode: text("album_code"),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    storage: text("storage").notNull(),
    storageKey: text("storage_key").notNull(),
    hash: text("hash"),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    sortAt: timestamp("sort_at", { withTimezone: true }),
    meta: jsonb("meta"),
    note: text("note").notNull().default(""),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pgs_blocklist_key_uq").on(t.storage, t.storageKey), index("pgs_blocklist_album_idx").on(t.albumId)],
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

/**
 * 站点通知(管理者及以上可发布)。
 * body 为 Markdown 原文;发布时间按「设置 → 系统状态 → 时区」换算展示。
 */
export const notices = pgTable(
  "pgs_notices",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    /** 置顶(在通知面板里优先展示) */
    pinned: boolean("pinned").notNull().default(false),
    createdBy: text("created_by"),
    /** 发布者用户名快照(用户被删后仍可显示) */
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pgs_notices_created_idx").on(t.createdAt)],
);

/** 已读记录:按用户 × 通知,存在即已读 */
export const noticeReads = pgTable(
  "pgs_notice_reads",
  {
    userId: text("user_id").notNull(),
    noticeId: text("notice_id").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.noticeId] }), index("pgs_notice_reads_user_idx").on(t.userId)],
);

