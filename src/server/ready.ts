// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { runBootstrap } from "@/db/bootstrap";
import { media } from "@/db/schema";
import { scanAllMounted } from "./albums";
import { syncEnvAdmin } from "./auth";
import { config, dirs } from "./config";
import { purgeExpiredKeys } from "./keys";
import { processMedia } from "./media/derive";
import { enqueue, setRunner } from "./queue";

/**
 * 进程启动初始化(幂等,只执行一次): 建表 → 目录 → 同步 env 管理员 → 恢复未完成任务 → 定时器。
 * 由 instrumentation.ts 与每个 API 请求(await ensureReady())触发。
 */

const g = globalThis as typeof globalThis & { __pgsReady?: Promise<void> };

async function init() {
  await runBootstrap();
  await Promise.all(Object.values(dirs).map((d) => fs.mkdir(d, { recursive: true })));
  await syncEnvAdmin();
  setRunner(processMedia);

  // 恢复上次未处理完的任务
  const pending = await db.select({ id: media.id }).from(media).where(eq(media.status, "pending")).limit(50_000);
  pending.forEach((r) => enqueue(r.id));

  const hourly = setInterval(() => {
    void purgeExpiredKeys().catch(() => undefined);
    void cleanTmp().catch(() => undefined);
  }, 3600_000);
  hourly.unref();
  void purgeExpiredKeys().catch(() => undefined);

  if (config.scanIntervalMin > 0) {
    const t = setInterval(() => void scanAllMounted().catch(() => undefined), config.scanIntervalMin * 60_000);
    t.unref();
  }
}

/** 清理 6 小时前遗留的临时文件(异常中断的上传等) */
async function cleanTmp() {
  const now = Date.now();
  for (const f of await fs.readdir(dirs.tmp).catch(() => [] as string[])) {
    const p = path.join(dirs.tmp, f);
    const st = await fs.stat(p).catch(() => null);
    if (st?.isFile() && now - st.mtimeMs > 6 * 3600_000) await fs.unlink(p).catch(() => undefined);
  }
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
