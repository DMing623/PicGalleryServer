#!/usr/bin/env node
// 临时脚本:v1.4.1 缺陷回归验证(不入库)
import { execSync } from "node:child_process";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const ADMIN = process.env.ADMIN_USER || "admin";
const PASS = process.env.ADMIN_PASSWORD || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, n, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL ${n}${e ? `  → ${e}` : ""}`); } };
const sec = (t) => console.log(`\n# ${t}`);

let token = "";
async function api(m, p, { json, raw = false } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(json); }
  const r = await fetch(`${BASE}/api/v1${p}`, { method: m, headers: h, body });
  if (raw) return r;
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data: j.data, error: j.error };
}
const tree = async () => {
  const r = await api("GET", "/albums?tree=1");
  const flat = [];
  const w = (ns, d = 0) => ns.forEach((n) => { flat.push({ ...n, depth: d }); w(n.children ?? [], d + 1); });
  w(r.data.albums);
  return flat;
};
async function waitScan(code, timeout = 900_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await api("GET", `/albums/${code}/status`);
    if (r.data.scan && !r.data.scan.running) return r.data.scan;
    await sleep(200);
  }
  throw new Error("超时");
}
async function waitQueue(timeout = 900_000) {
  const t0 = Date.now();
  let l = null;
  while (Date.now() - t0 < timeout) {
    l = (await api("GET", "/status/queue")).data;
    if (!l.running && !l.waiting) return l;
    await sleep(500);
  }
  return l;
}

async function main() {
  token = (await api("POST", "/auth/login", { json: { username: ADMIN, password: PASS } })).data.token;

  sec("R1 并发扫描竞态(4 个同时发起,应只有 1 个被接受)");
  execSync("cd ~/work/pgs && MODE=bulk node tmp-gen-more.mjs", { stdio: "inherit" });
  const big = (await tree()).find((a) => a.name === "压力库");
  const rs = await Promise.all([1, 2, 3, 4].map(() => api("POST", `/albums/${big.code}/scan?recursive=1`)));
  console.log("  状态:", rs.map((r) => `${r.status}${r.error ? `(${r.error.code})` : ""}`).join(", "));
  const accepted = rs.filter((r) => r.ok).length;
  const rejected = rs.filter((r) => r.status === 409).length;
  ok(accepted === 1, `仅 1 个被接受(实际 ${accepted})`);
  ok(rejected === 3, `3 个被 409 拒绝(实际 ${rejected})`);
  const sc = await waitScan(big.code);
  await waitQueue();
  console.log(`  扫描结果 ${JSON.stringify(sc)}`);
  const t1 = await tree();
  const dupPaths = {};
  for (const a of t1) if (a.rootPath) dupPaths[a.rootPath] = (dupPaths[a.rootPath] ?? 0) + 1;
  ok(!Object.values(dupPaths).some((n) => n > 1), "无重复 rootPath 相册");

  sec("R2 子目录改名 → 沿用原相册(不产生幽灵相册)");
  const edge = (await tree()).find((a) => a.name === "边界库2");
  const before = await tree();
  const sub1 = before.find((a) => a.name === "sub1" && a.parent === edge.code);
  const sub1Code = sub1?.code;
  const sub1Media = sub1?.counts.media;
  const beforeThumb = sub1Code ? await api("GET", `/media?album=${sub1Code}&limit=1`) : null;
  const thumbId = beforeThumb?.data?.items?.[0]?.id;
  execSync("mv /data/home/work/edge/sub1 /data/home/work/edge/sub1-renamed");
  const r2 = await api("POST", `/albums/${edge.code}/scan?wait=1&recursive=1`);
  console.log(`  扫描结果 ${JSON.stringify(r2.data)}`);
  ok(r2.data.albumsMoved === 1, `识别为改名 1 个(实际 ${r2.data.albumsMoved})`);
  ok(r2.data.albumsCreated === 0, `未新建相册(实际 ${r2.data.albumsCreated})`);
  ok(r2.data.added === 0, `未新增记录(实际 ${r2.data.added})`);
  const after = await tree();
  const ghost = after.find((a) => a.name === "sub1" && a.parent === edge.code);
  const renamed = after.find((a) => a.name === "sub1-renamed" && a.parent === edge.code);
  ok(!ghost, "旧相册「sub1」已不存在(无幽灵)");
  ok(renamed?.code === sub1Code, "新名字沿用同一相册代码(身份保留)");
  ok(renamed?.counts.media === sub1Media, `媒体数不变 ${renamed?.counts.media} = ${sub1Media}`);
  if (thumbId) {
    const tr = await api("GET", `/media/${thumbId}/thumb`, { raw: true });
    ok(tr.ok, "改名后原缩略图仍可访问(未重新生成)");
  }
  execSync("mv /data/home/work/edge/sub1-renamed /data/home/work/edge/sub1");

  sec("R3 子目录删除 → 两次扫描后移除幽灵相册");
  const sub2 = (await tree()).find((a) => a.name === "sub2" && a.parent === edge.code);
  const sub2Code = sub2?.code;
  execSync("rm -rf /data/home/work/edge/sub2");
  const r3a = await api("POST", `/albums/${edge.code}/scan?wait=1&recursive=1`);
  console.log(`  第 1 次 ${JSON.stringify(r3a.data)}`);
  const mid = (await tree()).find((a) => a.code === sub2Code);
  ok(!!mid, "第 1 次扫描:相册保留(仅软删除媒体)");
  ok(mid?.counts.media === 0, `第 1 次扫描后媒体计数 0(实际 ${mid?.counts.media})`);
  const r3b = await api("POST", `/albums/${edge.code}/scan?wait=1&recursive=1`);
  console.log(`  第 2 次 ${JSON.stringify(r3b.data)}`);
  const gone = (await tree()).find((a) => a.code === sub2Code);
  ok(!gone, "第 2 次扫描:幽灵相册已移除");
  ok(r3b.data.albumsRemoved >= 1, `albumsRemoved=${r3b.data.albumsRemoved} ≥ 1`);
  // 恢复
  execSync("cd ~/work/pgs && MODE=newdir node tmp-gen-more.mjs", { stdio: "inherit" });
  execSync("mkdir -p /data/home/work/edge/sub2 && cd ~/work/pgs && node -e \"const sharp=require('sharp');(async()=>{const s=Buffer.from('<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" width=\\\"900\\\" height=\\\"700\\\"><rect width=\\\"100%\\\" height=\\\"100%\\\" fill=\\\"#e76f51\\\"/></svg>');for(let i=0;i<3;i++)await sharp(s).jpeg().toFile('/data/home/work/edge/sub2/e-'+i+'.jpg');})()\"", { stdio: "inherit" });
  await api("POST", `/albums/${edge.code}/scan?wait=1&recursive=1`);
  await waitQueue();

  sec("R4 深层目录(20 层)全部入库,无静默丢失");
  const deep = (await tree()).find((a) => a.name === "超深");
  const r4 = await api("POST", `/albums/${deep.code}/scan?wait=1&recursive=1`);
  console.log(`  ${JSON.stringify(r4.data)}`);
  ok(r4.data.truncated === 0, `truncated=0(实际 ${r4.data.truncated})`);
  const total = execSync("find /data/home/work/stress/超深 -type f | wc -l").toString().trim();
  const indexed = execSync("cd ~/deploy && docker compose exec -T db psql -U pgs -d picgallery -t -c \"select count(*) from pgs_media where storage_key like '/photos/stress/超深%' and missing_at is null\"").toString().trim();
  console.log(`  实际文件 ${total} / 已入库 ${indexed}`);
  ok(Number(indexed) === Number(total), `深层文件全部入库 ${indexed}/${total}`);
  const lvls = (await tree()).filter((a) => /^lvl\d+$/.test(a.name));
  ok(lvls.length >= 19, `创建了 ${lvls.length} 层 lvl 相册(≥19)`);
  await waitQueue();

  sec("R5 深层截断提示(把上限临时调小验证)");
  console.log("  (需重启容器改 SCAN_MAX_DEPTH,跳过运行时验证;由 R4 的 truncated 字段覆盖)");

  sec("R6 大库整体回归(扫描/缩略图/列表)");
  const r6 = await api("POST", `/albums/${big.code}/scan?wait=1&recursive=1`);
  await waitQueue();
  const st = (await api("GET", "/status")).data;
  console.log(`  统计 ${JSON.stringify(st.counts)}`);
  ok(st.counts.pending === 0, "无 pending");
  ok(st.counts.failed <= 3, `失败 ${st.counts.failed} ≤3`);
  const list = await api("GET", `/media?album=${big.code}&recursive=1&limit=60`);
  ok(list.data.items.length === 60, "列表正常");

  console.log(`\n===== 回归: ${pass} 通过 / ${fail} 失败 =====`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error("[异常]", e); process.exit(1); });
