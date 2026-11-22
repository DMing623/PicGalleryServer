import { createHash, randomBytes, randomUUID } from "node:crypto";
import { desc, eq, isNotNull, lt, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { downloadKeys } from "@/db/schema";
import { E } from "./http";

/**
 * 原文件下载密钥。数据库只保存 SHA-256 哈希与提示(前 2 位),明文仅在创建时返回一次。
 * 过期(24h 模式)的密钥会被自动删除:验证时惰性删除 + 每小时定时清理。
 */

const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

export async function createKey(input: {
  key?: unknown; label?: unknown; expires?: unknown; ttlHours?: unknown; createdBy: string;
}) {
  let key: string;
  if (input.key === undefined || input.key === null || input.key === "") key = randomBytes(18).toString("base64url");
  else if (typeof input.key === "string" && KEY_RE.test(input.key)) key = input.key;
  else throw E.badRequest("自定义密钥只能含字母数字 _ -,长度 8~128");

  const mode = input.expires === undefined || input.expires === "" ? "never" : String(input.expires);
  let expiresAt: Date | null = null;
  if (mode === "24h") expiresAt = new Date(Date.now() + 24 * 3600_000);
  else if (mode === "never") expiresAt = null;
  else if (mode === "custom") {
    const h = Number(input.ttlHours);
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 365) throw E.badRequest("ttlHours 应在 (0, 8760]");
    expiresAt = new Date(Date.now() + h * 3600_000);
  } else throw E.badRequest("expires 只能是 never | 24h | custom");

  const label = typeof input.label === "string" ? input.label.slice(0, 80) : "";
  const hash = hashKey(key);
  const hint = `${key.slice(0, 2)}${"*".repeat(Math.max(0, key.length - 2))}`.slice(0, 12);
  // 相同密钥重复设置 = 更新其标签与有效期
  const [row] = await db
    .insert(downloadKeys)
    .values({ id: randomUUID(), keyHash: hash, hint, label, expiresAt, createdBy: input.createdBy })
    .onConflictDoUpdate({ target: downloadKeys.keyHash, set: { label, expiresAt } })
    .returning();
  return { id: row.id, key, hint, label, expiresAt: row.expiresAt };
}

export async function listKeys() {
  const rows = await db.select().from(downloadKeys).orderBy(desc(downloadKeys.createdAt));
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id, hint: r.hint, label: r.label, expiresAt: r.expiresAt, createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt, useCount: r.useCount, expired: !!r.expiresAt && r.expiresAt.getTime() < now,
  }));
}

export async function deleteKeyById(id: string): Promise<boolean> {
  const r = await db.delete(downloadKeys).where(eq(downloadKeys.id, id)).returning({ id: downloadKeys.id });
  return r.length > 0;
}

export async function deleteKeyByValue(key: string): Promise<boolean> {
  const r = await db.delete(downloadKeys).where(eq(downloadKeys.keyHash, hashKey(key))).returning({ id: downloadKeys.id });
  return r.length > 0;
}

/** 验证密钥。countUse=false 用于 Range 续传请求,避免重复计数 */
export async function verifyKey(key: string | null | undefined, countUse = true): Promise<boolean> {
  if (!key || key.length > 200) return false;
  const [row] = await db.select().from(downloadKeys).where(eq(downloadKeys.keyHash, hashKey(key))).limit(1);
  if (!row) return false;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    void db.delete(downloadKeys).where(eq(downloadKeys.id, row.id)).catch(() => undefined);
    return false;
  }
  if (countUse) {
    void db
      .update(downloadKeys)
      .set({ useCount: sql`${downloadKeys.useCount} + 1`, lastUsedAt: new Date() })
      .where(eq(downloadKeys.id, row.id))
      .catch(() => undefined);
  }
  return true;
}

export async function purgeExpiredKeys(): Promise<number> {
  const r = await db
    .delete(downloadKeys)
    .where(and(isNotNull(downloadKeys.expiresAt), lt(downloadKeys.expiresAt, new Date())))
    .returning({ id: downloadKeys.id });
  return r.length;
}
