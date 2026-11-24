#!/usr/bin/env node
// 临时脚本:定位改名识别失败原因
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const BASE = "http://127.0.0.1:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token = "";
async function api(m, p, { json } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(json); }
  const r = await fetch(`${BASE}/api/v1${p}`, { method: m, headers: h, body });
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

async function main() {
  token = (await api("POST", "/auth/login", { json: { username: "admin", password: process.env.ADMIN_PASSWORD } })).data.token;
  const edge = (await tree()).find((a) => a.name === "边界库2");
  const sub1 = (await tree()).find((a) => a.name === "sub1" && a.parent === edge.code);
  console.log("edge:", edge?.code, "sub1:", sub1?.code, "media:", sub1?.counts.media);

  const sql = (q) => execSync(`cd ~/deploy && docker compose exec -T db psql -U pgs -d picgallery -t -A -F'|' -c "${q}"`, { encoding: "utf8" }).trim();
  console.log("\nDB 中 sub1 的媒体:");
  console.log(sql(`select filename,size,mtime_ms,missing_at from pgs_media where album_id='${sub1.id}'`));

  const dir = "/data/home/work/edge/sub1";
  const entries = await fs.readdir(dir, { withFileTypes: true });
  console.log("\n磁盘 sub1 内容:");
  for (const e of entries) {
    const st = await fs.stat(path.join(dir, e.name));
    console.log(`  ${e.name} size=${st.size} mtimeMs=${Math.round(st.mtimeMs)}`);
  }

  // 模拟改名
  execSync("mv /data/home/work/edge/sub1 /data/home/work/edge/sub1-x");
  const r = await api("POST", `/albums/${edge.code}/scan?wait=1&recursive=1`);
  console.log("\n扫描结果:", JSON.stringify(r.data));
  const t2 = await tree();
  console.log("改名后相册:", t2.filter((a) => a.parent === edge.code).map((a) => `${a.name}(${a.code},${a.counts.media})`).join(", "));
  execSync("mv /data/home/work/edge/sub1-x /data/home/work/edge/sub1");
  await api("POST", `/albums/${edge.code}/scan?wait=1&recursive=1`);
}
main().catch((e) => { console.error(e); process.exit(1); });
