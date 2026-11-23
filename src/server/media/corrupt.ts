// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { media } from "@/db/schema";
import { deleteMediaByIds } from "../albums";
import { config } from "../config";

/**
 * 疑似损坏文件(处理失败)的集中管理。
 *
 * 背景:上传损坏/伪造文件(如 4KB 随机字节改名 .mp4)时,派生图与元数据无法生成,
 * 记录会被置为 `status='failed'`。这类记录既没有缩略图也没有可看的内容,
 * 留在图库里只会干扰浏览,逐个手动删除又很麻烦。
 *
 * 因此:
 *  - 图库列表默认**不展示** failed 记录(见 media/service.ts 的 listMedia);
 *  - 系统状态页集中显示数量与前 20 个文件名,可一键清理;
 *  - 若用户一直不处理,在「停止上传满 CORRUPT_AUTO_PURGE_HOURS 小时」后自动清理。
 */

/** 最近一次上传活动时间:自动清理的计时基准 */
let lastUploadAt = Date.now();

/** 每次入库(含失败)都调用,重置自动清理倒计时 */
export function noteUploadActivity() {
  lastUploadAt = Date.now();
}

export interface CorruptItem {
  id: string;
  filename: string;
  kind: string;
  size: number;
  error: string | null;
  createdAt: string;
}

export interface CorruptSummary {
  count: number;
  /** 仅返回最近的若干条,前端只展示前 20 个名字 */
  items: CorruptItem[];
  /** 自动清理的小时数,0 = 已关闭 */
  autoPurgeHours: number;
  /** 距自动清理还剩多少秒(未开启时为 null) */
  purgeInSec: number | null;
}

export async function corruptSummary(limit = 20): Promise<CorruptSummary> {
  const [total] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(media)
    .where(eq(media.status, "failed"));
  const rows = await db
    .select({ id: media.id, filename: media.filename, kind: media.kind, size: media.size, error: media.error, createdAt: media.createdAt })
    .from(media)
    .where(eq(media.status, "failed"))
    .orderBy(desc(media.createdAt))
    .limit(Math.max(1, Math.min(200, limit)));
  const hours = config.corruptAutoPurgeHours;
  const idleMs = Date.now() - lastUploadAt;
  return {
    count: Number(total?.n ?? 0),
    items: rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      kind: r.kind,
      size: r.size,
      error: r.error ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    autoPurgeHours: hours,
    purgeInSec: hours > 0 ? Math.max(0, Math.round((hours * 3600_000 - idleMs) / 1000)) : null,
  };
}

/**
 * 删除疑似损坏文件。ids 为空 = 删除全部 failed 记录。
 * 受管存储(local/s3)连源文件一并删除;挂载目录(ext)只删登记,不动服务器上的文件。
 */
export async function purgeCorrupt(ids?: string[]): Promise<{ removed: number; failed: number }> {
  const where = ids?.length
    ? and(eq(media.status, "failed"), inArray(media.id, ids))
    : eq(media.status, "failed");
  const rows = await db.select({ id: media.id, storage: media.storage }).from(media).where(where);
  if (!rows.length) return { removed: 0, failed: 0 };

  const owned = rows.filter((r) => r.storage !== "ext").map((r) => r.id);
  const mounted = rows.filter((r) => r.storage === "ext").map((r) => r.id);

  let removed = 0;
  let failed = 0;
  // 受管存储:记录与源文件一起删
  if (owned.length) {
    const r = await deleteMediaByIds(owned, true, { user: null, block: false });
    removed += r.removed;
    failed += r.failed.length;
  }
  // 挂载目录:只删登记,绝不物理删除用户自己的文件
  if (mounted.length) {
    const r = await deleteMediaByIds(mounted, false, { user: null, block: false });
    removed += r.removed;
    failed += r.failed.length;
  }
  return { removed, failed };
}

/**
 * 自动清理:停止上传满 N 小时后清空疑似损坏文件。
 * 每 10 分钟检查一次;进程启动时 lastUploadAt = 当前时间,因此不会一上线就清。
 */
export function startCorruptSweeper() {
  if (config.corruptAutoPurgeHours <= 0) return;
  const tick = () => {
    void sweep().catch((e) => console.error("[corrupt] 自动清理失败", e));
  };
  const t = setInterval(tick, 10 * 60_000);
  t.unref?.();
}

async function sweep() {
  const hours = config.corruptAutoPurgeHours;
  if (hours <= 0) return;
  if (Date.now() - lastUploadAt < hours * 3600_000) return;
  const rows = await db.select({ id: media.id }).from(media).where(eq(media.status, "failed"));
  if (!rows.length) return;
  const r = await purgeCorrupt(rows.map((x) => x.id));
  if (r.removed) {
    console.log(`[corrupt] 停止上传已超过 ${hours} 小时,自动清理 ${r.removed} 个疑似损坏文件`);
  }
}
