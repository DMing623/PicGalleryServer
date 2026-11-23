// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import fs from "node:fs/promises";
import path from "node:path";
import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { runBootstrap } from "@/db/bootstrap";
import { media } from "@/db/schema";
import { scanAllMounted } from "./albums";
import { syncEnvAdmin } from "./auth";
import { config, dirs } from "./config";
import { purgeExpiredKeys } from "./keys";
import { sweepHdCache } from "./hd/cache";
import { processMedia } from "./media/derive";
import { startCorruptSweeper } from "./media/corrupt";
import { enqueue, setRunner } from "./queue";

/**
 * 进程启动初始化(幂等,只执行一次): 建表 → 目录 → 同步 env 管理员 → 恢复未完成任务 → 定时器。
 * 由 instrumentation.ts 与每个 API 请求(await ensureReady())触发。
 */

const g = globalThis as typeof globalThis & { __pgsReady?: Promise<void> };

/**
 * 启动安全校验(issue §1.3):生产环境不允许用仓库里公开的占位密码上线。
 * SESSION_SECRET 缺失/占位时会自动生成并持久化(见 secret.ts),这里只拦管理员密码。
 */
function assertSecureConfig() {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const pw = config.adminPassword;
  const weak = ["admin123456", "change-this-password", "changeme", "admin", "password"].includes(pw.toLowerCase());
  if (weak || pw.length < 8) {
    throw new Error(
      "ADMIN_PASSWORD 仍是默认/占位值,拒绝在生产环境启动。请在 .env 中设置一个足够强的管理员密码后重启。",
    );
  }
  if (config.sessionSecretSource === "derived") {
    console.warn("[ready] 未能持久化 SESSION_SECRET,当前使用由管理员密码派生的密钥(修改密码会使所有会话失效)");
  }
}

async function init() {
  assertSecureConfig();
  await runBootstrap();
  await Promise.all(Object.values(dirs).map((d) => fs.mkdir(d, { recursive: true })));
  await syncEnvAdmin();
  setRunner(processMedia);

  // 恢复上次未处理完的任务:分批入队,避免一次性把几十万 id 塞进内存(issue §2.9)
  const pending = await db
    .select({ id: media.id })
    .from(media)
    .where(eq(media.status, "pending"))
    .orderBy(desc(media.createdAt))
    .limit(20_000);
  pending.forEach((r) => enqueue(r.id));
  if (pending.length >= 20_000) {
    console.warn("[ready] pending 任务超过 20000 条,已优先恢复最近的 20000 条;其余请用「重新处理」触发");
  }

  const hourly = setInterval(() => {
    void purgeExpiredKeys().catch(() => undefined);
    void cleanTmp().catch(() => undefined);
    void sweepHdCache().catch(() => undefined);
  }, 3600_000);
  void sweepHdCache().catch(() => undefined);
  hourly.unref();
  void purgeExpiredKeys().catch(() => undefined);
  // 启动时清理上次进程遗留的临时文件:进程刚启动时不可能有正在进行的上传,
  // tmp/ 里的文件必然是异常中断(崩溃、kill -9)留下的残骸
  void cleanTmp(0).catch(() => undefined);
  // 疑似损坏文件的自动清理(停止上传满 CORRUPT_AUTO_PURGE_HOURS 小时后)
  startCorruptSweeper();

  if (config.scanIntervalMin > 0) {
    const t = setInterval(() => void scanAllMounted().catch(() => undefined), config.scanIntervalMin * 60_000);
    t.unref();
  }
}

/**
 * 清理遗留的临时文件(异常中断的上传等)。
 * @param olderThanMs 只清理修改时间早于该阈值的文件;0 = 全部清理(启动时用)
 */
async function cleanTmp(olderThanMs = 6 * 3600_000) {
  const now = Date.now();
  let removed = 0;
  for (const f of await fs.readdir(dirs.tmp).catch(() => [] as string[])) {
    const p = path.join(dirs.tmp, f);
    const st = await fs.stat(p).catch(() => null);
    if (st?.isFile() && now - st.mtimeMs > olderThanMs) {
      await fs.unlink(p).catch(() => undefined);
      removed++;
    }
  }
  if (removed) console.log(`[ready] 已清理 ${removed} 个遗留临时文件`);
}

export function ensureReady(): Promise<void> {
  if (!g.__pgsReady) {
    g.__pgsReady = init().catch((e) => {
      g.__pgsReady = undefined;
      console.error("[ready] init failed", e);
      throw e;
    });
  }
  return g.__pgsReady;
}
