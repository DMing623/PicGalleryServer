#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 挂载目录扫描基准(P2-6):在一个平铺目录里放 N 个小 JPEG,对挂载相册执行一次扫描(等待结束),
 * 记录扫描耗时与进程峰值 RSS(相对扫描前),用来判断 albums.ts#scanAlbum「整目录进内存」是否需要改成流式。
 *
 *   node scripts/bench/bench-scan.mjs --files 5000,20000          # 自启动临时 SQLite 实例(需先 npm run build)
 *   node scripts/bench/bench-scan.mjs --files 100000 --work /data/bench   # 大目录;工作目录需可写(容器里用 uid 1000 可写的卷)
 *
 * 说明:文件是真实可解码的 1×1 JPEG(内容相同但文件名不同;挂载扫描按路径入库,不去重),
 * 扫描会把它们全部入队处理,所以「峰值」包含了派生队列的少量开销(1×1 图的解码成本可忽略)。
 * 判据:峰值增量 / 文件数 的比值;若 10 万文件的增量超过 200MB 再考虑改成 opendir 流式 + 分批查库(见 project.md §14)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { sleep } from "../lib/harness.mjs";
import { connect, envInfo, parseArgs, report } from "./lib.mjs";

const a = parseArgs();
const sizes = String(a.files || "5000,20000").split(",").map(Number).filter((n) => n > 0);
const work = path.resolve(String(a.work || path.join(process.env.TEST_TMP || os.tmpdir(), `pgs-bench-scan-${process.pid}`)));
const photos = path.join(work, "photos");
fs.mkdirSync(photos, { recursive: true });
const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#808080" } }).jpeg().toBuffer();

const ctx = await connect({ ...a, work: path.join(work, "run") }, { extraEnv: { ALLOWED_MOUNT_ROOTS: photos, THUMB_CONCURRENCY: "2" } });
const rows = [];
try {
  let made = 0;
  for (const n of sizes) {
    const dir = path.join(photos, `n${n}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `img_${String(i).padStart(7, "0")}.jpg`), tiny);
    made += n;
    await ctx.peak.reset?.();
    const before = (await ctx.peak.rss?.()) ?? null;
    const m = await ctx.admin.post("/albums/mount", { path: dir, name: `scan-${n}`, visibility: "private", scan: false });
    const code = m.data?.code;
    if (!code) throw new Error(`挂载失败 ${n}: ${m.status} ${m.buf.toString().slice(0, 200)}`);
    const t0 = Date.now();
    const r = await ctx.admin.post(`/albums/${code}/scan?wait=1`, undefined, { timeout: 30 * 60_000 });
    const scanMs = Date.now() - t0;
    const peak = await ctx.peak.read();
    // 等待派生队列清空后再读静置内存
    for (let i = 0; i < 600; i++) {
      const q = (await ctx.admin.get("/status/queue")).data;
      if (q && !q.running && !q.waiting && !q.pending) break;
      await sleep(500);
    }
    const idleMs = Date.now() - t0;
    await sleep(2000);
    const settled = (await ctx.peak.rss?.()) ?? null;
    rows.push({ files: n, added: r.data?.added ?? null, scanMs, queueIdleMs: idleMs, before, peak, peakDelta: peak != null && before != null ? peak - before : null, settled, perKfileKB: peak != null && before != null ? ((peak - before) * 1024) / (n / 1000) : null });
    process.stderr.write(`· ${n} 个文件完成\n`);
  }
  report({
    title: "挂载目录扫描基准", env: { ...envInfo(ctx), totalFilesCreated: made }, rows, a,
    keyOf: (r) => String(r.files),
    columns: [
      { key: "files", title: "文件数", num: true }, { key: "added", title: "入库数", num: true }, { key: "scanMs", title: "扫描耗时 ms", num: true, cmp: true },
      { key: "queueIdleMs", title: "队列清空 ms", num: true }, { key: "before", title: "扫描前RSS MB", num: true }, { key: "peak", title: "峰值RSS MB", num: true, cmp: true },
      { key: "peakDelta", title: "峰值增量 MB", num: true, cmp: true }, { key: "settled", title: "静置RSS MB", num: true }, { key: "perKfileKB", title: "每千文件增量 KB", num: true },
    ],
  });
} finally {
  await ctx.stop();
  if (!a.keep) fs.rmSync(work, { recursive: true, force: true });
}
process.exit(0);
