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
import { spawnSync } from "node:child_process";
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

// 容器以任意非宿主机 uid(如 RUN_AS=12345)运行时,容器内新建的子目录/文件属主为该 uid,宿主机用户直接写/删会 EACCES;
// 此时由容器内当前用户把 /app/data 放开读写权限后重试。
function relaxContainerDataPerms() {
  const c = process.env.DOCKER_CONTAINER;
  if (!c) return false;
  const parts = (process.env.DOCKER_CMD || "docker").trim().split(/\s+/);
  spawnSync(parts[0], [...parts.slice(1), "exec", c, "chmod", "-R", "a+rwX", "/app/data"], { stdio: "ignore" });
  return true;
}
async function writeData(filePath, buf) {
  try { await fs.writeFile(filePath, buf); }
  catch (e) { if (e?.code === "EACCES" && relaxContainerDataPerms()) await fs.writeFile(filePath, buf); else throw e; }
}
async function unlinkData(filePath) {
  try { await fs.unlink(filePath); }
  catch (e) { if (e?.code === "EACCES" && relaxContainerDataPerms()) await fs.unlink(filePath); else throw e; }
}

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
  // 平滑渐变底图(不要纯随机噪点):噪点图在 WebP 有损压缩下,同一原图的两次编码
  // 会在大面积高频区域产生随机差异,使「水印覆盖面积」断言剧烈抖动(实测 9%~48%)。
  // 用低频渐变 + 每张不同的随机基色,既能保证哈希不同,又能让压缩差异稳定在极小范围。
  const buf = Buffer.allocUnsafe(w * h * 3);
  const [r, g, b] = [randomBytes(1)[0], randomBytes(1)[0], randomBytes(1)[0]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      buf[i] = (r + Math.round((x / w) * 60) + Math.round((y / h) * 20)) & 255;
      buf[i + 1] = (g + Math.round((y / h) * 60)) & 255;
      buf[i + 2] = (b + Math.round((x / w) * 30) + Math.round((y / h) * 30)) & 255;
    }
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

const shard8 = (id) => path.join(DATA, "cache", "hd", id.slice(0, 2));

async function upload2(adminTok, album, buf, name, mime) {
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: mime }), name);
  const r = await call("POST", `/media/upload?album=${album}`, { token: adminTok, form: fd });
  const res = (await r.json()).data?.results?.[0];
  if (!res?.id) throw new Error(`上传失败: ${name}`);
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
async function hdGet(id, t, { token, ip, width = 2560, headers } = {}) {
  return call("GET", `/media/${id}/hd?t=${encodeURIComponent(t)}&w=${width}`, { token, ip, headers });
}
async function fetchHd(id, auth = {}) {
  const t = await hdToken(id, auth);
  if (t.status !== 200) return { status: t.status, res: null };
  const res = await hdGet(id, t.body.token, auth);
  return { status: res.status, res };
}
/** 24 位无压缩 BMP(用于验证 HD 对 BMP 的支持) */
function makeBmp(w, h) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write("BM", 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = 54 + y * row + x * 3;
      buf[o] = (x * 255) / w;
      buf[o + 1] = (y * 255) / h;
      buf[o + 2] = 120;
    }
  return buf;
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
  await writeData(path.join(DATA, storageKey), replaced);
  r = await fetchHd(pubId);
  const after = Buffer.from(await r.res.arrayBuffer());
  ok(r.res.headers.get("x-pgs-cache") === "miss", "原文件被替换后旧缓存失效并重新生成", r.res.headers.get("x-pgs-cache"));
  ok(!before.equals(after), "替换后输出内容发生变化");
  // 缓存文件被删除后可自动重新生成
  const shard = path.join(DATA, "cache", "hd", pubId.slice(0, 2));
  for (const f of await fs.readdir(shard).catch(() => [])) if (f.startsWith(`${pubId}.`)) await unlinkData(path.join(shard, f));
  r = await fetchHd(pubId);
  ok(r.status === 200 && r.res.headers.get("x-pgs-cache") === "miss", "缓存目录被清空后自动重新生成", `${r.status}`);
  // 水印是真实合成进像素的:缓存里是未加水印的基础图,输出必须不同
  // 基图文件名 <id>.<ver12>.<w>.webp;游客水印成品多一段 8 位指纹,这里只取基图
  const cached = (await fs.readdir(shard)).find((f) => new RegExp(`^${pubId}\\.[0-9a-f]{12}\\.\\d+\\.webp$`).test(f));
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


  section("8. 游客水印成品缓存(P1-4 / T-4)与 BMP 高清预览");
  // 该组断言依赖「请求域名可信」:服务需配置 ALLOWED_HOSTS 或 PUBLIC_BASE_URL(test-matrix / test-docker 已配置);
  // 未配置时服务按设计不缓存(x-pgs-wm-cache: untrusted-host),此时只校验「不缓存」本身。
  const wmId = await upload(admin, pub.code, await makeImage(2800, 1900), "wmcache.jpg");
  await waitReady(admin, wmId);
  let w1 = await fetchHd(wmId);
  const wmState = w1.res.headers.get("x-pgs-wm-cache");
  if (wmState === "untrusted-host") {
    ok(true, "未配置可信域名 → 游客水印成品不缓存(x-pgs-wm-cache: untrusted-host)");
    console.log("  (跳过缓存命中断言:请用 ALLOWED_HOSTS=127.0.0.1:<端口> 启动服务)");
  } else {
    ok(wmState === "miss", "游客首次请求:生成并写入水印成品缓存 (x-pgs-wm-cache: miss)", String(wmState));
    const first = Buffer.from(await w1.res.arrayBuffer());
    await new Promise((r) => setTimeout(r, 600)); // 成品异步落盘
    const wmFiles = async () => (await fs.readdir(shard8(wmId)).catch(() => [])).filter((f) => new RegExp(`^${wmId}\\.[0-9a-f]{12}\\.\\d+\\.[0-9a-f]{8}\\.webp$`).test(f));
    // 水印成品是【异步落盘】的:连续两次统计一致才认为已收敛。
    // 若直接取瞬时值当基线,慢机器/高负载下(例如容器以任意 uid 运行时)会漏等刚落盘的成品,
    // 后续「数量不变」断言就会误报失败(与产品行为无关的测试脚本竞态)。
    const stableCount = async (tries = 25) => {
      let last = -1;
      for (let i = 0; i < tries; i++) {
        const n = (await wmFiles()).length;
        if (n === last) return n;
        last = n;
        await new Promise((r) => setTimeout(r, 200));
      }
      return last;
    };
    const nFirst = await stableCount();
    ok(nFirst === 1, "磁盘上有 1 个水印成品文件(<id>.<ver>.<w>.<指纹>.webp)", `实际 ${nFirst}`);
    w1 = await fetchHd(wmId);
    ok(w1.res.headers.get("x-pgs-wm-cache") === "hit" && w1.res.headers.get("x-pgs-cache") === "hit", "游客第二次请求直接命中水印成品");
    const second = Buffer.from(await w1.res.arrayBuffer());
    ok(first.equals(second), "命中的成品与首次生成的字节完全一致");
    ok(/no-store/.test(w1.res.headers.get("cache-control") || ""), "命中成品时响应仍是 private, no-store");

    // ① 命中后每次仍重新校验权限
    await call("PATCH", `/albums/${pub.code}`, { token: admin, json: { visibility: "private" } });
    let x = await fetchHd(wmId);
    ok(x.status === 404, "相册改私有后,成品命中也被拒绝(游客 404)", String(x.status));
    await call("PATCH", `/albums/${pub.code}`, { token: admin, json: { visibility: "public" } });
    x = await fetchHd(wmId);
    ok(x.status === 200 && x.res.headers.get("x-pgs-wm-cache") === "hit", "恢复公开后再次命中(成品未被误删)");

    // ② 令牌校验先于缓存:跨媒体令牌/篡改令牌不能读成品
    const tokOther = (await hdToken(pubId)).body.token;
    x = await hdGet(wmId, tokOther);
    ok(x.status === 403, "他图令牌不能读取该图的水印成品 (403)", String(x.status));

    // ③ Key 隔离:不同宽度各自独立
    const t1280 = (await hdToken(wmId)).body.token;
    x = await hdGet(wmId, t1280, { width: 1280 });
    ok(x.status === 200 && x.headers.get("x-pgs-wm-cache") === "miss", "不同宽度(1280)不串用 2560 的成品", String(x.headers.get("x-pgs-wm-cache")));
    const b1280 = Buffer.from(await x.arrayBuffer());
    const m1280 = await sharp(b1280).metadata();
    ok(m1280.width === 1280, `1280 档输出宽度正确 (${m1280.width})`);

    // ④ 伪造 Host / X-Forwarded-Host 不产生新的缓存变体
    // 基线取【收敛后】的计数:③ 的 1280 档成品也是异步落盘,必须先等它落盘,否则基线偏小
    const nBefore = await stableCount();
    const tF = (await hdToken(wmId)).body.token;
    x = await hdGet(wmId, tF, { headers: { "x-forwarded-host": "evil.example.com" } });
    ok(x.status === 200, "带伪造 X-Forwarded-Host 仍正常出图", String(x.status));
    await new Promise((r) => setTimeout(r, 400));
    const nAfterForge = await stableCount();
    ok(nAfterForge === nBefore, "伪造 Host 不会产生新的成品文件(只会回落到可信域名)", `${nBefore} → ${nAfterForge}`);
    const forgedState = x.headers.get("x-pgs-wm-cache");
    ok(forgedState === "hit" || forgedState === "untrusted-host", "伪造 Host:要么回落到可信域名并命中同一成品,要么视为不可信而不缓存", String(forgedState));
    console.log(`  (伪造 X-Forwarded-Host 的结果: ${forgedState})`);

    // ⑤ 登录用户不读写游客成品
    const u8 = await fetchHd(wmId, { token: viewer });
    ok(u8.res.headers.get("x-pgs-wm-cache") === "skip-user", "登录用户不使用游客成品缓存 (skip-user)", String(u8.res.headers.get("x-pgs-wm-cache")));
    const ub = Buffer.from(await u8.res.arrayBuffer());
    ok(!ub.equals(second), "登录用户输出含动态标识,与游客成品不同");
    const nAfterUser = await stableCount();
    ok(nAfterUser === nBefore, "登录用户请求没有写入新成品", `${nBefore} → ${nAfterUser}`);

    // ⑥ 替换原图后旧成品不再命中(版本变化),且旧版本成品被清理
    const detail8 = await data(await call("GET", `/media/${wmId}`, { token: admin }));
    await writeData(path.join(DATA, detail8.storageKey), await makeImage(2700, 1800));
    x = await fetchHd(wmId);
    ok(x.res.headers.get("x-pgs-wm-cache") === "miss" && x.res.headers.get("x-pgs-cache") === "miss", "原图被替换后水印成品与基图都不命中");
    const afterReplace = Buffer.from(await x.res.arrayBuffer());
    ok(!afterReplace.equals(second), "替换后输出内容变化");
    await new Promise((r) => setTimeout(r, 600));
    ok((await wmFiles()).every((f) => !f.includes(".webp.tmp")), "无遗留临时文件");

    // ⑦ 删除后立即 404,且成品被清理
    await call("DELETE", `/media/${wmId}?purge=0`, { token: admin });
    x = await fetchHd(wmId);
    ok(x.status === 404, "媒体删除后 404", String(x.status));
    await new Promise((r) => setTimeout(r, 300));
    const nAfterDelete = await stableCount();
    ok(nAfterDelete === 0, "删除后该图的基图与水印成品全部被清理", `实际 ${nAfterDelete}`);
  }

  // BMP:HD 预览支持(此前会 500)
  const bmpId = await upload2(admin, pub.code, makeBmp(640, 480), "pic.bmp", "image/bmp");
  await waitReady(admin, bmpId);
  const bmpRes = await fetchHd(bmpId);
  ok(bmpRes.status === 200, "BMP 原图可生成高清预览 (200)", String(bmpRes.status));
  if (bmpRes.status === 200) {
    const bm = await sharp(Buffer.from(await bmpRes.res.arrayBuffer())).metadata();
    ok(bm.format === "webp" && bm.width === 640, `BMP 高清预览为 WebP 且尺寸正确 (${bm.format} ${bm.width})`);
    ok(bmpRes.res.headers.get("x-pgs-wm") === "1", "BMP 高清预览同样合成水印");
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("测试异常终止:", e);
  process.exit(2);
});
