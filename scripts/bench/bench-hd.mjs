#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * HD(高清预览 + 水印)黑盒基准:对真实服务发 HTTP 请求,度量进程峰值内存、总耗时、单请求 p50/p95。
 *
 *   node scripts/bench/bench-hd.mjs                       # 自启动临时 SQLite 实例(需先 npm run build)
 *   node scripts/bench/bench-hd.mjs --quick               # 小素材(大图 4MP),CI/小机器冒烟
 *   node scripts/bench/bench-hd.mjs --env HD_CONCURRENCY=1,MEDIA_BUDGET_MB=300 --save out.json --compare scripts/bench/baseline-hd-synthetic-quick.json
 *   node scripts/bench/bench-hd.mjs --base http://host:3000 --password xxx     # 连接已有服务(Docker/远程)
 *
 * 场景(每个场景前重置峰值;都经过令牌签发 → /hd 的完整路径,与浏览器一致):
 *   miss-guest ×1/×3/×8   游客 + 不同大图:缓存未命中,转换 + 水印 + 写缓存
 *   hit-guest  ×24        游客 + 同一张图:游客水印成品缓存命中(几乎不占 CPU/内存)
 *   hit-user   ×24        登录用户 + 同一张图:基图命中但每次都要合成带 U-XXXXXX 的水印(最重的命中路径)
 *   mixed      2 大 + 22 小,游客/登录用户交替,大图未命中
 * 选项:--big-mp N(默认 12)  --big N(默认 14 张,须 ≥ 14:12 张给 miss 场景,2 张给 mixed 场景)  --keep(保留工作目录)  --port N(默认 3300)  --work DIR
 */
import { Client, sleep, waitProcessed } from "../lib/harness.mjs";
import { connect, envInfo, parseArgs, pct, report, uniqueJpeg } from "./lib.mjs";

const a = parseArgs();
const BIG_MP = Number(a["big-mp"] || (a.quick ? 4 : 12));
const BIG_N = Math.max(14, Number(a.big || 14));
const SMALL_N = 24;
const dims = (mp) => {
  const h = Math.round(Math.sqrt((mp * 1e6 * 3) / 4));
  return { w: Math.round((mp * 1e6) / h), h };
};

const ctx = await connect(a);
const rows = [];
try {
  const guest = new Client(ctx.admin.base);
  const stamp = Date.now().toString(36);
  const album = (await ctx.admin.post("/albums", { name: `bench-hd-${stamp}`, visibility: "public" })).data;
  await ctx.admin.post("/users", { username: `bv_${stamp}`, password: "bench-view-123", role: "viewer" });
  const viewer = await ctx.client.login(`bv_${stamp}`, "bench-view-123");

  process.stderr.write(`准备素材:${BIG_N} 张 ${BIG_MP}MP + ${SMALL_N} 张 1MP …\n`);
  const upload = async (w, h, name) => {
    const r = await ctx.admin.upload({ album: album.code }, [{ name, field: "file", data: await uniqueJpeg(w, h) }]);
    const id = r.data?.results?.[0]?.id;
    if (!id) throw new Error(`上传失败 ${name}: ${r.status} ${r.buf.toString().slice(0, 200)}`);
    return id;
  };
  const bd = dims(BIG_MP);
  const big = [];
  for (let i = 0; i < BIG_N; i++) big.push(await upload(bd.w, bd.h, `big-${i}.jpg`));
  const sd = dims(1);
  const small = [];
  for (let i = 0; i < SMALL_N; i++) small.push(await upload(sd.w, sd.h, `small-${i}.jpg`));
  await waitProcessed(ctx.admin, [...big, ...small], { timeout: 15 * 60_000 });
  await sleep(1500);

  /** 一次完整 HD 请求:签发令牌 → 取图。返回 { ms, status, cache, wm } */
  async function hd(c, id) {
    const t0 = Date.now();
    const tk = await c.get(`/media/${id}/hd-token?w=2560`);
    if (!tk.data?.token) return { ms: Date.now() - t0, status: tk.status };
    const r = await c.get(`/media/${id}/hd?t=${encodeURIComponent(tk.data.token)}&w=2560`);
    return { ms: Date.now() - t0, status: r.status, cache: r.headers.get("x-pgs-cache"), wm: r.headers.get("x-pgs-wm-cache"), bytes: r.buf.length };
  }

  async function scenario(name, conc, jobs) {
    await ctx.peak.reset?.();
    const base = (await ctx.peak.rss?.()) ?? null;
    const t0 = Date.now();
    const res = await Promise.all(jobs.map((j) => hd(j.c, j.id)));
    const totalMs = Date.now() - t0;
    const peak = await ctx.peak.read();
    await sleep(Number(a.settle || 3) * 1000);
    const settled = (await ctx.peak.rss?.()) ?? null;
    const states = {};
    for (const r of res) {
      const k = `${r.status}${r.cache ? "/" + r.cache : ""}${r.wm ? "/wm:" + r.wm : ""}`;
      states[k] = (states[k] || 0) + 1;
    }
    const lat = res.map((r) => r.ms);
    const row = {
      scen: name, conc, ok: res.filter((r) => r.status === 200).length, base, peak, settled, totalMs, p50: pct(lat, 0.5), p95: pct(lat, 0.95),
      states: Object.entries(states).map(([k, v]) => `${k}×${v}`).join(" "),
    };
    rows.push(row);
    process.stderr.write(`· ${name} ×${conc} 完成\n`);
  }

  let bi = 0;
  for (const n of [1, 3, 8]) await scenario("miss-guest", n, Array.from({ length: n }, () => ({ c: guest, id: big[bi++] })));
  const hot = big[0];
  await hd(guest, hot); // 预热:基图 + 游客水印成品
  await sleep(800);
  await scenario("hit-guest", 24, Array.from({ length: 24 }, () => ({ c: guest, id: hot })));
  await scenario("hit-user", 24, Array.from({ length: 24 }, () => ({ c: viewer, id: hot })));
  // mixed:用从未访问过的 2 张大图(未命中)+ 22 张小图,游客/登录用户交替
  const mixedIds = [...big.slice(12, 14), ...small.slice(0, 22)];
  await scenario("mixed", mixedIds.length, mixedIds.map((id, i) => ({ c: i % 2 ? viewer : guest, id })));

  const status = (await (async () => (await sleep(5200), ctx.admin.get("/status")))()).data;
  const env = { ...envInfo(ctx), bigMp: BIG_MP, quick: !!a.quick, hdConfig: { hdConcurrency: status?.config?.hdConcurrency, mediaBudget: status?.config?.mediaBudget?.budgetMB } };
  report({
    title: "HD 基准(游客水印成品缓存 / 登录用户合成)", env, rows, a,
    keyOf: (r) => `${r.scen}|${r.conc}`,
    columns: [
      { key: "scen", title: "场景" }, { key: "conc", title: "并发", num: true }, { key: "ok", title: "200 数", num: true },
      { key: "peak", title: "峰值RSS MB", num: true, cmp: true }, { key: "settled", title: "静置RSS MB", num: true },
      { key: "totalMs", title: "总耗时 ms", num: true, cmp: true }, { key: "p50", title: "p50", num: true }, { key: "p95", title: "p95", num: true, cmp: true },
      { key: "states", title: "状态分布(状态码/基图缓存/水印成品缓存)" },
    ],
  });
  console.log(`\n服务端 HD 统计:${JSON.stringify(status?.hd)}`);
  console.log(`服务端准入统计:${JSON.stringify(status?.queue?.admission ?? null)}`);
  const bad = rows.filter((r) => r.ok !== r.conc);
  if (bad.length) console.log(`\n⚠ 有场景存在非 200 响应(503 = 内存预算排队超时属预期的保护行为;其它状态请排查):${bad.map((r) => r.scen + "×" + r.conc).join(", ")}`);
} finally {
  await ctx.stop();
}
process.exit(0);
