#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 高清预览(HD)集成测试 —— 对一个【正在运行】的服务做黑盒验证。
 *
 * 用法(建议用独立数据目录与较小的异常检测阈值启动测试服务):
 *   DATA_DIR=/tmp/pgs-test HD_SCAN_DISTINCT=9 ADMIN_PASSWORD=test-pass-123 SESSION_SECRET=test-secret PORT=3100 npm start &
 *   BASE=http://127.0.0.1:3100 DATA_DIR=/tmp/pgs-test ADMIN_PASSWORD=test-pass-123 SESSION_SECRET=test-secret HD_SCAN_DISTINCT=9 node scripts/test-hd.mjs
 *
 * 覆盖: 游客/登录用户/管理员 × 公开/私有相册、跨媒体令牌、过期令牌、令牌用户绑定、缺失令牌、
 *       响应头(no-store)、元数据剥离、真实水印、缓存命中/失效(替换原文件/删除)、并发合并、
 *       限流 429(IP 维度,且不影响普通缩略图)、异常批量访问封禁与安全日志、S3 临时文件清理(代码路径见 src/server/hd/service.ts 的 materialize())。
 */
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const BASE = process.env.BASE || "http://127.0.0.1:3100";
const ADMIN = process.env.ADMIN_USER || "admin";
const PASS = process.env.ADMIN_PASSWORD || "test-pass-123";
const SECRET = process.env.SESSION_SECRET || "test-secret";
const DATA = path.resolve(process.env.DATA_DIR || "./data");
const SCAN = Number(process.env.HD_SCAN_DISTINCT || 150);

let passed = 0;
let failed = 0;
const ok = (cond, name, extra = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${name}${!cond && extra ? `  → ${extra}` : ""}`);
};
const section = (t) => console.log(`\n# ${t}`);

let ipSeq = 10;
const newIp = () => `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

async function call(method, p, { token, ip, json, form, headers = {} } = {}) {
  const h = { "x-forwarded-for": ip || newIp(), ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    h["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) body = form;
  return fetch(`${BASE}/api/v1${p}`, { method, headers: h, body });
}
const data = async (res) => (await res.json()).data;

async function login(username, password) {
  const r = await call("POST", "/auth/login", { json: { username, password } });
  if (!r.ok) throw new Error(`登录失败 ${username}: ${r.status}`);
  return (await data(r)).token;
}

async function makeImage(w, h, { exif = false } = {}) {
  const buf = randomBytes(w * h * 3);
  // 平滑一点的渐变 + 随机色,保证每张哈希不同
  const [r, g, b] = [randomBytes(1)[0], randomBytes(1)[0], randomBytes(1)[0]];
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = (r + (i / 3) % w / 8 + (buf[i] & 7)) & 255;
    buf[i + 1] = (g + Math.floor(i / 3 / w) / 8 + (buf[i + 1] & 7)) & 255;
    buf[i + 2] = (b + (buf[i + 2] & 7)) & 255;
  }
  let img = sharp(buf, { raw: { width: w, height: h, channels: 3 } });
  if (exif) img = img.withExif({ IFD0: { Copyright: "SECRET-COPYRIGHT-XYZ", Artist: "tester" } });
  return img.jpeg({ quality: 90 }).toBuffer();
}

async function upload(adminTok, album, buf, name) {
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "image/jpeg" }), name);
  const r = await call("POST", `/media/upload?album=${album}`, { token: adminTok, form: fd });
  const j = await r.json();
  const res = j.data?.results?.[0];
  if (!res?.id) throw new Error(`上传失败: ${JSON.stringify(j)}`);
  return res.id;
}

async function waitReady(adminTok, id) {
  for (let i = 0; i < 60; i++) {
    const d = await data(await call("GET", `/media/${id}`, { token: adminTok }));
    if (d.status === "ready") return d;
    if (d.status === "failed") throw new Error(`处理失败: ${d.error}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("等待处理超时");
}

const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
};

async function hdToken(id, { token, ip } = {}) {
  const r = await call("GET", `/media/${id}/hd-token?w=2560`, { token, ip });
  return { status: r.status, body: r.ok ? await data(r) : null };
}
async function hdGet(id, t, { token, ip } = {}) {
  return call("GET", `/media/${id}/hd?t=${encodeURIComponent(t)}&w=2560`, { token, ip });
}
async function fetchHd(id, auth = {}) {
  const t = await hdToken(id, auth);
  if (t.status !== 200) return { status: t.status, res: null };
  const res = await hdGet(id, t.body.token, auth);
  return { status: res.status, res };
}

const stamp = Date.now().toString(36);

async function main() {
  const admin = await login(ADMIN, PASS);

  section("准备数据:公开/私有相册、查看者账号、图片");
  const pub = await data(await call("POST", "/albums", { token: admin, json: { name: `hd-pub-${stamp}`, visibility: "public" } }));
  const priv = await data(await call("POST", "/albums", { token: admin, json: { name: `hd-priv-${stamp}`, visibility: "private" } }));
  const viewerName = `viewer_${stamp}`;
  await call("POST", "/users", { token: admin, json: { username: viewerName, password: "viewer-pass-123", role: "viewer" } });
  const viewer = await login(viewerName, "viewer-pass-123");

  const bigJpeg = await makeImage(3000, 2000, { exif: true });
  const pubId = await upload(admin, pub.code, bigJpeg, "big.jpg");
  const pub2Id = await upload(admin, pub.code, await makeImage(400, 300), "small.jpg");
  const privId = await upload(admin, priv.code, await makeImage(500, 400), "private.jpg");
  const pubDetail = await waitReady(admin, pubId);
  await waitReady(admin, pub2Id);
  await waitReady(admin, privId);
  ok(true, `已上传 3 张图片 (公开 ${pubId}, ${pub2Id}; 私有 ${privId})`);

  section("1. 游客 / 登录用户 / 管理员 访问权限");
  let r = await fetchHd(pubId);
  ok(r.status === 200, "游客可取得公开相册的高清图", String(r.status));
  const bytes = Buffer.from(await r.res.arrayBuffer());
  const meta = await sharp(bytes).metadata();
  ok(r.res.headers.get("content-type") === "image/webp", "输出为 WebP");
  ok(meta.width <= 2560 && meta.width >= 2000, `宽度不超过 2560 (实际 ${meta.width})`);
  ok(!meta.exif && !meta.xmp && !meta.iptc, "高清图不含 EXIF/XMP/IPTC 元数据");
  ok(!bytes.includes(Buffer.from("SECRET-COPYRIGHT-XYZ")), "原图版权字符串没有泄露到高清图中");
  const cc = r.res.headers.get("cache-control") || "";
  ok(/private/.test(cc) && /no-store/.test(cc), "Cache-Control: private, no-store", cc);
  ok(r.res.headers.get("x-pgs-wm") === "1", "响应声明已合成水印");
  ok(!JSON.stringify([...r.res.headers]).includes(DATA), "响应头不暴露服务器存储路径");

  r = await fetchHd(privId);
  ok(r.status === 404, "游客无法取得私有相册的高清图 (404)", String(r.status));
  r = await fetchHd(privId, { token: viewer });
  ok(r.status === 200, "登录用户可取得私有相册的高清图", String(r.status));
  r = await fetchHd(privId, { token: admin });
  ok(r.status === 200, "管理员可取得私有相册的高清图", String(r.status));
  r = await hdGet(privId, "", {});
  ok(r.status === 403 || r.status === 404, "不带令牌访问 → 拒绝", String(r.status));

  section("2. 令牌:跨媒体 / 过期 / 范围 / 用户绑定");
  const tA = (await hdToken(pubId)).body.token;
  r = await hdGet(pub2Id, tA);
  ok(r.status === 403, "A 图令牌不能用于 B 图 (跨媒体)", String(r.status));
  const now = Math.floor(Date.now() / 1000);
  r = await hdGet(pubId, sign({ m: pubId, s: "hd", u: null, w: 2560, exp: now - 5 }));
  ok(r.status === 403, "过期令牌被拒绝", String(r.status));
  r = await hdGet(pubId, sign({ m: pubId, s: "stream", u: null, exp: now + 60 }));
  ok(r.status === 403, "范围不对的令牌被拒绝", String(r.status));
  r = await hdGet(pubId, sign({ m: pubId, exp: now + 60 }));
  ok(r.status === 403, "视频播放令牌(无 scope)不能用于高清预览", String(r.status));
  r = await hdGet(pubId, tA.slice(0, -3) + "xyz");
  ok(r.status === 403, "签名被篡改的令牌被拒绝", String(r.status));
  const vTok = (await hdToken(privId, { token: viewer })).body.token;
  r = await hdGet(privId, vTok, {});
  ok(r.status === 403 || r.status === 404, "登录用户的令牌被游客盗用 → 拒绝", String(r.status));
  const tl = (await hdToken(pubId)).body;
  ok(tl.expiresIn === 90, "令牌有效期默认 90 秒", String(tl.expiresIn));
  // 令牌不能当作视频播放/原图凭证
  r = await call("GET", `/media/${pubId}/file?key=${encodeURIComponent(tA)}`, {});
  ok(r.headers.get("content-type") === "image/webp" || r.status >= 400, "HD 令牌不能当作原图下载密钥(返回的仍是普通预览图)");

  section("3. 缓存:命中 / 失效(替换原文件、删除)");
  r = await fetchHd(pubId);
  ok(r.res.headers.get("x-pgs-cache") === "hit", "第二次访问命中缓存", r.res.headers.get("x-pgs-cache"));
  // 缓存命中仍需重新验证权限:把相册改私有后,游客立即 404
  await call("PATCH", `/albums/${pub.code}`, { token: admin, json: { visibility: "private" } });
  r = await fetchHd(pubId);
  ok(r.status === 404, "相册改为私有后,缓存命中也会拒绝游客 (404)", String(r.status));
  await call("PATCH", `/albums/${pub.code}`, { token: admin, json: { visibility: "public" } });
  // 缓存目录不是静态资源
  const sp = await fetch(`${BASE}/data/cache/hd/${pubId.slice(0, 2)}/${pubId}.webp`);
  ok(sp.status === 404, "缓存目录无法通过静态 URL 访问", String(sp.status));
  // 替换原文件
  const storageKey = pubDetail.storageKey;
  ok(!!storageKey, "管理员可读到 storageKey(测试用)");
  const before = Buffer.from(await (await fetchHd(pubId)).res.arrayBuffer());
  const replaced = await makeImage(2600, 1500);
  await fs.writeFile(path.join(DATA, storageKey), replaced);
  r = await fetchHd(pubId);
  const after = Buffer.from(await r.res.arrayBuffer());
  ok(r.res.headers.get("x-pgs-cache") === "miss", "原文件被替换后旧缓存失效并重新生成", r.res.headers.get("x-pgs-cache"));
  ok(!before.equals(after), "替换后输出内容发生变化");
  // 缓存文件被删除后可自动重新生成
  const shard = path.join(DATA, "cache", "hd", pubId.slice(0, 2));
  for (const f of await fs.readdir(shard).catch(() => [])) if (f.startsWith(`${pubId}.`)) await fs.unlink(path.join(shard, f));
  r = await fetchHd(pubId);
  ok(r.status === 200 && r.res.headers.get("x-pgs-cache") === "miss", "缓存目录被清空后自动重新生成", `${r.status}`);
  // 水印是真实合成进像素的:缓存里是未加水印的基础图,输出必须不同
  const cached = (await fs.readdir(shard)).find((f) => f.startsWith(`${pubId}.`) && f.endsWith(".webp"));
  const base = await sharp(await fs.readFile(path.join(shard, cached))).raw().toBuffer({ resolveWithObject: true });
  const out = await sharp(Buffer.from(await (await fetchHd(pubId)).res.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
  let diff = 0;
  for (let i = 0; i < base.data.length; i += 3 * 7) if (Math.abs(base.data[i] - out.data[i]) > 2 || Math.abs(base.data[i + 1] - out.data[i + 1]) > 2) diff++;
  const sampled = base.data.length / (3 * 7);
  ok(base.info.width === out.info.width && diff / sampled > 0.002, `水印已合成进像素 (采样差异 ${((diff / sampled) * 100).toFixed(2)}%)`);
  ok(diff / sampled < 0.35, "水印覆盖面积适中,不影响观感");
  // 登录用户的动态标识水印与游客不同
  const guestImg = Buffer.from(await (await fetchHd(pubId)).res.arrayBuffer());
  const userImg = Buffer.from(await (await fetchHd(pubId, { token: viewer })).res.arrayBuffer());
  ok(!guestImg.equals(userImg), "登录用户的高清图含动态标识水印(与游客版本不同)");
  // 删除
  await call("DELETE", `/media/${pub2Id}?purge=0`, { token: admin });
  r = await fetchHd(pub2Id);
  ok(r.status === 404, "媒体删除后高清预览 404", String(r.status));

  section("4. 并发转换合并");
  const cId = await upload(admin, pub.code, await makeImage(3200, 2200), "concurrent.jpg");
  await waitReady(admin, cId);
  // /status 有 5 秒缓存(issue §6.3),前后两次读取可能命中同一快照而算出 0 差值。
  // 这里先等缓存过期取基线,再在并发结束后等缓存过期取结果。
  const hdStats = async () => {
    await new Promise((r) => setTimeout(r, 5200));
    return (await data(await call("GET", "/status", { token: admin }))).hd;
  };
  const s0 = await hdStats();
  const toks = await Promise.all(Array.from({ length: 8 }, () => hdToken(cId)));
  const rs = await Promise.all(toks.map((t) => hdGet(cId, t.body.token)));
  ok(rs.every((x) => x.status === 200), "8 个并发请求全部成功", rs.map((x) => x.status).join(","));
  const s1 = await hdStats();
  ok(s1.conversions - s0.conversions === 1, `8 个并发请求只执行 1 次转换 (实际 ${s1.conversions - s0.conversions})`);
  ok(s1.coalesced - s0.coalesced >= 1, `并发请求被合并 (${s1.coalesced - s0.coalesced} 个)`);

  section("5. 限流 (每 IP 每分钟 30 次) 与独立性");
  const ip = newIp();
  const t0 = (await hdToken(pubId, { ip })).body.token;
  let last = 0;
  let firstBlock = -1;
  let retryAfter = null;
  for (let i = 1; i <= 34; i++) {
    const x = await hdGet(pubId, t0, { ip });
    last = x.status;
    if (x.status === 429 && firstBlock < 0) {
      firstBlock = i;
      retryAfter = x.headers.get("retry-after");
    }
  }
  ok(firstBlock > 0 && firstBlock <= 31, `同一 IP 第 ${firstBlock} 次起返回 429`, String(last));
  ok(!!retryAfter, "429 带 Retry-After", String(retryAfter));
  const thumb = await call("GET", `/media/${pubId}/thumb`, { ip });
  ok(thumb.status === 200, "被限流的 IP 仍可正常浏览缩略图(限流相互独立)", String(thumb.status));
  const other = await fetchHd(pubId, { ip: newIp() });
  ok(other.status === 200, "其他 IP 不受影响", String(other.status));

  section("6. 异常批量访问检测与安全日志");
  if (SCAN <= 20) {
    const ids = [];
    for (let i = 0; i < SCAN + 2; i++) ids.push(await upload(admin, pub.code, await makeImage(64 + i, 48), `scan-${i}.jpg`));
    await Promise.all(ids.map((id) => waitReady(admin, id)));
    const sip = newIp();
    let blocked = 0;
    for (const id of ids) {
      const t = await hdToken(id, { ip: sip });
      if (t.status === 429) blocked++;
    }
    ok(blocked >= 1, `遍历 ${SCAN + 2} 张不同图片后被封禁 (${blocked} 次 429)`);
    const still = await hdToken(pubId, { ip: sip });
    ok(still.status === 429, "被封禁的 IP 在冷却期内继续 429", String(still.status));
  } else console.log(`  (跳过:请以 HD_SCAN_DISTINCT<=20 启动服务,当前 ${SCAN})`);
  const ev = await data(await call("GET", "/security/events?limit=300", { token: admin }));
  const kinds = new Set(ev.events.map((e) => e.event));
  ok(kinds.has("hd_rate_limited"), "安全日志包含 hd_rate_limited");
  ok(kinds.has("hd_denied"), "安全日志包含 hd_denied (无效令牌/越权)");
  if (SCAN <= 20) ok(kinds.has("hd_scan_detected"), "安全日志包含 hd_scan_detected");
  const g = await call("GET", "/security/events", {});
  ok(g.status === 401, "游客不能读取安全日志", String(g.status));
  const logFile = await fs.readFile(path.join(DATA, "logs", "security.log"), "utf8").catch(() => "");
  ok(logFile.includes("hd_rate_limited"), "安全日志已落盘 (DATA_DIR/logs/security.log)");

  section("7. 原图下载体系不受影响");
  const f1 = await fetch(`${BASE}/f/${pubId}`, { headers: { "x-forwarded-for": newIp() } });
  ok(f1.headers.get("content-type") === "image/webp", "无密钥的 /f/:id 仍只返回预览图 (webp)");
  const f2 = await fetch(`${BASE}/f/${pubId}?dl=1`, { headers: { authorization: `Bearer ${admin}`, "x-forwarded-for": newIp() } });
  ok(f2.headers.get("content-type") === "image/jpeg", "管理员(original 权限)仍可取得原图 (jpeg)", f2.headers.get("content-type"));
  const th = await call("GET", `/media/${pubId}/preview`, {});
  ok(th.status === 200, "preview 接口兼容");

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("测试异常终止:", e);
  process.exit(2);
});
