#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 后台派生队列黑盒基准:上传一批文件,轮询处理完成时间,看「类别分池 / 内存预算 / 老化」是否把队列堵住。
 *
 *   node scripts/bench/bench-queue.mjs                           # 自启动临时 SQLite 实例(需先 npm run build)
 *   node scripts/bench/bench-queue.mjs --quick                   # 更少的文件数/更小的大图
 *   node scripts/bench/bench-queue.mjs --real /path/with/heic    # 目录里有 .heic 时额外跑「HEIC + JPEG 混合」
 *   node scripts/bench/bench-queue.mjs --base http://host:3000 --password xxx    # 连接已有服务
 *   node scripts/bench/bench-queue.mjs --env THUMB_CONCURRENCY=2,MEDIA_BUDGET_MB=300 --save out.json --compare baseline.json
 *
 * 场景(每个场景使用独立相册,结束后等队列清空再进行下一个):
 *   jpeg-100          100 张 0.3MP JPEG:纯小图吞吐,作对照
 *   big-plus-small    1 张大图(默认 24MP)+ 20 张小图同时入队:小图不应被大图堵到最后(预算 + 老化)
 *   heic-plus-jpeg    N 张真实 HEIC + 100 张 JPEG(需要 --real):JPEG 不应被 HEIC 拖到最后,HEIC 也不应被饿死
 * 指标:全部完成总耗时、单文件「上传完成 → 状态不再是 pending」的 p50/p95、JPEG/小图的最后完成时刻、峰值 RSS、队列峰值 waiting。
 */
import fs from "node:fs";
import path from "node:path";
import { sleep } from "../lib/harness.mjs";
import { connect, envInfo, parseArgs, pct, report, uniqueJpeg } from "./lib.mjs";

const a = parseArgs();
const QUICK = !!a.quick;
const N_JPEG = QUICK ? 40 : 100;
const BIG_MP = Number(a["big-mp"] || (QUICK ? 8 : 24));
const dims = (mp) => {
  const h = Math.round(Math.sqrt((mp * 1e6 * 3) / 4));
  return { w: Math.round((mp * 1e6) / h), h };
};

const ctx = await connect(a);
const rows = [];
try {
  async function waitIdle(timeout = 20 * 60_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const q = (await ctx.admin.get("/status/queue")).data;
      if (q && !q.running && !q.waiting && !q.pending) return;
      await sleep(400);
    }
  }

  /**
   * 上传 files([{name, data, tag}])并跟踪完成时间。
   * 上传是顺序进行的(模拟批量导入),处理与上传并行,所以以「整批上传开始」为 0 点计时。
   */
  async function run(name, files) {
    await waitIdle();
    const album = (await ctx.admin.post("/albums", { name: `bq-${name}-${Date.now().toString(36)}`, visibility: "public" })).data;
    await ctx.peak.reset?.();
    const t0 = Date.now();
    const meta = new Map(); // id → { tag, doneMs }
    let maxWaiting = 0;
    let stop = false;
    const poll = (async () => {
      while (!stop || [...meta.values()].some((m) => m.doneMs == null)) {
        const list = (await ctx.admin.get(`/media?album=${album.code}&limit=500`)).data?.items ?? [];
        for (const it of list) {
          const m = meta.get(it.id);
          if (m && m.doneMs == null && it.status !== "pending") m.doneMs = Date.now() - t0;
        }
        const q = (await ctx.admin.get("/status/queue")).data;
        maxWaiting = Math.max(maxWaiting, (q?.waiting ?? 0) + (q?.pending ?? 0));
        if (Date.now() - t0 > 30 * 60_000) break;
        await sleep(250);
      }
    })();
    for (const f of files) {
      const r = await ctx.admin.upload({ album: album.code }, [{ name: f.name, field: "file", data: f.data }]);
      const id = r.data?.results?.[0]?.id;
      if (id) meta.set(id, { tag: f.tag, doneMs: null });
    }
    const uploadedMs = Date.now() - t0;
    stop = true;
    await poll;
    const totalMs = Date.now() - t0;
    const peak = await ctx.peak.read();
    const byTag = (tag) => [...meta.values()].filter((m) => m.tag === tag && m.doneMs != null).map((m) => m.doneMs);
    const all = [...meta.values()].map((m) => m.doneMs).filter((x) => x != null);
    const small = [...byTag("jpeg"), ...byTag("small")];
    rows.push({
      scen: name, files: meta.size, uploadMs: uploadedMs, totalMs, p50: pct(all, 0.5), p95: pct(all, 0.95),
      smallLastMs: small.length ? Math.max(...small) : null, bigDoneMs: byTag("big")[0] ?? null, heicLastMs: byTag("heic").length ? Math.max(...byTag("heic")) : null,
      peak, maxWaiting,
    });
    process.stderr.write(`· ${name} 完成 (${meta.size} 个, ${totalMs}ms)\n`);
  }

  const sd = dims(0.3);
  const jpegs = async (n, tag = "jpeg") => {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ name: `${tag}-${i}.jpg`, tag, data: await uniqueJpeg(sd.w, sd.h, { quality: 85 }) });
    return out;
  };
  await run("jpeg-100", await jpegs(N_JPEG));
  const bd = dims(BIG_MP);
  await run("big-plus-small", [{ name: "big.jpg", tag: "big", data: await uniqueJpeg(bd.w, bd.h) }, ...(await jpegs(20, "small"))]);

  const realDir = a.real ? path.resolve(String(a.real)) : null;
  const heics = realDir && fs.existsSync(realDir) ? fs.readdirSync(realDir).filter((f) => /\.(heic|heif)$/i.test(f)).slice(0, QUICK ? 5 : 20) : [];
  if (heics.length) {
    const files = [];
    for (const f of heics) files.push({ name: f, tag: "heic", data: fs.readFileSync(path.join(realDir, f)) });
    files.push(...(await jpegs(N_JPEG)));
    // 同一张 HEIC 重复上传会被去重 → 只上传一次每个文件;样张少于 5 张时 HEIC 数量就是样张数量
    await run("heic-plus-jpeg", files);
  } else {
    console.log("(跳过 heic-plus-jpeg:未提供含 .heic 的目录,--real <dir>;HEIC 无法合成,必须用真实 iPhone 样张)");
  }

  const status = (await ctx.admin.get("/status")).data;
  const env = { ...envInfo(ctx), quick: QUICK, bigMp: BIG_MP, heicFiles: heics.length, config: { thumbConcurrency: status?.config?.thumbConcurrency, heic: status?.config?.heicConcurrency, budget: status?.config?.mediaBudget?.budgetMB } };
  report({
    title: "后台派生队列基准", env, rows, a,
    keyOf: (r) => r.scen,
    columns: [
      { key: "scen", title: "场景" }, { key: "files", title: "文件数", num: true }, { key: "uploadMs", title: "上传耗时 ms", num: true },
      { key: "totalMs", title: "全部完成 ms", num: true, cmp: true }, { key: "p50", title: "p50", num: true }, { key: "p95", title: "p95", num: true, cmp: true },
      { key: "smallLastMs", title: "小图最后完成 ms", num: true, cmp: true }, { key: "bigDoneMs", title: "大图完成 ms", num: true }, { key: "heicLastMs", title: "HEIC 最后完成 ms", num: true },
      { key: "peak", title: "峰值RSS MB", num: true, cmp: true }, { key: "maxWaiting", title: "队列峰值等待", num: true },
    ],
  });
  console.log(`\n服务端队列统计:${JSON.stringify(status?.queue?.admission ?? null)}`);
  const failed = (await ctx.admin.get("/status/corrupt?limit=5")).data;
  if (failed?.total) console.log(`⚠ 有 ${failed.total} 个文件处理失败,请排查(基准素材不应失败)`);
} finally {
  await ctx.stop();
}
process.exit(0);
