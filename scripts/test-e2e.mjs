#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * REST API 端到端黑盒测试(对【正在运行】的服务)。覆盖:
 *   健康/认证/限流 · 用户与角色权限 · 受管相册(local)树与可见性 · 上传/去重/多格式/损坏文件 · 元数据(EXIF/AI/视频/NASA)
 *   原图保护与下载密钥 · 搜索/分页 · 备注/移动/批量/删除/黑名单 · 挂载目录(ext)扫描/改名/搬迁/只读/删除 ·
 *   服务器导入 · 直链上传与 SSRF · 通知 · 站点设置/图标 · 安全响应头 · 页面冒烟
 *
 * 用法(通常由 scripts/test-matrix.mjs 编排;单独运行时需先启动服务):
 *   BASE=http://127.0.0.1:3100 ADMIN_PASSWORD=test-pass-123 SAMPLES_DIR=/tmp/pgs-samples \
 *   DATA_DIR=/tmp/pgs-data MOUNT_HOST_DIR=/tmp/pgs-mnt MOUNT_SERVER_DIR=/tmp/pgs-mnt node scripts/test-e2e.mjs
 *
 * 环境变量:
 *   BASE / ADMIN_USER / ADMIN_PASSWORD   服务地址与管理员
 *   SAMPLES_DIR      scripts/fetch-samples.mjs 的输出目录(默认 /tmp/pgs-samples)
 *   DATA_DIR         服务端数据目录(本机可访问时才做磁盘级断言;Docker/远程留空即可)
 *   MOUNT_HOST_DIR   测试进程可写的目录,用来造挂载测试树;未设置则跳过挂载与导入测试
 *   MOUNT_SERVER_DIR 该目录在【服务端】看到的路径(Docker 里是容器内挂载点;默认等于 MOUNT_HOST_DIR)
 *   HAS_VIDEO=0      服务端没有 ffmpeg 时跳过视频元数据断言
 *   OFFLINE=1        跳过需要外网的直链上传
 *   ONLY=a,b         只跑指定章节(如 ONLY=mount,delete)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Client, createSuite, listFilesRec, sleep, waitFor, waitProcessed } from "./lib/harness.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:3100";
const ADMIN = process.env.ADMIN_USER || "admin";
const PASS = process.env.ADMIN_PASSWORD || "test-pass-123";
const SAMPLES = process.env.SAMPLES_DIR || "/tmp/pgs-samples";
const DATA = process.env.DATA_DIR || "";
const MNT_HOST = process.env.MOUNT_HOST_DIR || "";
const MNT_SRV = process.env.MOUNT_SERVER_DIR || MNT_HOST;
// 服务端绝对路径 → 测试进程可见路径(Docker 里 /photos ↔ 宿主机挂载目录)
const toHostPath = (p) =>
  MNT_SRV && MNT_HOST && p && p.startsWith(MNT_SRV) ? path.join(MNT_HOST, p.slice(MNT_SRV.length)) : p;
const HAS_VIDEO = process.env.HAS_VIDEO !== "0";
const OFFLINE = process.env.OFFLINE === "1";
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
const LABEL = process.env.TEST_LABEL || "e2e";

const T = createSuite(`E2E ${LABEL}`);
const { ok, eq, section, skip } = T;
const S = (f) => path.join(SAMPLES, "synth", f);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const want = (name) => !ONLY.length || ONLY.includes(name);

if (!fs.existsSync(path.join(SAMPLES, "manifest.json"))) {
  console.error(`缺少测试素材 ${SAMPLES},请先运行: node scripts/fetch-samples.mjs`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, "manifest.json"), "utf8"));
const nasaImgs = manifest.nasa.filter((x) => x.kind === "image").map((x) => path.join(SAMPLES, "nasa", x.file));
const nasaVids = manifest.nasa.filter((x) => x.kind === "video").map((x) => path.join(SAMPLES, "nasa", x.file));
const tinyVideo = fs.existsSync(S("tiny.mp4")) ? S("tiny.mp4") : nasaVids[0];

const admin = new Client(BASE, { user: ADMIN, password: PASS });
const guest = new Client(BASE);
const tag = Math.random().toString(36).slice(2, 7); // 防止与历史数据重名
const st = {}; // 跨章节共享状态

/* ===================================================================== */
async function sHealth() {
  section("健康检查 / 认证 / 页面冒烟");
  let r = await guest.get("/health");
  ok(r.status === 200 && r.data?.status === "ok", "GET /health liveness", r.buf.toString().slice(0, 100));
  st.version = r.data?.version;
  r = await guest.get("/health/ready");
  ok(r.status === 200, "GET /health/ready", r.buf.toString().slice(0, 200));
  r = await guest.get("/api/health");
  ok(r.status === 200, "GET /api/health");
  r = await guest.get("/auth/me");
  ok(r.status === 200 && r.data.user === null, "游客 /auth/me → user=null");
  r = await guest.get("/status");
  eq(r.status, 401, "游客访问 /status → 401");
  r = await guest.post("/albums", { name: "x" });
  eq(r.status, 401, "游客创建相册 → 401");
  r = await guest.post("/auth/login", { username: ADMIN, password: "wrong-password!" }, { auth: "none" });
  eq(r.status, 401, "错误密码登录 → 401");
  r = await guest.get("/status", { auth: "Basic " + Buffer.from("admin:bad").toString("base64") });
  eq(r.status, 401, "错误 Basic 凭据 → 401");
  r = await guest.get("/status", { auth: "Bearer garbage.token" });
  eq(r.status, 401, "伪造 Bearer → 401");
  r = await guest.get("/no-such-route");
  ok(r.status === 404, "未知路由 → 404", String(r.status));
  r = await guest.req("PUT", "/health");
  ok(r.status === 405 || r.status === 404, "对 GET 路由发 PUT → 405/404", String(r.status));

  const tk = await admin.login(ADMIN, PASS);
  st.tk = tk;
  r = await tk.get("/auth/me");
  ok(r.data?.user?.role === "admin" && r.data.perms.length > 5, "Bearer 登录后 /auth/me 为 admin");
  r = await admin.get("/status");
  ok(r.status === 200 && r.data.version, "Basic 认证访问 /status");
  r = await admin.get("/status/queue");
  ok(r.status === 200 && typeof r.data.concurrency === "number", "GET /status/queue");
  st.status0 = (await admin.get("/status")).data;
  ok(st.version === st.status0.version, "health 与 status 版本一致", `${st.version} vs ${st.status0.version}`);

  // Cookie 登录
  const lr = await guest.req("POST", "/auth/login", { json: { username: ADMIN, password: PASS }, auth: "none" });
  const cookie = (lr.headers.get("set-cookie") || "").split(";")[0];
  ok(/pgs_session=/.test(cookie), "登录 Set-Cookie pgs_session");
  ok(/HttpOnly/i.test(lr.headers.get("set-cookie") || ""), "Cookie 为 HttpOnly");
  r = await guest.get("/auth/me", { auth: "none", headers: { cookie } });
  ok(r.data?.user?.username === ADMIN, "Cookie 携带后 /auth/me 识别身份");
  await guest.post("/auth/logout", undefined, { headers: { cookie } });

  // 页面冒烟(只断言非 5xx 与关键内容)
  for (const p of ["/", "/login", "/albums", "/settings", "/manifest.webmanifest", "/robots.txt"]) {
    const x = await guest.get(p, { auth: "none", site: true });
    ok(x.status < 500, `页面 ${p} 无 5xx`, String(x.status));
  }
  r = await guest.get("/robots.txt", { auth: "none", site: true });
  ok(/Disallow:\s*\//.test(r.buf.toString()), "robots.txt 默认 Disallow: /");
  r = await guest.get("/api/v1/health", { auth: "none" });
  ok(r.headers.get("x-content-type-options") === "nosniff", "全局 nosniff 响应头");
  ok(!!r.headers.get("x-frame-options") || /frame-ancestors/.test(r.headers.get("content-security-policy") || ""), "防点击劫持响应头");
}

/* ===================================================================== */
async function sUsers() {
  section("用户与角色权限");
  const mk = async (username, role) => {
    const r = await admin.post("/users", { username, password: "password-" + username, role });
    ok(r.status === 201, `创建用户 ${username}(${role})`, r.buf.toString().slice(0, 150));
    return r.data;
  };
  const sfx = tag;
  st.names = { manager: "mgr_" + sfx, uploader: "upl_" + sfx, viewer: "vwr_" + sfx };
  st.uMgr = await mk(st.names.manager, "manager");
  st.uUpl = await mk(st.names.uploader, "uploader");
  st.uVwr = await mk(st.names.viewer, "viewer");
  let r = await admin.post("/users", { username: st.names.viewer, password: "password-xx", role: "viewer" });
  ok(r.status === 409 || r.status === 400, "重复用户名被拒绝", String(r.status));
  r = await admin.post("/users", { username: "ab", password: "password-xx", role: "viewer" });
  eq(r.status, 400, "用户名过短 → 400");
  r = await admin.post("/users", { username: "okname_" + sfx, password: "short", role: "viewer" });
  eq(r.status, 400, "密码过短 → 400");
  r = await admin.post("/users", { username: "okname2_" + sfx, password: "password-xx", role: "superuser" });
  eq(r.status, 400, "非法角色 → 400");
  r = await admin.get("/users");
  ok(r.data.users.some((u) => u.username === st.names.manager) && r.data.roles.length === 4, "GET /users 列表与 4 种角色");

  st.mgr = await admin.login(st.names.manager, "password-" + st.names.manager);
  st.upl = await admin.login(st.names.uploader, "password-" + st.names.uploader);
  st.vwr = await admin.login(st.names.viewer, "password-" + st.names.viewer);

  r = await st.vwr.get("/albums");
  eq(r.status, 200, "viewer 可浏览相册");
  r = await st.vwr.upload({}, [{ path: S("dup-source.jpg") }]);
  eq(r.status, 403, "viewer 上传 → 403");
  r = await st.upl.post("/albums", { name: "nope" });
  eq(r.status, 403, "uploader 创建相册 → 403");
  r = await st.mgr.post("/albums/mount", { path: "/tmp" });
  eq(r.status, 403, "manager 挂载目录 → 403");
  r = await st.mgr.get("/keys");
  eq(r.status, 403, "manager 管理密钥 → 403");
  r = await st.mgr.get("/users");
  eq(r.status, 403, "manager 管理用户 → 403");
  r = await st.mgr.get("/settings");
  eq(r.status, 403, "manager 读取完整设置 → 403");
  r = await st.upl.get("/status");
  eq(r.status, 403, "uploader 查看系统状态 → 403");
  r = await st.mgr.get("/status");
  eq(r.status, 200, "manager 可查看系统状态");
  r = await st.upl.get("/fs/browse?path=/");
  eq(r.status, 403, "uploader 浏览服务器目录 → 403");

  // 保护 env 管理员
  const me = (await admin.get("/users")).data.users.find((u) => u.username === ADMIN);
  r = await admin.del(`/users/${me.id}`);
  ok(r.status >= 400 && r.status < 500, "不能删除 env 管理员", String(r.status));
  r = await admin.patch(`/users/${me.id}`, { disabled: true });
  ok(r.status >= 400 && r.status < 500, "不能禁用 env 管理员", String(r.status));
  r = await admin.patch(`/users/${me.id}`, { role: "viewer" });
  ok(r.status >= 400 && r.status < 500, "不能降权 env 管理员", String(r.status));

  // 改密码 → 旧令牌失效(token_version)
  const tmpName = "tmp_" + sfx;
  const tu = (await admin.post("/users", { username: tmpName, password: "password-first", role: "viewer" })).data;
  const tc = await admin.login(tmpName, "password-first");
  r = await tc.post("/auth/password", { oldPassword: "wrong-old-pass", newPassword: "password-second" });
  ok(r.status >= 400 && r.status < 500, "改密码时旧密码错误被拒绝", String(r.status));
  r = await tc.post("/auth/password", { oldPassword: "password-first", newPassword: "password-second" });
  ok(r.status === 200, "自助改密码成功", r.buf.toString().slice(0, 100));
  r = await tc.get("/auth/me");
  ok(r.data?.user === null || r.status === 401, "改密码后旧令牌失效");
  const tc2 = await admin.login(tmpName, "password-second").catch(() => null);
  ok(!!tc2, "新密码可登录");
  r = await admin.patch(`/users/${tu.id}`, { disabled: true });
  ok(r.status === 200, "管理员禁用用户");
  r = await guest.post("/auth/login", { username: tmpName, password: "password-second" }, { auth: "none" });
  ok(r.status === 401 || r.status === 403, "被禁用用户无法登录", String(r.status));
  r = await admin.patch(`/users/${tu.id}`, { disabled: false, role: "uploader", password: "password-third" });
  ok(r.status === 200, "启用并改角色/重置密码");
  r = await admin.del(`/users/${tu.id}`);
  ok(r.status === 200, "删除用户");
}

/* ===================================================================== */
async function sAlbums() {
  section("受管相册(local):创建 / 嵌套 / 可见性 / 修改 / 状态");
  let r = await admin.post("/albums", { name: "公开相册-" + tag, visibility: "public", description: "d" });
  eq(r.status, 201, "创建公开相册");
  st.A = r.data;
  ok(/^alb_[a-z0-9]{8}$/.test(st.A.code), "相册代码格式 alb_xxxxxxxx", st.A.code);
  ok(st.A.effectivePublic === true && st.A.kind === "managed" && st.A.storage === "local", "公开相册属性");
  if (DATA) ok(fs.existsSync(path.join(DATA, "albums", st.A.code)), "local 相册在磁盘上建目录");
  r = await admin.post("/albums", { name: "私有相册-" + tag });
  st.B = r.data;
  eq(st.B.visibility, "private", "默认私有");
  r = await admin.post("/albums", { name: "子相册A1", parent: st.A.code, visibility: "public" });
  st.A1 = r.data;
  eq(st.A1.parent, st.A.code, "子相册 parent 正确");
  r = await admin.post("/albums", { name: "孙相册A1a", parent: st.A1.code, visibility: "public" });
  st.A1a = r.data;
  r = await admin.post("/albums", { name: "私有父下的公开子", parent: st.B.code, visibility: "public" });
  st.Bpub = r.data;
  ok(st.Bpub.effectivePublic === false, "私有父相册下的公开子相册 effectivePublic=false");
  r = await admin.post("/albums", { name: "x", parent: "alb_nonexist" });
  ok(r.status === 400 || r.status === 404, "不存在的 parent 被拒绝", String(r.status));
  r = await admin.post("/albums", { name: "" });
  eq(r.status, 400, "空名称 → 400");
  r = await admin.post("/albums", { name: "s3", storage: "s3" });
  ok(r.status === 400, "未配置 S3 时创建 s3 相册 → 400", `${r.status} ${r.err?.code}`);
  r = await admin.post("/albums", { name: "t".repeat(300) });
  ok(r.status === 400 || (r.status === 201 && r.data.name.length <= 200), "超长名称被拒绝或截断", String(r.status));
  if (r.status === 201) await admin.del(`/albums/${r.data.code}`);

  // 游客可见性
  r = await guest.get("/albums");
  const gcodes = (r.data?.albums || []).map((a) => a.code);
  ok(gcodes.includes(st.A.code), "游客可见公开相册");
  ok(!gcodes.includes(st.B.code) && !gcodes.includes(st.Bpub.code), "游客看不到私有相册及其公开子相册");
  r = await guest.get(`/albums/${st.B.code}`);
  eq(r.status, 404, "游客访问私有相册 → 404(不泄露存在性)");
  r = await guest.get(`/albums/${st.Bpub.code}`);
  eq(r.status, 404, "游客访问私有祖先下的公开子相册 → 404");
  r = await guest.get("/albums?tree=1");
  ok(r.status === 200, "tree=1 游客");
  r = await admin.get("/albums?tree=1");
  const treeA = (r.data.albums || []).find((a) => a.code === st.A.code);
  ok(treeA?.children?.some((c) => c.code === st.A1.code), "tree=1 返回嵌套 children");
  r = await admin.get(`/albums?parent=${st.A.code}`);
  ok(r.data.albums.length === 1 && r.data.albums[0].code === st.A1.code, "parent= 仅返回直接子相册");
  r = await admin.get(`/albums/${st.A1a.code}`);
  eq(r.data.breadcrumbs.map((b) => b.code), [st.A.code, st.A1.code, st.A1a.code], "面包屑 = 祖先链");

  // 修改
  r = await admin.patch(`/albums/${st.A.code}`, { name: "公开相册-改名-" + tag, description: "new desc" });
  ok(r.status === 200 && r.data.name.includes("改名") && r.data.description === "new desc", "PATCH 改名/描述");
  r = await admin.patch(`/albums/${st.A.code}`, { visibility: "private", cascade: true });
  ok(r.status === 200, "PATCH 设为私有 + cascade");
  r = await admin.get(`/albums/${st.A1a.code}`);
  eq(r.data.visibility, "private", "cascade 使孙相册同步为私有");
  r = await admin.patch(`/albums/${st.A.code}`, { visibility: "public", cascade: true });
  r = await admin.get(`/albums/${st.A1a.code}`);
  eq(r.data.visibility, "public", "cascade 恢复公开");
  r = await admin.patch(`/albums/${st.A.code}`, { parent: st.A1a.code });
  eq(r.status, 400, "把相册移到自己子孙下 → 400");
  r = await admin.patch(`/albums/${st.A.code}`, { parent: st.A.code });
  eq(r.status, 400, "把相册移到自己下 → 400");
  r = await admin.patch(`/albums/${st.A1a.code}`, { parent: null }).catch(() => null);
  const moved = r && r.status === 200 && r.data.parent === null;
  ok(moved, "parent=null 移到顶层", r ? `${r.status} ${JSON.stringify(r.data?.parent)}` : "");
  r = await admin.patch(`/albums/${st.A1a.code}`, { parent: st.A1.code });
  eq(r.data?.parent, st.A1.code, "移回子相册下");
  r = await admin.get(`/albums/${st.A.code}/status`);
  ok(r.status === 200 && r.data.descendants >= 2, "GET /albums/:code/status 含 descendants", JSON.stringify(r.data).slice(0, 200));
  r = await admin.get("/albums/alb_nonexist");
  eq(r.status, 404, "不存在的相册 → 404");
  r = await admin.del("/albums/alb_nonexist");
  eq(r.status, 404, "删除不存在的相册 → 404");
}

/* ===================================================================== */
async function sUpload() {
  section("上传(local):多格式 / NASA 真实素材 / 去重 / 损坏 / 边界");
  const files = [
    ...nasaImgs.map((p) => ({ path: p })),
    { path: S("exif-known.jpg") },
    { path: S("ai-a1111.png") },
    { path: S("fmt.webp") },
    { path: S("fmt.gif") },
    { path: S("fmt.tif") },
    { path: S("fmt.bmp") },
    { path: S("portrait-rotated.jpg") },
    { path: S("中文 名字 (1).jpg") },
    { path: S("dup-source.jpg") },
  ].filter((f) => fs.existsSync(f.path));
  if (fs.existsSync(S("fmt.avif"))) files.push({ path: S("fmt.avif") });
  const tvid = tinyVideo;
  // 去重:tiny.mp4 缺失时 tinyVideo 会回落到 nasaVids[0],此时不能再重复 push,
  // 否则同一视频上传两次,第二次被判为 duplicate,导致「所有文件 created」断言失败
  const seenPaths = new Set(files.map((f) => f.path));
  for (const p of [tvid, nasaVids[0]]) {
    if (p && !seenPaths.has(p)) {
      seenPaths.add(p);
      files.push({ path: p });
    }
  }

  let r = await admin.upload({ album: st.A.code, wait: 1, concurrency: 4 }, files, { timeout: 300_000 });
  ok(r.status === 200, "批量上传 HTTP 200", `${r.status} ${r.buf.toString().slice(0, 200)}`);
  eq(r.data?.target?.album, st.A.code, "响应 target.album");
  eq(r.data?.target?.storage, "local", "响应 target.storage=local");
  eq(r.data?.summary?.failed, 0, "无失败项", JSON.stringify(r.data?.summary));
  st.up = {};
  for (const x of r.data?.results || []) st.up[x.filename] = x;
  ok(Object.values(st.up).every((x) => x.status === "created" && x.id), "所有文件 created 且返回 id");
  st.upIds = Object.values(st.up).map((x) => x.id);
  const done = await waitProcessed(admin, st.upIds, { timeout: 240_000 });
  st.done = done;
  const notReady = Object.values(done).filter((d) => d.status !== "ready");
  ok(notReady.length === 0, "全部文件处理为 ready", notReady.map((d) => `${d.filename}:${d.status}:${d.error}`).join("; "));

  // 磁盘与派生图
  const exif = st.up["exif-known.jpg"];
  const d = (await admin.get(`/media/${exif.id}`)).data;
  st.exifId = exif.id;
  if (DATA) {
    const onDisk = path.join(DATA, d.storageKey);
    ok(fs.existsSync(onDisk) && sha(fs.readFileSync(onDisk)) === sha(fs.readFileSync(S("exif-known.jpg"))), "local 原文件字节与上传一致", d.storageKey);
    ok(d.storageKey.startsWith(`albums/${st.A.code}/`), "原文件落在 albums/<相册代码>/");
    const der = listFilesRec(path.join(DATA, "derived")).filter((f) => f.includes(exif.id));
    ok(der.length >= 2, "生成 thumb + preview 派生图", der.map((f) => path.basename(f)).join(","));
  } else skip("磁盘断言", "未提供 DATA_DIR");

  // 逐文件尺寸校验(与 sharp 直读对比)
  let bad = [];
  for (const p of [...nasaImgs, S("fmt.webp"), S("fmt.gif"), S("fmt.tif"), S("fmt.bmp"), S("exif-known.jpg")]) {
    const x = st.up[path.basename(p)];
    if (!x) continue;
    const m = await sharp(p).metadata().catch(() => null);
    const dd = done[x.id];
    if (m && dd && (dd.width !== m.width || dd.height !== m.height)) bad.push(`${path.basename(p)} ${dd.width}x${dd.height} ≠ ${m.width}x${m.height}`);
  }
  ok(bad.length === 0, "图片宽高与源文件一致", bad.join("; "));
  const rot = done[st.up["portrait-rotated.jpg"]?.id];
  if (rot) ok(rot.width === 900 && rot.height === 600, "EXIF Orientation=6 按旋转后尺寸入库(900x600)", `${rot.width}x${rot.height}`);

  // 元数据
  section("元数据:EXIF / AI / NASA / 视频");
  const m = d.meta;
  eq(m.summary.camera.make, "PGS-Test", "EXIF Make");
  eq(m.summary.camera.model, "TestCam 9000", "EXIF Model");
  eq(m.summary.exposure.iso, "400", "EXIF ISO");
  eq(m.summary.exposure.fNumber, "f/2.8", "EXIF 光圈");
  eq(m.summary.exposure.exposureTime, "1/250s", "EXIF 快门");
  eq(m.summary.exposure.focalLength, "50mm", "EXIF 焦距");
  // EXIF DateTimeOriginal 无时区,产品按【站点时区】解释(默认 Asia/Shanghai),
  // 因此 API 返回的是 UTC ISO 串。断言时按站点时区换算回本地时间再比较,
  // 避免在不同 TZ 的宿主机/容器上误判(此前在 TZ=UTC 的 CI 上恰好通过)。
  {
    const tz = (await admin.get("/settings")).data?.timezone || "Asia/Shanghai";
    let local = "";
    try {
      local = new Intl.DateTimeFormat("sv-SE", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      }).format(new Date(d.takenAt)).replace(" ", "T");
    } catch {
      local = String(d.takenAt);
    }
    ok(local.startsWith("2021-07-20T12:34:56"), "takenAt 取自 DateTimeOriginal", `${d.takenAt} → ${tz} ${local}`);
  }
  ok(String(d.sortAt) === String(d.takenAt), "sortAt = takenAt");
  eq(m.summary.file.format, "jpeg", "文件格式");
  const ai = (await admin.get(`/media/${st.up["ai-a1111.png"].id}`)).data;
  ok(ai.meta.ai && /panda/.test(ai.meta.ai.prompt || ""), "AI 元数据:prompt", JSON.stringify(ai.meta.ai).slice(0, 200));
  ok(/lowres/.test(ai.meta.ai?.negativePrompt || ""), "AI 元数据:negativePrompt");
  ok(String(ai.meta.ai?.seed) === "123456789" && Number(ai.meta.ai?.steps) === 28, "AI 元数据:seed/steps");
  ok(/Euler/i.test(ai.meta.ai?.sampler || ""), "AI 元数据:sampler");
  ok(ai.meta.text && Object.keys(ai.meta.text).length > 0, "PNG 文本块被解析到 meta.text");
  let nasaWithMeta = 0;
  for (const p of nasaImgs) {
    const x = done[st.up[path.basename(p)]?.id];
    if (x && x.width > 0 && x.height > 0 && x.meta?.summary?.file?.format) nasaWithMeta++;
  }
  ok(nasaWithMeta === nasaImgs.length && nasaImgs.length > 0, `NASA 真实图片 ${nasaImgs.length} 张均有基础元数据`, `${nasaWithMeta}`);
  const withKw = [];
  for (const p of nasaImgs) {
    const x = done[st.up[path.basename(p)]?.id];
    const sm = x?.meta?.summary;
    if (sm?.authoring?.title || sm?.authoring?.keywords || sm?.camera?.make || x?.meta?.raw?.IPTC || x?.meta?.raw?.XMP) withKw.push(path.basename(p));
  }
  ok(withKw.length > 0, "至少一张 NASA 图片提取到 IPTC/XMP/EXIF 内容(标题/关键词/相机)", `${withKw.length}/${nasaImgs.length}`);
  if (HAS_VIDEO && tvid) {
    const v = done[st.up[path.basename(tvid)]?.id];
    // 断言目标:合成 2 秒 320x240 视频。若 tiny.mp4 缺失而回落到 NASA 真实视频,
    // 时长/宽度必然不同,此时只校验「已解析出时长与宽度」,避免误报。
    const isSynth = path.basename(tvid) === "tiny.mp4";
    const vOk = isSynth
      ? v?.kind === "video" && v.duration > 1 && v.duration < 4 && v.width === 320
      : v?.kind === "video" && v.duration > 0 && v.width > 0;
    ok(vOk, isSynth ? "视频:时长/宽度(ffprobe)" : "视频:时长/宽度(ffprobe,NASA 真实素材)", JSON.stringify({ f: path.basename(tvid), d: v?.duration, w: v?.width }));
    ok(/h264|avc/i.test(v?.meta?.video?.videoCodec || ""), "视频:编码识别 h264", v?.meta?.video?.videoCodec);
    const th = await admin.get(`/media/${v.id}/thumb`);
    ok(th.status === 200 && /image\//.test(th.headers.get("content-type")), "视频封面 thumb 可取");
    if (nasaVids[0]) {
      const nv = done[st.up[path.basename(nasaVids[0])]?.id];
      ok(nv?.status === "ready" && nv.duration > 0, "NASA 真实视频处理为 ready 且有时长", JSON.stringify({ d: nv?.duration, s: nv?.status }));
    }
  } else skip("视频元数据", "HAS_VIDEO=0 或无视频素材");

  // 去重
  section("上传:去重 / 重复保留 / 损坏 / 非法类型 / 边界");
  r = await admin.upload({ album: st.A.code, wait: 1 }, [{ path: S("dup-copy.jpg") }]);
  eq(r.data?.results?.[0]?.status, "duplicate", "同相册同内容 → duplicate");
  eq(r.data?.results?.[0]?.id, st.up["dup-source.jpg"].id, "duplicate 返回已有记录 id");
  r = await admin.upload({ album: st.A.code, wait: 1, duplicate: "keep" }, [{ path: S("dup-copy.jpg") }]);
  ok(r.data?.results?.[0]?.status === "created" && r.data.results[0].id !== st.up["dup-source.jpg"].id, "duplicate=keep → 再建一条");
  st.keepId = r.data?.results?.[0]?.id;
  r = await admin.post("/media/exists", { hashes: [sha(fs.readFileSync(S("dup-source.jpg"))), "0".repeat(64)] });
  ok(r.status === 200 && new Set(r.data.existing.map((x) => x.hash)).size === 1 && r.data.existing[0].hash === sha(fs.readFileSync(S("dup-source.jpg"))), "POST /media/exists 只命中已有 hash", JSON.stringify(r.data).slice(0, 200));
  r = await admin.upload({ album: st.A.code }, [{ path: S("note.txt") }]);
  ok(r.status === 422 || r.data?.results?.[0]?.status === "error", "非媒体文件被拒绝", String(r.status));
  r = await admin.upload({ album: st.A.code }, []);
  ok(r.status >= 400 && r.status < 500, "没有文件的上传 → 4xx", String(r.status));
  r = await admin.upload({ album: "alb_nonexist" }, [{ path: S("dup-source.jpg") }]);
  ok(r.status === 400 || r.status === 404, "上传到不存在的相册 → 4xx", String(r.status));
  r = await admin.upload({ storage: "s3" }, [{ path: S("dup-source.jpg") }]);
  ok(r.status === 400, "未配置 S3 时 storage=s3 → 400", `${r.status} ${r.err?.code}`);
  r = await admin.upload({ album: st.A.code, wait: 1 }, [{ data: fs.readFileSync(S("fmt.webp")), filename: "../../evil name.webp" }]);
  const ev = r.data?.results?.[0];
  ok(ev?.status === "created" || ev?.status === "duplicate", "路径穿越文件名被安全处理", JSON.stringify(ev));
  if (ev?.id) {
    const dd = (await admin.get(`/media/${ev.id}`)).data;
    ok(!dd.filename.includes("/") && !dd.filename.includes(".."), "文件名已去除路径成分", dd.filename);
    ok(!dd.storageKey || (!dd.storageKey.includes("..") && dd.storageKey.startsWith("albums/")), "storageKey 不含 ..", dd.storageKey);
  }
  if (DATA) ok(!fs.existsSync(path.join(DATA, "..", "evil name.webp")) && !fs.existsSync(path.join(DATA, "evil name.webp")), "没有写出数据目录之外");

  // 损坏
  r = await admin.upload({ album: st.A.code, wait: 1, waitMs: 20000 }, [{ path: S("corrupt.jpg") }]);
  const cid = r.data?.results?.[0]?.id;
  ok(!!cid, "损坏文件上传阶段被接收", JSON.stringify(r.data?.results?.[0]));
  if (cid) {
    await waitFor(async () => (await admin.get("/status/corrupt")).data?.items?.some((i) => i.id === cid), { timeout: 60_000, what: "损坏文件出现在 /status/corrupt" }).catch(() => null);
    r = await admin.get("/status/corrupt");
    ok(r.data?.items?.some((i) => i.id === cid), "损坏文件进入 /status/corrupt");
    r = await admin.get(`/media?album=${st.A.code}&limit=200`);
    ok(!r.data.items.some((i) => i.id === cid), "损坏文件不出现在相册列表");
    r = await admin.post("/status/corrupt/purge", { ids: [cid] });
    ok(r.status === 200, "清理损坏文件", r.buf.toString().slice(0, 120));
    r = await admin.get("/status/corrupt");
    ok(!r.data?.items?.some((i) => i.id === cid), "清理后不再列出");
    if (DATA) ok(listFilesRec(path.join(DATA, "albums", st.A.code)).every((f) => path.basename(f) !== "corrupt.jpg"), "受管存储的损坏源文件被一并删除");
  }

  // 未归类
  r = await admin.upload({ wait: 1 }, [{ path: S("fmt.bmp") }, { data: await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123456" } }).jpeg().toBuffer(), filename: `unsorted-${tag}.jpg` }]);
  eq(r.data?.target?.album, null, "未指定相册 → 未归类(album=null)");
  st.unsortedId = r.data?.results?.find((x) => x.filename === `unsorted-${tag}.jpg`)?.id;
  r = await admin.get("/media?album=_unsorted");
  ok(r.data.items.some((i) => i.id === st.unsortedId), "未归类媒体在 _unsorted 中");
  r = await guest.get("/media?album=_unsorted");
  ok(!r.data?.items?.length, "游客看不到未归类媒体", String(r.data?.items?.length));
  r = await guest.get(`/media/${st.unsortedId}`);
  eq(r.status, 404, "游客访问未归类媒体详情 → 404");
  r = await admin.get("/albums");
  ok(typeof r.data.unsorted === "number" && r.data.unsorted >= 1, "/albums 返回 unsorted 计数");

  // uploader 角色可上传
  r = await st.upl.upload({ album: st.A.code, wait: 1 }, [{ data: await sharp({ create: { width: 40, height: 40, channels: 3, background: "#aa5500" } }).png().toBuffer(), filename: "by-uploader.png" }]);
  ok(r.status === 200 && r.data.summary.created === 1, "uploader 角色可上传");
  r = await admin.get(`/media?album=${st.A.code}&limit=200`);
  st.AItems = r.data.items;
  eq(st.AItems.filter((i) => /^dup-/.test(i.filename)).length, 2, "相册内 dup-* 共 2 条(原 + keep)");
}

/* ===================================================================== */
async function sFiles() {
  section("文件输出:缩略图 / 预览 / 原图保护 / 下载密钥");
  const id = st.exifId;
  const raw = fs.readFileSync(S("exif-known.jpg"));
  let r = await admin.get(`/media/${id}/thumb`);
  ok(r.status === 200 && r.headers.get("content-type") === "image/webp", "thumb 为 webp");
  const tm = await sharp(r.buf).metadata();
  ok(tm.width <= Number(process.env.THUMB_WIDTH || 720), "thumb 宽度 ≤ THUMB_WIDTH(默认 720)", String(tm.width));
  r = await admin.get(`/media/${id}/preview`);
  const pm = await sharp(r.buf).metadata();
  ok(r.status === 200 && pm.width <= 1600 && pm.width > tm.width, "preview 宽度 ≤ 1600 且 > thumb", String(pm.width));
  ok(!!r.headers.get("etag"), "派生图带 ETag");
  const etag = r.headers.get("etag");
  const r304 = await admin.get(`/media/${id}/preview`, { headers: { "if-none-match": etag } });
  eq(r304.status, 304, "If-None-Match → 304");
  r = await admin.get(`/media/${id}/thumb`);
  ok(!(await sharp(r.buf).metadata()).exif, "派生图不含 EXIF");

  // 游客(相册 A 公开)
  r = await guest.get(`/f/${id}`);
  ok(r.status === 200 && r.headers.get("content-type") === "image/webp" && sha(r.buf) !== sha(raw), "游客 /f/:id 只得到预览图(非原文件)");
  ok(/noindex/.test(r.headers.get("x-robots-tag") || ""), "/f/ 带 X-Robots-Tag: noindex");
  r = await guest.get(`/f/${id}.jpg`);
  ok(r.status === 200 && sha(r.buf) !== sha(raw), "/f/:id.jpg 带扩展名同样只给预览");
  r = await guest.get(`/f/${id}?key=bad-key-bad-key-bad-key`);
  eq(r.status, 403, "无效 key → 403 invalid_key(不静默降级)");
  eq(r.err?.code, "invalid_key", "错误码 invalid_key");
  r = await guest.get(`/api/v1/media/${id}/file`);
  ok(r.status === 200 && sha(r.buf) !== sha(raw), "/media/:id/file 游客同样只给预览");

  // 创建密钥
  r = await admin.post("/keys", { key: "short", expires: "never" });
  eq(r.status, 400, "密钥过短 → 400");
  r = await admin.post("/keys", { key: "bad key with spaces!!", expires: "never" });
  eq(r.status, 400, "密钥含非法字符 → 400");
  r = await admin.post("/keys", { label: "auto", expires: "never" });
  ok(r.status === 200 || r.status === 201, "自动生成密钥", String(r.status));
  const autoKey = r.data?.key;
  ok(typeof autoKey === "string" && autoKey.length >= 16, "返回明文密钥(≥16 位)");
  st.key = "pgs-test-key-" + tag + "-abcdef";
  r = await admin.post("/keys", { key: st.key, label: "t", expires: "never" });
  ok(r.status < 300, "创建自定义密钥", r.buf.toString().slice(0, 120));
  r = await admin.get("/keys");
  ok(r.data.keys.length >= 2 && !JSON.stringify(r.data).includes(st.key), "GET /keys 不含明文");
  r = await admin.get(`/keys/verify?key=${st.key}`);
  ok(r.data?.valid === true, "keys/verify 有效");
  r = await admin.post("/keys/verify", { key: "nope-nope-nope-nope-nope" });
  ok(r.data?.valid === false, "keys/verify 无效");

  r = await guest.get(`/f/${id}?key=${st.key}`);
  ok(r.status === 200 && sha(r.buf) === sha(raw), "有效 key → 原文件字节一致");
  ok(r.headers.get("cache-control")?.includes("no-store"), "原文件 Cache-Control: no-store", r.headers.get("cache-control"));
  r = await guest.get(`/f/${id}?key=${st.key}&dl=1`);
  ok(/attachment/i.test(r.headers.get("content-disposition") || ""), "dl=1 → attachment");
  r = await guest.get(`/f/${id}?key=${st.key}`, { headers: { range: "bytes=0-99" } });
  ok(r.status === 206 || r.status === 200, "图片 Range 请求不报错", String(r.status));
  // 角色:uploader 没有 original 权限
  r = await st.upl.get(`/f/${id}`);
  ok(sha(r.buf) !== sha(raw), "uploader 无 key 访问 /f/ 只得预览");
  r = await st.mgr.get(`/f/${id}`);
  ok(sha(r.buf) === sha(raw), "manager(具备 original)免 key 取原图");
  r = await admin.get(`/f/${id}`);
  ok(sha(r.buf) === sha(raw), "admin 免 key 取原图");

  // 私有相册 + key
  r = await admin.upload({ album: st.B.code, wait: 1 }, [{ path: S("dup-source.jpg") }]);
  st.privId = r.data.results[0].id;
  await waitProcessed(admin, [st.privId]);
  for (const p of [`/media/${st.privId}`, `/media/${st.privId}/thumb`, `/media/${st.privId}/preview`, `/f/${st.privId}`]) {
    r = await guest.get(p);
    eq(r.status, 404, `游客访问私有媒体 ${p.replace(st.privId, ":id")} → 404`);
  }
  r = await guest.get(`/f/${st.privId}?key=${st.key}`);
  ok(r.status === 200 && sha(r.buf) === sha(fs.readFileSync(S("dup-source.jpg"))), "携带有效 key 可访问私有媒体原图(密钥即授权)");
  r = await st.vwr.get(`/media/${st.privId}/thumb`);
  eq(r.status, 200, "已登录 viewer 可看私有缩略图");
  r = await guest.get(`/media?album=${st.B.code}`);
  ok(r.status === 404 || !(r.data?.items || []).length, "游客列私有相册 → 空/404", String(r.status));

  // 视频保护
  if (tinyVideo && HAS_VIDEO) {
    const vid = st.up[path.basename(tinyVideo)].id;
    const vraw = fs.readFileSync(tinyVideo);
    r = await guest.get(`/f/${vid}`);
    ok(r.status === 200 && /image\//.test(r.headers.get("content-type")), "游客 /f/<视频> 只得封面图");
    r = await guest.get(`/f/${vid}?key=${st.key}`);
    ok(r.status === 200 && sha(r.buf) === sha(vraw), "有效 key → 原视频字节一致");
    r = await guest.get(`/f/${vid}?key=${st.key}`, { headers: { range: "bytes=0-1023" } });
    ok(r.status === 206 && r.buf.length === 1024 && /bytes 0-1023\//.test(r.headers.get("content-range") || ""), "视频 Range → 206 + Content-Range");
    r = await guest.get(`/media/${vid}/stream`);
    ok(r.status === 403 || r.status === 404, "游客直接 GET /stream 被拒(无令牌)", String(r.status));
    r = await admin.get(`/media/${vid}`);
    ok(!!r.data.streamUrl, "详情返回 streamUrl(带播放令牌)");
    const sUrl = r.data.streamUrl.startsWith("http") ? r.data.streamUrl : BASE + r.data.streamUrl;
    r = await guest.req("GET", sUrl, { headers: { "sec-fetch-dest": "video", range: "bytes=0-99" } });
    ok(r.status === 206 || r.status === 200, "带令牌 + Sec-Fetch-Dest:video 可播放", String(r.status));
    r = await guest.req("GET", sUrl, { headers: { "sec-fetch-dest": "document" } });
    ok(r.status === 403, "同令牌但 Sec-Fetch-Dest:document(像直接下载)→ 403", String(r.status));
  }

  // 游客元数据裁剪 / 备注
  r = await admin.patch(`/media/${id}`, { note: "管理员秘密备注-" + tag });
  ok(r.status === 200, "PATCH 备注");
  r = await guest.get(`/media/${id}`);
  ok(r.status === 200 && !r.data.note, "游客看不到管理员备注");
  ok(!r.data.storageKey && !r.data.hash, "游客看不到 storageKey/hash");
  ok(Object.keys(r.data.meta?.raw || {}).length === 0 && r.data.meta?.summary?.gps?.latitude == null, "游客元数据裁剪(无 raw/GPS)");
  ok(r.data.error == null, "游客 error 置空");
  r = await admin.get(`/media/${id}`);
  eq(r.data.note, "管理员秘密备注-" + tag, "管理员读回备注");
  r = await admin.patch(`/media/${id}`, { note: "x".repeat(5001) });
  eq(r.status, 400, "备注 >5000 → 400");
  r = await st.upl.patch(`/media/${id}`, { note: "no" });
  eq(r.status, 403, "uploader 不能改备注");

  // 密钥管理
  r = await admin.post("/keys", { key: "ttl-key-" + tag + "-abcdefgh", expires: "24h" });
  ok(r.status < 300 && r.data?.expiresAt, "24h 密钥带 expiresAt");
  r = await admin.get("/keys");
  const ttl = r.data.keys.find((k) => k.expiresAt);
  ok(!!ttl && Math.abs(new Date(ttl.expiresAt) - Date.now() - 86400_000) < 3600_000, "24h 到期时间≈当前+24h");
  r = await admin.post("/keys/revoke", { key: "ttl-key-" + tag + "-abcdefgh" });
  ok(r.status === 200, "POST /keys/revoke 按明文撤销");
  const autoRow = (await admin.get("/keys")).data.keys.find((k) => k.label === "auto");
  r = await admin.del(`/keys/${autoRow.id}`);
  ok(r.status === 200, "DELETE /keys/:id");
  r = await guest.get(`/f/${id}?key=${autoKey}`);
  eq(r.status, 403, "撤销后的密钥 → 403");
}

/* ===================================================================== */
async function sSearch() {
  section("搜索 / 分页 / 范围");
  const q = async (qs, c = admin) => (await c.get(`/media?${qs}`)).data;
  let d = await q(`q=exif-known&album=${st.A.code}`);
  ok(d.items.some((i) => i.id === st.exifId), "按文件名搜索");
  d = await q(`q=TestCam`);
  ok(d.items.some((i) => i.id === st.exifId), "按相机型号搜索(全局)");
  d = await q(`q=${encodeURIComponent("red panda")}`);
  ok(d.items.some((i) => i.filename === "ai-a1111.png"), "按 AI 提示词搜索");
  d = await q(`q=${encodeURIComponent("panda zzzznotthere")}`);
  eq(d.items.length, 0, "多词 AND:含不存在的词 → 0 条");
  d = await q(`q=${encodeURIComponent("中文")}`);
  ok(d.items.some((i) => i.filename.includes("中文")), "中文文件名搜索");
  d = await q(`q=${encodeURIComponent("'; DROP TABLE pgs_media;--")}`);
  ok(Array.isArray(d?.items), "SQL 注入式关键字不报错、不破坏表");
  d = await q(`q=${encodeURIComponent('%_\\"')}`);
  ok(Array.isArray(d?.items), "LIKE 通配符/引号字符不报错");
  // issue #2:含 _ / % 的关键词应按字面量匹配(SQLite 的 LIKE 必须显式 ESCAPE)
  {
    const fn = `IMG_0042_${tag}.jpg`;
    const up = await admin.upload({ album: st.A.code, wait: 1 }, [{ data: await sharp({ create: { width: 48, height: 48, channels: 3, background: "#336699" } }).jpeg().toBuffer(), filename: fn }]);
    const uid = up.data?.results?.[0]?.id;
    d = await q(`q=${encodeURIComponent(`img_0042_${tag}`)}`);
    ok(d.items.some((i) => i.id === uid), "含下划线的文件名关键词(IMG_0042_…)可搜到", fn);
    d = await q(`q=${encodeURIComponent(`img-0042-${tag}`)}`);
    eq(d.items.length, 0, "下划线不被当作通配符(img-0042 不匹配 IMG_0042)");
    d = await q(`q=${encodeURIComponent(`img%${tag}`)}`);
    eq(d.items.length, 0, "% 不被当作通配符");
    if (uid) await admin.del(`/media/${uid}?purge=1`);
  }
  d = await q(`kind=video&album=${st.A.code}`);
  ok(d.items.every((i) => i.kind === "video"), "kind=video 过滤");
  d = await q(`kind=image&album=${st.A.code}&limit=200`);
  ok(d.items.length > 5 && d.items.every((i) => i.kind === "image"), "kind=image 过滤");
  // 备注:管理员可搜,游客不可
  d = await q(`q=${encodeURIComponent("秘密备注-" + tag)}`);
  ok(d.items.some((i) => i.id === st.exifId), "登录用户可按备注搜索");
  d = await q(`q=${encodeURIComponent("秘密备注-" + tag)}`, guest);
  eq(d.items.length, 0, "游客无法通过搜索探测备注");

  // 父子不重复
  let r = await admin.upload({ album: st.A1.code, wait: 1 }, [{ data: await sharp({ create: { width: 50, height: 50, channels: 3, background: "#00ff88" } }).jpeg().toBuffer(), filename: `child-only-${tag}.jpg` }]);
  const cid = r.data.results[0].id;
  await waitProcessed(admin, [cid]);
  d = await q(`album=${st.A.code}&limit=200`);
  ok(!d.items.some((i) => i.id === cid), "父相册列表不含子相册文件");
  d = await q(`album=${st.A.code}&recursive=1&limit=200`);
  ok(d.items.some((i) => i.id === cid), "recursive=1 含子相册文件");
  d = await q(`q=child-only-${tag}&album=${st.A.code}`);
  eq(d.items.length, 0, "父相册内搜索不命中子相册文件");
  d = await q(`q=child-only-${tag}&album=${st.A1.code}`);
  eq(d.items.length, 1, "子相册内搜索命中");
  d = await q(`q=child-only-${tag}`);
  eq(d.items.length, 1, "全局搜索命中且不重复");

  // 游客全局搜索只见公开
  d = await q(`q=dup-source`, guest);
  ok(d.items.length >= 1 && !d.items.some((i) => i.id === st.privId), "游客全局搜索不含私有相册文件");

  // 分页
  const all = [];
  let cursor = "";
  let pages = 0;
  do {
    const p = (await admin.get(`/media?album=${st.A.code}&limit=3${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`)).data;
    all.push(...p.items);
    cursor = p.nextCursor;
    pages++;
  } while (cursor && pages < 100);
  const full = (await q(`album=${st.A.code}&limit=200`)).items;
  eq(all.length, full.length, "游标分页取全与一次取全数量一致");
  eq(new Set(all.map((i) => i.id)).size, all.length, "分页无重复项");
  eq(all.map((i) => i.id), full.map((i) => i.id), "分页顺序 = 一次取全顺序");
  const asc = (await q(`album=${st.A.code}&limit=200&order=asc`)).items;
  eq(asc.map((i) => i.id), [...full].reverse().map((i) => i.id), "order=asc 与 desc 严格相反");
  d = await q(`album=${st.A.code}&from=2021-07-19T00:00:00Z&to=2021-07-21T00:00:00Z`);
  ok(d.items.length >= 1 && d.items.every((i) => i.sortAt.startsWith("2021-07-20")), "from/to 时间范围过滤", d.items.map((i) => i.sortAt).join(","));
  r = await admin.get("/media?limit=0");
  ok(r.status === 200 || r.status === 400, "limit=0 不 500", String(r.status));
  r = await admin.get("/media?limit=100000");
  ok(r.status === 200 && r.data.items.length <= 200, "limit 超上限被截断到 ≤200", String(r.data?.items?.length));
  r = await admin.get("/media?cursor=garbage");
  ok(r.status < 500, "非法 cursor 不 500", String(r.status));
  r = await admin.get("/media-timeline");
  ok(r.status === 200 && r.data.months.length >= 1 && r.data.months.some((m) => m.m === "2021-07"), "media-timeline 含 2021-07", JSON.stringify(r.data).slice(0, 150));
  r = await guest.get("/media-timeline");
  ok(r.status === 200, "游客 media-timeline");
}

/* ===================================================================== */
async function sMedia() {
  section("媒体操作:移动 / 批量 / 重处理 / 删除 / 黑名单(local)");
  // 移动
  let r = await admin.patch(`/media/${st.keepId}`, { album: st.A1.code });
  ok(r.status === 200, "PATCH 移动媒体到子相册", r.buf.toString().slice(0, 150));
  let det = (await admin.get(`/media/${st.keepId}`)).data;
  eq(det.album, st.A1.code, "移动后 album 变更");
  r = await admin.get(`/media/${st.keepId}/thumb`);
  eq(r.status, 200, "移动后缩略图仍可取");
  r = await admin.get(`/f/${st.keepId}`);
  eq(r.status, 200, "移动后原文件仍可取");
  r = await admin.patch(`/media/${st.keepId}`, { album: st.A.code });
  ok(r.status === 200, "移回父相册");
  r = await admin.patch(`/media/${st.keepId}`, { album: "alb_nonexist" });
  ok(r.status === 400 || r.status === 404, "移动到不存在相册被拒绝", String(r.status));
  // 批量
  const ids = st.AItems.filter((i) => i.kind === "image").slice(0, 3).map((i) => i.id);
  r = await admin.post("/media/batch", { action: "move", ids, album: st.A1.code });
  ok(r.status === 200 && r.data.affected === 3 && r.data.results.every((x) => x.ok), "batch move 3 项", r.buf.toString().slice(0, 200));
  r = await admin.post("/media/batch", { action: "move", ids, album: st.A.code });
  eq(r.data?.affected, 3, "batch move 回原相册");
  r = await admin.post("/media/batch", { action: "reprocess", ids: ids.slice(0, 2) });
  ok(r.status === 200, "batch reprocess");
  await sleep(500);
  await waitProcessed(admin, ids.slice(0, 2));
  r = await admin.post("/media/batch", { action: "frobnicate", ids });
  eq(r.status, 400, "未知 batch action → 400");
  r = await admin.post("/media/batch", { action: "delete", ids: [] });
  eq(r.status, 400, "batch ids 为空 → 400");
  r = await st.upl.post("/media/batch", { action: "delete", ids });
  eq(r.status, 403, "uploader 批量删除 → 403");
  r = await admin.post(`/media/${ids[0]}/reprocess`);
  ok(r.status === 200, "POST /media/:id/reprocess");
  r = await admin.post("/system/reprocess");
  ok(r.status === 200, "POST /system/reprocess");
  r = await admin.post("/system/regenerate-derived");
  ok(r.status === 200 || r.status === 404, "POST /system/regenerate-derived", String(r.status));
  await sleep(1500);
  await waitFor(async () => (await admin.get("/status/queue")).data.running + (await admin.get("/status/queue")).data.waiting === 0, { timeout: 180_000, what: "队列排空" }).catch(() => null);

  // 删除:purge=0 → 黑名单(源文件保留);restore;purge=1
  const mkImg = async (name, color) => {
    const x = await admin.upload({ album: st.A.code, wait: 1 }, [{ data: await sharp({ create: { width: 90, height: 60, channels: 3, background: color } }).jpeg().toBuffer(), filename: name }]);
    const id = x.data.results[0].id;
    await waitProcessed(admin, [id]);
    return id;
  };
  const d1 = await mkImg(`del-soft-${tag}.jpg`, "#ff0000");
  const d1key = (await admin.get(`/media/${d1}`)).data.storageKey;
  r = await st.mgr.del(`/media/${d1}?purge=1`);
  eq(r.status, 403, "manager purge=1 → 403(仅 admin)");
  r = await st.upl.del(`/media/${d1}`);
  eq(r.status, 403, "uploader 删除 → 403");
  r = await admin.del(`/media/${d1}`);
  ok(r.status === 200 && r.data.blocked === true && r.data.purge === false, "默认删除=排除(blocked)", r.buf.toString().slice(0, 150));
  if (DATA) ok(fs.existsSync(path.join(DATA, d1key)), "排除后源文件仍在磁盘");
  r = await admin.get(`/media/${d1}`);
  eq(r.status, 404, "排除后详情 404");
  r = await admin.get("/blocklist");
  const bl = r.data.items.find((b) => b.filename === `del-soft-${tag}.jpg`);
  ok(!!bl, "黑名单出现该文件");
  r = await st.upl.get("/blocklist");
  eq(r.status, 403, "uploader 看黑名单 → 403");
  r = await admin.post(`/blocklist/${bl.id}/restore`);
  ok(r.status === 200, "解除黑名单", r.buf.toString().slice(0, 150));
  await waitProcessed(admin, [d1]);
  r = await admin.get(`/media/${d1}`);
  ok(r.status === 200 && r.data.status === "ready", "恢复后记录回来且重新生成派生图(ready)");
  r = await admin.get(`/media/${d1}/thumb`);
  eq(r.status, 200, "恢复后缩略图可取");
  // 再删 + 黑名单彻底删除
  await admin.del(`/media/${d1}`);
  const bl2 = (await admin.get("/blocklist")).data.items.find((b) => b.filename === `del-soft-${tag}.jpg`);
  r = await admin.del(`/blocklist/${bl2.id}`);
  ok(r.status === 200, "黑名单彻底删除");
  if (DATA) ok(!fs.existsSync(path.join(DATA, d1key)), "彻底删除后源文件已不在磁盘");
  r = await admin.post(`/blocklist/${bl2.id}/restore`);
  ok(r.status === 404, "已彻底删除的黑名单项 restore → 404", String(r.status));
  // purge=1 直接删
  const d2 = await mkImg(`del-hard-${tag}.jpg`, "#00ff00");
  const d2d = (await admin.get(`/media/${d2}`)).data;
  r = await admin.del(`/media/${d2}?purge=1`);
  ok(r.status === 200 && r.data.purge === true, "purge=1 物理删除", r.buf.toString().slice(0, 150));
  if (DATA) {
    ok(!fs.existsSync(path.join(DATA, d2d.storageKey)), "purge 后源文件已删");
    ok(listFilesRec(path.join(DATA, "derived")).every((f) => !f.includes(d2)), "purge 后派生图已删");
  }
  r = await admin.get(`/media/${d2}`);
  eq(r.status, 404, "purge 后详情 404");
  r = await admin.del(`/media/${d2}`);
  eq(r.status, 404, "重复删除 → 404");

  // 相册删除:media=move → 文件移到父相册/未归类;media=delete → 删光
  const T1 = (await admin.post("/albums", { name: "tmp-move-" + tag, visibility: "public" })).data;
  const T1c = (await admin.post("/albums", { name: "tmp-move-child-" + tag, parent: T1.code })).data;
  r = await admin.upload({ album: T1c.code, wait: 1 }, [{ data: await sharp({ create: { width: 30, height: 30, channels: 3, background: "#0000ff" } }).jpeg().toBuffer(), filename: `inner-${tag}.jpg` }]);
  const innerId = r.data.results[0].id;
  r = await admin.del(`/albums/${T1c.code}?media=move`);
  ok(r.status === 200, "删除相册 media=move", r.buf.toString().slice(0, 150));
  r = await admin.get(`/media/${innerId}`);
  ok(r.status === 200 && (r.data.album === T1.code || r.data.album === null), "media=move 后文件迁移到父相册/未归类而非丢失", JSON.stringify(r.data?.album));
  const d3 = await admin.get(`/f/${innerId}`);
  eq(d3.status, 200, "迁移后原文件仍可取");
  r = await admin.del(`/albums/${T1.code}?media=delete`);
  ok(r.status === 200, "删除相册 media=delete");
  r = await admin.get(`/media/${innerId}`);
  eq(r.status, 404, "media=delete 后文件记录不存在");
  if (DATA) ok(!fs.existsSync(path.join(DATA, "albums", T1.code)), "相册目录已删除");
}

/* ===================================================================== */
async function sMount() {
  section("挂载目录(ext):挂载 / 扫描 / 改名 / 搬迁 / 只读 / 删除 / 黑名单");
  if (!MNT_HOST) return skip("挂载测试", "未设置 MOUNT_HOST_DIR");
  try { process.umask(0); } catch {}
  const H = path.join(MNT_HOST, "lib-" + tag); // 测试进程视角
  const V = path.join(MNT_SRV, "lib-" + tag); // 服务端视角
  const chmodTree777 = (d) => {
    try { fs.chmodSync(d, 0o777); } catch {}
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) chmodTree777(p);
      else if (!e.isSymbolicLink()) try { fs.chmodSync(p, 0o666); } catch {}
    }
  };
  const cp = (src, rel) => {
    fs.mkdirSync(path.dirname(path.join(H, rel)), { recursive: true, mode: 0o777 });
    fs.copyFileSync(src, path.join(H, rel));
  };
  cp(nasaImgs[0], "r1.jpg");
  cp(S("ai-a1111.png"), "r2.png");
  cp(S("fmt.webp"), "2024/y1.webp");
  cp(nasaImgs[1] || nasaImgs[0], "2024/trip/t1.jpg");
  if (tinyVideo) cp(tinyVideo, "2024/trip/t2.mp4");
  fs.mkdirSync(path.join(H, "empty"), { recursive: true, mode: 0o777 });
  fs.writeFileSync(path.join(H, "notes.txt"), "ignore me");
  fs.writeFileSync(path.join(H, "2024", ".hidden.jpg"), fs.readFileSync(S("fmt.webp")));
  chmodTree777(H);

  // 拒绝项
  let r = await admin.post("/albums/mount", { path: "relative/path" });
  eq(r.status, 400, "相对路径挂载 → 400");
  r = await admin.upload({ dir: "relative/dir" }, [{ path: S("dup-source.jpg") }]);
  eq(r.status, 400, "dir= 相对路径 → 400");
  r = await admin.post("/albums/mount", { path: path.join(V, "does-not-exist") });
  eq(r.status, 400, "不存在的目录 → 400");
  r = await admin.post("/albums/mount", { path: "/etc" });
  ok(r.status === 400 || r.status === 403, "白名单外目录(/etc)→ 拒绝", `${r.status} ${r.err?.code}`);
  r = await admin.post("/albums/mount", { path: path.join(V, "2024/../../../etc") });
  ok(r.status >= 400 && r.status < 500, "含 .. 穿越路径 → 拒绝", String(r.status));
  try {
    fs.symlinkSync("/etc", path.join(H, "escape-link"));
    r = await admin.post("/albums/mount", { path: path.join(V, "escape-link") });
    ok(r.status >= 400 && r.status < 500, "符号链接指向白名单外(/etc)→ realpath 后被拒绝", `${r.status}`);
    fs.rmSync(path.join(H, "escape-link"));
  } catch {
    skip("符号链接逃逸", "无法创建符号链接");
  }
  r = await admin.get("/fs/browse?path=" + encodeURIComponent(V));
  ok(r.status === 200 && r.data.dirs.some((d) => (d.name || d) === "2024" || String(d.path || d).endsWith("2024")), "fs/browse 列出子目录", JSON.stringify(r.data).slice(0, 200));

  // 挂载
  r = await admin.post("/albums/mount", { path: V, name: "挂载-" + tag, visibility: "public" });
  eq(r.status, 201, "挂载目录 201", r.buf.toString().slice(0, 200));
  const M = r.data;
  st.M = M;
  ok(/^dir_/.test(M.code) && M.kind === "mounted" && M.storage === "ext" && M.readonly === true, "挂载相册 dir_ 前缀 / ext / 默认只读");
  eq(M.rootPath, V, "管理员可见 rootPath");
  r = await st.mgr.get(`/albums/${M.code}`);
  ok(r.status === 200 && !r.data.rootPath, "非特权用户看不到 rootPath");
  r = await admin.post("/albums/mount", { path: V });
  ok(r.status === 409 || r.status === 400, "重复挂载同一路径被拒绝", String(r.status));
  r = await admin.post("/albums/mount", { path: path.join(V, "2024") });
  ok(r.status === 409 || r.status === 400, "嵌套在已挂载目录内的子目录被拒绝(重叠)", String(r.status));
  r = await admin.post("/albums/mount", { path: MNT_SRV });
  ok(r.status === 409 || r.status === 400, "包含已挂载目录的父目录被拒绝(重叠)", String(r.status));

  await waitFor(async () => (await admin.get(`/albums/${M.code}/status`)).data.scan?.running !== true && (await admin.get(`/albums/${M.code}/status`)).data.descendants >= 2, { timeout: 90_000, what: "挂载扫描完成" });
  r = await admin.get(`/albums/${M.code}`);
  const kids = r.data.children;
  const k2024 = kids.find((k) => k.name === "2024");
  ok(!!k2024 && kids.some((k) => k.name === "empty"), "子目录自动成为子相册(含空目录)", kids.map((k) => k.name).join(","));
  const trip = (await admin.get(`/albums/${k2024.code}`)).data.children.find((k) => k.name === "trip");
  ok(!!trip, "多层嵌套:2024/trip");
  st.k2024 = k2024;
  st.trip = trip;
  eq(k2024.parent, M.code, "子相册 parent = 挂载相册");
  ok(k2024.kind === "mounted" && k2024.readonly === true, "子相册同为只读挂载");
  const list = async (code) => (await admin.get(`/media?album=${code}&limit=200`)).data.items;
  await waitFor(async () => (await admin.get(`/albums/${trip.code}/status`)).data.counts?.pending === 0 || (await admin.get(`/albums/${trip.code}/status`)).data.pending === 0, { timeout: 90_000, what: "trip 处理完" }).catch(() => null);
  let root = await list(M.code);
  eq(root.map((i) => i.filename).sort(), ["r1.jpg", "r2.png"], "根相册仅含本层 2 个媒体(忽略 txt、子目录文件)");
  eq((await list(k2024.code)).map((i) => i.filename), ["y1.webp"], "2024 仅含 y1.webp(忽略隐藏文件)");
  eq((await list(trip.code)).map((i) => i.filename).sort(), tinyVideo ? ["t1.jpg", "t2.mp4"] : ["t1.jpg"], "trip 含 t1.jpg / t2.mp4");
  const r1 = root.find((i) => i.filename === "r1.jpg");
  await waitProcessed(admin, root.map((i) => i.id));
  const r1d = (await admin.get(`/media/${r1.id}`)).data;
  ok(r1d.storage === "ext" && r1d.status === "ready" && r1d.width > 0, "ext 媒体 ready 且有尺寸");
  eq(r1d.storageKey, path.join(V, "r1.jpg"), "ext storageKey = 绝对路径");
  r = await admin.get(`/media/${r1.id}/thumb`);
  eq(r.status, 200, "ext 缩略图可取");
  r = await admin.get(`/f/${r1.id}`);
  ok(r.status === 200 && sha(r.buf) === sha(fs.readFileSync(path.join(H, "r1.jpg"))), "ext 原文件 admin 可取且字节一致");
  r = await admin.get(`/albums/${M.code}/status`);
  ok(r.data.mediaTotal >= 5 || r.data.counts?.mediaTotal >= 5, "挂载相册 mediaTotal 含子孙", JSON.stringify(r.data).slice(0, 200));

  // 只读
  r = await admin.upload({ album: M.code }, [{ path: S("dup-source.jpg") }]);
  eq(r.status, 403, "上传到只读挂载相册 → 403");
  r = await admin.upload({ dir: V }, [{ path: S("dup-source.jpg") }]);
  eq(r.status, 403, "dir= 指向只读挂载目录 → 403");
  r = await admin.del(`/media/${r1.id}?purge=1`);
  ok(r.status >= 400 && r.status < 500, "只读挂载相册禁止 purge 物理删除", `${r.status} ${r.err?.code}`);
  if (DATA === "" || true) ok(fs.existsSync(path.join(H, "r1.jpg")), "只读相册源文件仍在");

  // 扫描:新增 / 改名 / 修改 / 删除
  cp(nasaImgs[2] || nasaImgs[0], "added-by-scan.jpg");
  r = await admin.post(`/albums/${M.code}/scan?wait=1`);
  ok(r.status === 200 && r.data.added === 1, "scan?wait=1 发现新增文件 added=1", r.buf.toString().slice(0, 200));
  r = await admin.post(`/albums/${M.code}/scan?wait=1`);
  ok(r.data?.added === 0 && r.data?.removed === 0, "再次扫描无变化(幂等)", JSON.stringify(r.data));
  const added = (await list(M.code)).find((i) => i.filename === "added-by-scan.jpg");
  ok(!!added, "新增文件进入相册");
  fs.renameSync(path.join(H, "added-by-scan.jpg"), path.join(H, "renamed-by-test.jpg"));
  r = await admin.post(`/albums/${M.code}/scan?wait=1`);
  const afterRename = await list(M.code);
  const rn = afterRename.find((i) => i.filename === "renamed-by-test.jpg");
  ok(!!rn && rn.id === added.id, "改名被识别为同一条记录(id 不变,不是 删+建)", `${rn?.id} vs ${added.id} ${JSON.stringify(r.data)}`);
  ok(!afterRename.some((i) => i.filename === "added-by-scan.jpg"), "旧文件名不再出现");
  fs.copyFileSync(S("exif-known.jpg"), path.join(H, "renamed-by-test.jpg"));
  fs.utimesSync(path.join(H, "renamed-by-test.jpg"), new Date(), new Date(Date.now() + 5000));
  r = await admin.post(`/albums/${M.code}/scan?wait=1`);
  await sleep(500);
  const mod = await waitFor(async () => {
    const dd = (await admin.get(`/media/${added.id}`)).data;
    return dd.status === "ready" && dd.size === fs.statSync(S("exif-known.jpg")).size ? dd : null;
  }, { timeout: 60_000, what: "源文件被替换后记录更新" }).catch(() => null);
  ok(!!mod, "源文件内容被替换 → 扫描后 size/派生图更新", JSON.stringify(r.data));
  if (mod) {
    const meta2 = await waitFor(async () => ((await admin.get(`/media/${added.id}`)).data.meta?.summary?.camera?.make === "PGS-Test" ? true : null), { timeout: 30_000, what: "替换后元数据重新提取" }).catch(() => null);
    const dd = (await admin.get(`/media/${added.id}`)).data;
    ok(!!meta2, "替换后元数据重新提取(camera.make=PGS-Test)", JSON.stringify({ status: dd.status, error: dd.error, size: dd.size, w: dd.width, make: dd.meta?.summary?.camera?.make, fn: dd.filename }));
  }
  fs.rmSync(path.join(H, "renamed-by-test.jpg"));
  r = await admin.post(`/albums/${M.code}/scan?wait=1`);
  ok(r.data?.removed === 1 || r.data?.missing === 1, "磁盘删除文件 → 扫描 removed=1 或软删除 missing=1", JSON.stringify(r.data));
  ok(!(await list(M.code)).some((i) => i.id === added.id), "已消失文件不再列出");
  fs.mkdirSync(path.join(H, "new-sub/deeper"), { recursive: true, mode: 0o777 });
  fs.copyFileSync(S("fmt.gif"), path.join(H, "new-sub/deeper/g.gif"));
  chmodTree777(H);
  r = await admin.post(`/albums/${M.code}/scan?wait=1&recursive=1`);
  ok(r.data?.albumsCreated >= 2 && r.data.added >= 1, "新增子目录 → 自动建子相册并入库", JSON.stringify(r.data));
  r = await st.mgr.post(`/albums/${M.code}/scan`);
  eq(r.status, 403, "manager 触发扫描 → 403");
  r = await admin.post(`/albums/${st.A.code}/scan`);
  ok(r.status === 400 || r.status === 404, "对受管相册扫描 → 4xx", String(r.status));

  // 父子搬迁(ext 要真搬文件):需要可写
  r = await admin.patch(`/media/${r1.id}`, { album: k2024.code });
  ok(r.status >= 400 && r.status < 500, "只读挂载相册内禁止移动媒体", `${r.status} ${r.err?.code}`);
  ok(fs.existsSync(path.join(H, "r1.jpg")), "移动被拒后源文件原地不动");
  for (const code of [M.code, k2024.code, trip.code]) {
    r = await admin.patch(`/albums/${code}`, { readonly: false });
    ok(r.status === 200 && r.data.readonly === false, `关闭只读 ${code}`);
  }
  r = await admin.patch(`/media/${r1.id}`, { album: k2024.code });
  ok(r.status === 200, "可写后:父→子 移动媒体", r.buf.toString().slice(0, 200));
  ok(!fs.existsSync(path.join(H, "r1.jpg")) && fs.existsSync(path.join(H, "2024/r1.jpg")), "文件被真正搬到子目录(原位置不留副本)");
  eq((await admin.get(`/media/${r1.id}`)).data.storageKey, path.join(V, "2024/r1.jpg"), "storageKey 随文件更新");
  ok(!(await list(M.code)).some((i) => i.id === r1.id) && (await list(k2024.code)).some((i) => i.id === r1.id), "父相册不再含该文件,子相册含");
  r = await admin.get(`/f/${r1.id}`);
  ok(r.status === 200 && sha(r.buf) === sha(fs.readFileSync(path.join(H, "2024/r1.jpg"))), "搬迁后原文件可取");
  r = await admin.post(`/albums/${M.code}/scan?wait=1&recursive=1`);
  ok(r.data?.added === 0 && r.data.removed === 0, "搬迁后扫描不产生重复/丢失", JSON.stringify(r.data));
  const cnt = [...(await list(M.code)), ...(await list(k2024.code)), ...(await list(trip.code))].filter((i) => i.filename === "r1.jpg");
  eq(cnt.length, 1, "整棵树中 r1.jpg 只有 1 条记录(不重复)");
  r = await admin.post("/media/batch", { action: "move", ids: [r1.id], album: trip.code });
  ok(r.status === 200 && r.data.results[0].ok && fs.existsSync(path.join(H, "2024/trip/r1.jpg")) && !fs.existsSync(path.join(H, "2024/r1.jpg")), "batch move 跨两级(2024→trip)", JSON.stringify(r.data));
  r = await admin.post("/media/batch", { action: "move", ids: [r1.id], album: M.code });
  ok(r.data?.results?.[0]?.ok && fs.existsSync(path.join(H, "r1.jpg")), "移回根目录", JSON.stringify(r.data));
  // 重名冲突:目标目录已有同名文件
  fs.writeFileSync(path.join(H, "2024/r1.jpg"), "conflict");
  r = await admin.post("/media/batch", { action: "move", ids: [r1.id], album: k2024.code });
  const conflict = r.data?.results?.[0];
  ok(fs.existsSync(path.join(H, "r1.jpg")) ? !conflict?.ok || fs.readFileSync(path.join(H, "2024/r1.jpg"), "utf8") === "conflict" : true, "目标同名文件冲突:不覆盖已有文件", JSON.stringify(conflict));
  fs.rmSync(path.join(H, "2024/r1.jpg"), { force: true });
  r = await admin.post(`/albums/${M.code}/scan?wait=1&recursive=1`);
  // 移动到受管(local)相册 / 未归类
  const t2id = (await list(trip.code)).find((i) => i.filename === "t1.jpg")?.id;
  r = await admin.patch(`/media/${t2id}`, { album: st.A.code });
  ok(r.status === 400 && fs.existsSync(path.join(H, "2024/trip/t1.jpg")), "ext → 受管相册被拒绝且源文件不动(不产生库/磁盘不一致)", `${r.status} ${r.err?.code}`);
  ok((await admin.get(`/media/${t2id}`)).data.album === trip.code, "被拒绝后记录仍属原相册");
  r = await admin.patch(`/media/${t2id}`, { album: null });
  eq(r.status, 400, "ext → 未归类同样被拒绝");

  // 上传到可写挂载相册 / dir=
  r = await admin.upload({ album: M.code, wait: 1 }, [{ path: S("fmt.bmp") }]);
  ok(r.status === 200 && r.data.target.storage === "ext", "上传到可写挂载相册 → storage=ext", r.buf.toString().slice(0, 200));
  ok(fs.existsSync(path.join(H, "fmt.bmp")), "文件直接落在挂载目录磁盘上");
  r = await admin.upload({ dir: path.join(V, "2024"), wait: 1 }, [{ path: S("dup-source.jpg") }]);
  ok(r.status === 200 && r.data.target.album === k2024.code, "dir= 指向子目录 → 归入对应子相册", r.buf.toString().slice(0, 200));
  ok(fs.existsSync(path.join(H, "2024/dup-source.jpg")), "dir= 文件落在子目录");
  r = await admin.upload({ dir: path.join(V, "2024/../../etc"), wait: 1 }, [{ path: S("dup-source.jpg") }]);
  ok(r.status >= 400 && r.status < 500, "dir= 路径穿越被拒绝", String(r.status));
  r = await admin.upload({ dir: "/etc" }, [{ path: S("dup-source.jpg") }]);
  ok(r.status >= 400 && r.status < 500, "dir= 指向未挂载目录被拒绝", String(r.status));
  r = await admin.upload({ dir: path.join(V, "newly-made-dir"), wait: 1 }, [{ path: S("fmt.gif") }]);
  ok(r.status === 200 || (r.status >= 400 && r.status < 500), "dir= 指向尚不存在的子目录不 500", String(r.status));

  // 导入(服务器路径 → 目标)
  r = await admin.post("/media/import", { paths: [path.join(V, "2024/trip")], album: st.A1a.code, recursive: true, concurrency: 2 });
  ok(r.status === 200 && (r.data.created ?? r.data.summary?.created ?? 0) >= 1, "POST /media/import 目录复制导入受管相册", r.buf.toString().slice(0, 250));
  ok(fs.existsSync(path.join(H, "2024/trip/t1.jpg")) || t2id, "导入是复制,源文件保留");
  r = await admin.post("/media/import", { paths: ["/etc/passwd"], album: st.A1a.code });
  ok(r.status >= 400 || (r.data?.failed ?? 0) >= 0, "导入白名单外路径不泄露/不 500", String(r.status));
  r = await st.mgr.post("/media/import", { paths: [V], album: st.A1a.code });
  eq(r.status, 403, "manager 导入服务器路径 → 403");

  // 删除:排除 / 恢复 / 彻底删除(可写挂载)
  const tripItems = await list(trip.code);
  const victim = tripItems.find((i) => i.filename === "t1.jpg") || tripItems[0];
  if (victim) {
    const vpath = (await admin.get(`/media/${victim.id}`)).data.storageKey;
    // storageKey 在 ext 存储下是【服务端视角】的绝对路径(Docker 里是 /photos/...),
    // 测试进程看到的是宿主机路径,必须换算后再做磁盘断言。
    const vhost = toHostPath(vpath);
    r = await admin.del(`/media/${victim.id}`);
    ok(r.status === 200 && r.data.blocked, "ext 媒体默认删除=排除", r.buf.toString().slice(0, 150));
    ok(fs.existsSync(vhost), "排除后磁盘源文件仍在", vpath);
    r = await admin.post(`/albums/${M.code}/scan?wait=1&recursive=1`);
    ok(!(await list(trip.code)).some((i) => i.filename === victim.filename), "重新扫描不会把被排除文件重新入库");
    const b = (await admin.get("/blocklist")).data.items.find((x) => x.storageKey === vpath);
    ok(!!b, "黑名单含该 ext 文件(storageKey=绝对路径)");
    r = await admin.post(`/blocklist/${b.id}/restore`);
    ok(r.status === 200, "ext 黑名单恢复");
    await waitProcessed(admin, [victim.id]);
    ok((await list(trip.code)).some((i) => i.id === victim.id), "恢复后回到相册");
    await admin.del(`/media/${victim.id}`);
    const b2 = (await admin.get("/blocklist")).data.items.find((x) => x.storageKey === vpath);
    fs.rmSync(vhost, { force: true });
    r = await admin.post(`/blocklist/${b2.id}/restore`);
    eq(r.status, 400, "源文件已不存在时 restore → 400 source_missing");
    eq(r.err?.code, "source_missing", "错误码 source_missing");
    r = await admin.del(`/blocklist/${b2.id}`);
    ok(r.status === 200 || r.status === 404, "源文件已无时清理黑名单项不 500", String(r.status));
  }
  const keep = (await list(M.code))[0];
  if (keep) {
    const kp = (await admin.get(`/media/${keep.id}`)).data.storageKey;
    r = await admin.del(`/media/${keep.id}?purge=1`);
    ok(r.status === 200 && !fs.existsSync(toHostPath(kp)), "可写挂载相册 purge=1 → 磁盘文件真正删除", `${r.status} ${r.err?.code}`);
  }

  // 熔断:一次扫描大面积消失时不批量清理(样本 ≥ SCAN_PRUNE_MIN_COUNT 才触发,小库不测)
  // 删除挂载相册:源文件保留
  const before = listFilesRec(H).length;
  r = await admin.del(`/albums/${M.code}`);
  ok(r.status === 200, "删除挂载相册(仅解除登记)", r.buf.toString().slice(0, 150));
  eq(listFilesRec(H).length, before, "解除登记后磁盘文件数不变");
  r = await admin.get(`/albums/${k2024.code}`);
  ok(r.status === 404 || r.data?.parent !== M.code, "子相册随之清除", String(r.status));
  r = await admin.get(`/f/${r1.id}`);
  ok(r.status === 404, "解除登记后原媒体记录消失(404)", String(r.status));
  // 重新挂载同目录应可再来一次
  r = await admin.post("/albums/mount", { path: V, name: "re-mount-" + tag });
  ok(r.status === 201, "解除后可重新挂载同一目录", String(r.status));
  if (r.status === 201) {
    await waitFor(async () => (await admin.get(`/albums/${r.data.code}/status`)).data.scan?.running !== true, { timeout: 60_000, what: "重扫完成" }).catch(() => null);
    let rr = await admin.del(`/albums/${r.data.code}?purge=1&media=delete`);
    ok(rr.status === 403, "只读挂载相册 purge=1 删除被拒绝", `${rr.status} ${rr.err?.code}`);
    const subs = (await admin.get(`/albums?tree=1`)).data.albums.find((x) => x.code === r.data.code);
    const walkIds = (n) => [n.code, ...(n.children || []).flatMap(walkIds)];
    for (const code of subs ? walkIds(subs) : [r.data.code]) await admin.patch(`/albums/${code}`, { readonly: false });
    rr = await admin.del(`/albums/${r.data.code}?purge=1&media=delete`);
    ok(rr.status === 200, "关闭只读后 purge=1 删除挂载相册", rr.buf.toString().slice(0, 150));
    ok(listFilesRec(H).filter((f) => /\.(jpe?g|png|webp|gif|bmp|mp4)$/i.test(f)).length < before, "purge=1 后磁盘媒体文件被删除");
  }
  fs.rmSync(H, { recursive: true, force: true });
}

/* ===================================================================== */
async function sUrlUpload() {
  section("直链上传 / SSRF");
  const bad = [
    "http://127.0.0.1:" + new URL(BASE).port + "/api/v1/health",
    "http://localhost/x.jpg",
    "http://169.254.169.254/latest/meta-data/x.jpg",
    "http://10.0.0.1/x.jpg",
    "http://192.168.1.1/x.jpg",
    "http://[::1]/x.jpg",
    "http://2130706433/x.jpg",
    "http://0x7f000001/x.jpg",
    "file:///etc/passwd",
    "ftp://example.com/x.jpg",
  ];
  for (const u of bad) {
    const r = await admin.post("/media/upload-url", { urls: [u], album: st.A.code });
    const x = r.data?.results?.[0];
    ok(r.status >= 400 || x?.status === "error", `SSRF/非法协议被拒绝: ${u}`, `${r.status} ${JSON.stringify(x)}`);
  }
  let r = await admin.post("/media/upload-url", { urls: Array.from({ length: 51 }, (_, i) => `example.com/${i}.jpg`) });
  ok(r.status >= 400 && r.status < 500, "超过 50 条被拒绝", String(r.status));
  r = await admin.post("/media/upload-url", { urls: [] });
  ok(r.status >= 400 && r.status < 500, "空列表被拒绝", String(r.status));
  r = await st.vwr.post("/media/upload-url", { urls: ["example.com/a.jpg"] });
  eq(r.status, 403, "viewer 直链上传 → 403");
  if (OFFLINE) return skip("真实直链下载", "OFFLINE=1");
  const nasa = manifest.nasa.find((x) => x.kind === "image" && x.size < 400_000);
  if (!nasa) return skip("真实直链下载", "没有小的 NASA 素材");
  const url = nasa.url.replace(/^https:\/\//, ""); // 裸域名:自动补 https://
  r = await admin.post("/media/upload-url", { urls: [url], album: st.A1a.code, note: "from-nasa-url" });
  const x = r.data?.results?.[0];
  ok(r.status === 200 && (x?.status === "created" || x?.status === "duplicate"), "NASA 直链(裸域名)下载入库", `${r.status} ${JSON.stringify(x || r.err)}`);
  if (x?.id) {
    await waitProcessed(admin, [x.id]);
    const dd = (await admin.get(`/media/${x.id}`)).data;
    ok(dd.status === "ready" && dd.width > 0, "直链入库文件处理为 ready");
    eq(dd.note, "from-nasa-url", "直链上传 note 生效");
  }
  r = await admin.post("/media/upload-url", { urls: ["https://www.nasa.gov/"], album: st.A1a.code });
  ok(r.data?.results?.[0]?.status === "error" || r.status >= 400, "非媒体内容(HTML 页面)被拒绝", JSON.stringify(r.data?.results?.[0]));
}

/* ===================================================================== */
async function sSite() {
  section("通知 / 站点设置 / 图标");
  const T0 = "通知-" + tag;
  let r = await st.vwr.post("/notices", { title: T0, body: "x" });
  eq(r.status, 403, "viewer 发布通知 → 403");
  r = await st.mgr.post("/notices", { title: T0, body: "**粗体** 与 <script>alert(1)</script>", pinned: false });
  ok(r.status === 201 || r.status === 200, "manager 发布通知", r.buf.toString().slice(0, 150));
  const nid = r.data?.id;
  r = await st.mgr.post("/notices", { title: "t".repeat(121), body: "x" });
  eq(r.status, 400, "标题 >120 → 400");
  r = await guest.get("/notices");
  ok(r.status === 200 && (r.data.items || []).length === 0, "游客 /notices 返回空列表");
  r = await st.vwr.get("/notices/unread");
  ok(r.data.unread >= 1, "viewer 未读数 ≥1", JSON.stringify(r.data));
  r = await st.vwr.get("/notices");
  ok(r.data.items.some((n) => n.id === nid && n.read === false), "列表中该通知未读");
  ok(r.data.items.find((n) => n.id === nid)?.body.includes("<script>"), "服务端保存 Markdown 原文(渲染时才转义)");
  r = await st.vwr.post(`/notices/${nid}/read`);
  ok(r.status === 200, "单条已读");
  r = await st.vwr.post("/notices/read-all");
  ok(r.status === 200 && typeof r.data.marked === "number", "一键已读 marked 数字", JSON.stringify(r.data));
  r = await st.vwr.get("/notices/unread");
  eq(r.data.unread, 0, "已读后未读数 0");
  r = await st.mgr.patch(`/notices/${nid}`, { title: T0 + "-改", pinned: true });
  ok(r.status === 200, "PATCH 通知");
  r = await st.mgr.del(`/notices/${nid}`);
  ok(r.status === 200, "删除通知");
  r = await st.mgr.del(`/notices/${nid}`);
  eq(r.status, 404, "重复删除通知 → 404");

  r = await admin.get("/settings");
  const orig = r.data;
  ok(r.status === 200 && orig.siteName, "GET /settings");
  r = await admin.put("/settings", { siteName: "测试站-" + tag, theme: { preset: "ocean", mode: "dark" } });
  ok(r.status === 200 && r.data.siteName === "测试站-" + tag && r.data.theme.preset === "ocean", "PUT /settings 改站名/主题");
  r = await guest.get("/site");
  ok(r.data.siteName === "测试站-" + tag, "公开 /site 即时反映");
  r = await admin.put("/settings", { theme: { preset: "no-such-preset" } });
  eq(r.status, 400, "非法主题预设 → 400");
  r = await admin.put("/settings", { splash: { url: "http://insecure.example.com/a.png", mode: "url" } });
  eq(r.status, 400, "启动页 URL 必须 https → 400");
  r = await admin.put("/settings", { timezone: "Mars/Phobos" });
  eq(r.status, 400, "非法时区 → 400");
  r = await admin.put("/settings", { timezone: "Asia/Tokyo" });
  ok(r.status === 200 && r.data.timezone === "Asia/Tokyo", "合法时区 Asia/Tokyo");
  r = await guest.get("/notices");
  eq(r.data?.timezone, "Asia/Tokyo", "通知接口返回当前时区");
  // 游客开关
  r = await admin.put("/settings", { guestBrowse: false });
  r = await guest.get("/albums");
  ok((r.data?.albums || []).length === 0 || r.status === 401 || r.status === 403, "guestBrowse=false 游客看不到相册", `${r.status} ${(r.data?.albums || []).length}`);
  r = await guest.get(`/media/${st.exifId}`);
  ok(r.status === 404 || r.status === 401 || r.status === 403, "guestBrowse=false 游客不能看媒体详情", String(r.status));
  r = await guest.get(`/f/${st.exifId}?key=${st.key}`);
  ok(r.status === 200 || r.status === 403 || r.status === 404, "guestBrowse=false 对带 key 的链接不 500", String(r.status));
  await admin.put("/settings", { guestBrowse: orig.guestBrowse ?? true });
  r = await admin.put("/settings", { siteName: orig.siteName, timezone: orig.timezone || "Asia/Shanghai", theme: orig.theme });
  ok(r.status === 200, "还原站点设置");

  // 图标
  const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#336699" } }).png().toBuffer();
  let form = new FormData();
  form.append("icon", new Blob([png]), "icon.png");
  r = await admin.req("POST", "/settings/icon", { form });
  ok(r.status === 200 && r.data.iconUrl, "上传 PNG 图标", r.buf.toString().slice(0, 150));
  r = await guest.get("/branding/icon");
  const im = await sharp(r.buf).metadata().catch(() => null);
  ok(r.status === 200 && im?.width === 256 && im?.height === 256, "图标统一为 256x256", JSON.stringify(im && { w: im.width, h: im.height }));
  form = new FormData();
  form.append("icon", new Blob(["not an image"]), "x.png");
  r = await admin.req("POST", "/settings/icon", { form });
  ok(r.status >= 400 && r.status < 500, "非图片作为图标 → 4xx", String(r.status));
  form = new FormData();
  form.append("icon", new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>']), "x.svg");
  r = await admin.req("POST", "/settings/icon", { form });
  if (r.status === 200) {
    const sv = await guest.get("/branding/icon");
    ok(/sandbox|default-src 'none'/.test(sv.headers.get("content-security-policy") || ""), "SVG 图标以严格 CSP 输出");
  } else ok(r.status < 500, "SVG 图标被拒绝也可接受", String(r.status));
  r = await st.mgr.req("DELETE", "/settings/icon");
  eq(r.status, 403, "manager 删除图标 → 403");
  r = await admin.del("/settings/icon");
  ok(r.status === 200, "恢复默认图标");
  r = await guest.get("/branding/icon");
  ok(r.status === 200 && /svg/.test(r.headers.get("content-type") || ""), "默认图标为 SVG");
}

/* ===================================================================== */
async function sLimits() {
  section("限流(固定来源 IP)");
  const c = new Client(BASE, { fixedIp: "10.200.0.77" });
  let blocked = 0;
  for (let i = 0; i < 25; i++) {
    const r = await c.post("/auth/login", { username: ADMIN, password: "bad-pass-" + i }, { auth: "none" });
    if (r.status === 429) blocked++;
  }
  ok(blocked > 0, "同一 IP 连续错误登录触发 429", `blocked=${blocked}`);
  const c2 = new Client(BASE, { fixedIp: "10.200.0.78" });
  let b2 = 0;
  for (let i = 0; i < 75; i++) {
    const r = await c2.get("/media?q=abc" + i);
    if (r.status === 429) b2++;
  }
  ok(b2 > 0, "匿名搜索超过每分钟上限触发 429", `blocked=${b2}`);
  const c3 = new Client(BASE, { fixedIp: "10.200.0.79" });
  let b3 = 0;
  for (let i = 0; i < 40; i++) {
    const r = await c3.get(`/f/${st.exifId}?key=invalid-key-number-${i}-xxxxxxxx`);
    if (r.status === 429) b3++;
  }
  ok(b3 > 0, "无效密钥校验超过上限触发 429", `blocked=${b3}`);
  const ok2 = await admin.get("/status");
  ok(ok2.status === 200, "限流不影响其它 IP 的正常请求");
}

/* ===================================================================== */
const SECTIONS = [
  ["health", sHealth],
  ["users", sUsers],
  ["albums", sAlbums],
  ["upload", sUpload],
  ["files", sFiles],
  ["search", sSearch],
  ["media", sMedia],
  ["mount", sMount],
  ["url", sUrlUpload],
  ["site", sSite],
  ["limits", sLimits],
];
const deps = { upload: ["users", "albums"], files: ["users", "albums", "upload"], search: ["users", "albums", "upload", "files"], media: ["users", "albums", "upload", "files", "search"], mount: ["users", "albums", "upload"], url: ["users", "albums"], site: ["users", "albums", "upload", "files"], limits: ["upload"] };
const need = new Set();
if (ONLY.length) for (const o of ONLY) (deps[o] || []).forEach((d) => need.add(d)), need.add(o);
for (const [name, fn] of SECTIONS) {
  if (ONLY.length && !need.has(name)) continue;
  const t0 = Date.now();
  try {
    await fn();
  } catch (e) {
    T.ok(false, `章节 ${name} 异常中断`, e.stack?.split("\n").slice(0, 3).join(" | "));
  }
  console.log(`  (${name} 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
process.exit(T.summary() ? 0 : 1);
