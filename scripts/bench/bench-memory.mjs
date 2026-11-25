#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 媒体处理内存/耗时基准:每个「素材 × 场景 × 并发」单独起一个子进程,取干净的峰值(VmHWM)。
 * 不需要 root、不联网、不需要数据库;在容器内运行最接近线上(jemalloc + MALLOC_ARENA_MAX=2)。
 *
 *   node scripts/bench/generate-images.mjs --out /tmp/pgs-bench           # 先生成素材
 *   node scripts/bench/bench-memory.mjs --dir /tmp/pgs-bench              # 跑全部
 *   node scripts/bench/bench-memory.mjs --dir ... --only progressive --conc 1,4 --save base.json
 *   node scripts/bench/bench-memory.mjs --dir ... --compare base.json     # 与基线对比(内存与耗时一起看)
 *
 * 场景:derive = 与 derive.ts#makeDerived 等价(preview 1600 + thumb 720);
 *       hd     = 与 hd/service.ts#convert 等价(2560 宽 WebP);
 *       HEIC 素材(real/*.heic)先经 heic-convert 再走同一流水线,体现 wasm 解码成本。
 * 每个结果:峰值 RSS(MB)、静置后 RSS(MB)、总耗时、单任务 p50/p95。
 * 参数:--sharp-concurrency N(默认 2,与项目一致)  --settle SEC(默认 3)  --limit-mp N(默认 268,derive 与项目一致)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);

/* ===================== 子进程:跑一个场景 ===================== */
if (argv[0] === "--child") {
  const [, scen, file, nStr, sc, settleStr, limitMp] = argv;
  const { default: sharp } = await import("sharp");
  sharp.cache(false);
  sharp.concurrency(Number(sc) || 2);
  const status = () => fs.readFileSync("/proc/self/status", "utf8");
  const mb = (re) => {
    try {
      return Number(re.exec(status())[1]) / 1024;
    } catch {
      return process.resourceUsage().maxRSS / 1024; // 非 Linux:近似
    }
  };
  const hwm = () => mb(/VmHWM:\s+(\d+)/);
  const rss = () => mb(/VmRSS:\s+(\d+)/);
  const IN = { failOn: "none", limitInputPixels: Number(limitMp) * 1e6, sequentialRead: true };
  const isHeic = /\.(heic|heif)$/i.test(file);
  const load = async () => {
    if (!isHeic) return file;
    const convert = (await import("heic-convert")).default;
    const out = await convert({ buffer: fs.readFileSync(file), format: "JPEG", quality: 0.92 });
    return Buffer.from(out);
  };
  const derive = async () => {
    const input = await load();
    const prev = await sharp(input, IN).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 84 }).toBuffer();
    await sharp(prev, IN).resize({ width: 720, height: 1440, fit: "inside", withoutEnlargement: true }).webp({ quality: 84 }).toBuffer();
  };
  const hd = async () => {
    const input = await load();
    await sharp(input, { failOn: "none", limitInputPixels: 200e6 }).rotate().resize({ width: 2560, height: 4096, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  };
  const fn = scen === "hd" ? hd : derive;
  const base = rss();
  const n = Number(nStr) || 1;
  const t0 = Date.now();
  const durs = [];
  let error = null;
  try {
    await Promise.all(
      Array.from({ length: n }, async () => {
        const s = Date.now();
        await fn();
        durs.push(Date.now() - s);
      }),
    );
  } catch (e) {
    error = String(e?.message ?? e);
  }
  const total = Date.now() - t0;
  const peak = hwm();
  await new Promise((r) => setTimeout(r, Number(settleStr) * 1000));
  global.gc?.();
  durs.sort((a, b) => a - b);
  const q = (p) => durs[Math.min(durs.length - 1, Math.floor(durs.length * p))] ?? null;
  console.log("@@RESULT@@" + JSON.stringify({ base, peak, settled: rss(), totalMs: total, p50: q(0.5), p95: q(0.95), error }));
  process.exit(0);
}

/* ===================== 父进程:编排 + 报告 ===================== */
const dir = path.resolve(opt("--dir", "/tmp/pgs-bench"));
const manifestFile = path.join(dir, "manifest.json");
if (!fs.existsSync(manifestFile)) {
  console.error(`没有素材:${manifestFile} 不存在。先运行 node scripts/bench/generate-images.mjs --out ${dir}`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const only = opt("--only", "");
const concs = opt("--conc", "1,4").split(",").map(Number).filter((n) => n > 0);
const scens = opt("--scen", "derive,hd").split(",");
const settle = opt("--settle", "3");
const sharpConc = opt("--sharp-concurrency", "2");
const limitMp = opt("--limit-mp", "268");

const rows = [];
for (const it of manifest.items) {
  if (only && !it.name.includes(only)) continue;
  if (/\.bmp$/i.test(it.name)) {
    rows.push({ item: it.name, mp: it.megapixels, scen: "-", conc: "-", skipped: "sharp 预编译版不含 BMP 加载器,BMP 路径由项目内置解码器处理(见 e2e)" });
    continue;
  }
  if (!fs.existsSync(it.file)) continue;
  for (const scen of scens) {
    for (const n of concs) {
      const r = spawnSync(process.execPath, [SELF, "--child", scen, it.file, String(n), sharpConc, settle, limitMp], { encoding: "utf8", timeout: 10 * 60_000, env: process.env });
      const m = /@@RESULT@@(.*)/.exec(r.stdout ?? "");
      if (!m) {
        rows.push({ item: it.name, mp: it.megapixels, scen, conc: n, error: `子进程失败(code=${r.status} signal=${r.signal}) ${(r.stderr ?? "").slice(-200)}` });
        continue;
      }
      rows.push({ item: it.name, mp: it.megapixels, scen, conc: n, ...JSON.parse(m[1]) });
      process.stderr.write(".");
    }
  }
}
process.stderr.write("\n");

const env = {
  node: process.version, platform: `${process.platform}/${process.arch}`,
  cpus: (await import("node:os")).availableParallelism?.(), sharpConcurrency: Number(sharpConc),
  jemalloc: /jemalloc/.test(process.env.LD_PRELOAD ?? ""), mallocArenaMax: process.env.MALLOC_ARENA_MAX ?? null,
  quick: manifest.quick, createdAt: new Date().toISOString(),
};
const result = { env, rows };
const out = opt("--save", "");
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));

const base = opt("--compare", "") ? JSON.parse(fs.readFileSync(opt("--compare", ""), "utf8")) : null;
const key = (r) => `${r.item}|${r.scen}|${r.conc}`;
const baseMap = new Map((base?.rows ?? []).map((r) => [key(r), r]));
const f = (x) => (x == null ? "-" : Math.round(x));
const delta = (cur, old) => (cur == null || old == null || !old ? "" : ` (${cur >= old ? "+" : ""}${Math.round(((cur - old) / old) * 100)}%)`);

console.log(`\n环境:${JSON.stringify(env)}\n`);
console.log("| 素材 | MP | 场景 | 并发 | 峰值RSS MB | 静置RSS MB | 总耗时 ms | p50 | p95 |");
console.log("|---|---:|---|---:|---:|---:|---:|---:|---:|");
for (const r of rows) {
  if (r.skipped) {
    console.log(`| ${r.item} | ${r.mp ?? "-"} | - | - | _跳过:${r.skipped}_ | | | | |`);
    continue;
  }
  if (r.error && r.peak == null) {
    console.log(`| ${r.item} | ${r.mp ?? "-"} | ${r.scen} | ${r.conc} | ❌ ${r.error} | | | | |`);
    continue;
  }
  const b = baseMap.get(key(r));
  console.log(`| ${r.item} | ${r.mp ?? "-"} | ${r.scen} | ${r.conc} | ${f(r.peak)}${delta(r.peak, b?.peak)} | ${f(r.settled)} | ${f(r.totalMs)}${delta(r.totalMs, b?.totalMs)} | ${f(r.p50)} | ${f(r.p95)} |${r.error ? ` ⚠ ${r.error}` : ""}`);
}
if (base) console.log("\n括号内为相对基线的变化:内存与耗时要一起看,防止「峰值降了、时间翻倍」。");
process.exit(rows.some((r) => r.error && r.peak == null) ? 1 : 0);
