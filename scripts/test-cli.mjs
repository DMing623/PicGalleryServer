#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 命令行(cli/pgs.mjs)黑盒测试:对【正在运行】的服务逐条执行子命令,校验退出码、输出与服务端状态。
 * 覆盖:参数错误 / 凭据(令牌、环境变量、stdin、错误密码) / login·logout / status / album 全套 / upload(目录、递归、
 *       dry-run、幂等跳过、重复、note、并发、--dir) / import / media 全套 / blocklist / key / user / settings / reprocess。
 *
 * 用法:BASE=http://127.0.0.1:3100 ADMIN_PASSWORD=test-pass-123 SAMPLES_DIR=/tmp/pgs-samples \
 *       MOUNT_HOST_DIR=/tmp/pgs-mnt MOUNT_SERVER_DIR=/tmp/pgs-mnt node scripts/test-cli.mjs
 * (不设 MOUNT_HOST_DIR 时跳过 mount / --dir / import / 黑名单相关项)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client, ROOT, createSuite, waitFor } from "./lib/harness.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:3100";
const PASS = process.env.ADMIN_PASSWORD || "test-pass-123";
const SAMPLES = process.env.SAMPLES_DIR || "/tmp/pgs-samples";
const MNT_HOST = process.env.MOUNT_HOST_DIR || "";
const MNT_SRV = process.env.MOUNT_SERVER_DIR || MNT_HOST;

const T = createSuite("CLI " + (process.env.TEST_LABEL || ""));
const { ok, eq, section, skip } = T;
const HOME = fs.mkdtempSync(path.join(process.env.TEST_TMP || "/tmp", "pgs-cli-home-"));
const CLI = path.join(ROOT, "cli/pgs.mjs");
const api = new Client(BASE, { user: "admin", password: PASS });

function pgs(args, { input, env = {}, noAuth = false } = {}) {
  const e = { ...process.env, HOME, PGS_URL: BASE, ...env };
  if (noAuth) {
    delete e.PGS_PASSWORD;
    delete e.PGS_TOKEN;
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: e, input, timeout: 180_000 });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}
const json = (r) => {
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

/* ---------- 基础 ---------- */
section("帮助 / 参数校验 / 凭据");
let r = pgs(["help"], { noAuth: true });
ok(r.code === 0 && /album mount/.test(r.out) && /upload/.test(r.out), "help 输出用法");
r = pgs(["--version"], { noAuth: true });
const pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
ok(r.code === 0 && r.out.includes(pkgVer), `--version 与 package.json 版本一致(${pkgVer})`, r.out.trim());
r = pgs(["version"], { noAuth: true });
ok(r.out.includes(pkgVer), "version 子命令版本一致", r.out.trim());
r = pgs(["--no-such-flag"], { noAuth: true });
eq(r.code, 2, "未知参数 → 退出码 2");
r = pgs(["status"], { noAuth: true });
eq(r.code, 2, "无凭据 → 退出码 2 并提示 login");
r = pgs(["status"], { env: { PGS_PASSWORD: "wrong-password" } });
ok(r.code !== 0 && /密码|错误|unauthorized|401|invalid/i.test(r.err + r.out), "错误密码 → 非 0 退出码", r.err.trim().slice(0, 100));
r = pgs(["login", "--password-stdin"], { input: "wrong-password\n", noAuth: true });
ok(r.code !== 0, "login 错误密码失败");
r = pgs(["login", "--password-stdin"], { input: PASS + "\n", noAuth: true });
ok(r.code === 0 && /已登录/.test(r.out), "login --password-stdin 成功");
const credFile = path.join(HOME, ".config/pgs/credentials.json");
ok(fs.existsSync(credFile) && (fs.statSync(credFile).mode & 0o777) === 0o600, "令牌文件权限 0600");
r = pgs(["status"], { noAuth: true });
ok(r.code === 0 && json(r)?.version, "使用已保存令牌执行 status(无需密码)");
r = pgs(["status", "queue"], { noAuth: true });
ok(r.code === 0 && typeof json(r)?.concurrency === "number", "status queue");
// issue #1:本地已有凭据文件时,login 仍须能用密码重新登录(此前恒报"缺少密码")
r = pgs(["login", "--password-stdin"], { input: PASS + "\n", noAuth: true });
ok(r.code === 0 && /已登录/.test(r.out), "已有凭据文件时 login 可重新登录", (r.err || r.out).trim().slice(0, 100));
r = pgs(["status"], { noAuth: true, env: { PGS_PASSWORD: PASS } });
ok(r.code === 0, "PGS_PASSWORD 环境变量 + Basic 也可用(令牌优先)");

/* ---------- 相册 ---------- */
section("album 子命令");
r = pgs(["album", "create", "CLI公开-" + Date.now(), "--public"], { noAuth: true });
const A = json(r);
ok(r.code === 0 && A?.visibility === "public" && /^alb_/.test(A.code), "album create --public");
r = pgs(["album", "create", "CLI子相册", "--parent", A.code], { noAuth: true });
const A1 = json(r);
ok(r.code === 0 && A1?.parent === A.code && A1.visibility === "private", "album create --parent(默认私有)");
r = pgs(["album", "list", "--tree"], { noAuth: true });
ok(r.code === 0 && r.out.includes(A.code) && r.out.includes(A1.code), "album list --tree 缩进展示嵌套");
r = pgs(["album", "list", "--parent", A.code, "--json"], { noAuth: true });
ok(r.code === 0 && /CLI子相册/.test(r.out), "album list --parent");
r = pgs(["album", "info", A.code], { noAuth: true });
eq(json(r)?.code, A.code, "album info");
r = pgs(["album", "status", A.code], { noAuth: true });
ok(r.code === 0 && json(r)?.descendants >= 1, "album status");
r = pgs(["album", "set", A1.code, "--name", "改名后", "--public", "--cascade"], { noAuth: true });
ok(r.code === 0 && json(r)?.name === "改名后" && json(r)?.visibility === "public", "album set --name --public");
r = pgs(["album", "set", A1.code, "--parent", "root"], { noAuth: true });
ok(r.code === 0 && json(r)?.parent === null, "album set --parent root 移到顶层");
r = pgs(["album", "set", A1.code, "--parent", A.code], { noAuth: true });
ok(r.code === 0 && json(r)?.parent === A.code, "album set --parent 代码");
r = pgs(["album", "info", "alb_nonexist"], { noAuth: true });
ok(r.code !== 0, "不存在的相册 → 非 0 退出码");

/* ---------- 上传 ---------- */
section("upload(目录/递归/dry-run/幂等/并发)");
const upDir = fs.mkdtempSync(path.join(process.env.TEST_TMP || "/tmp", "pgs-cli-up-"));
fs.mkdirSync(path.join(upDir, "sub"));
const copy = (src, rel) => fs.copyFileSync(path.join(SAMPLES, src), path.join(upDir, rel));
copy("synth/exif-known.jpg", "a.jpg");
copy("synth/ai-a1111.png", "b.png");
copy("synth/fmt.webp", "sub/c.webp");
copy("synth/fmt.gif", "sub/d.gif");
copy("synth/note.txt", "ignore.txt");
copy("synth/dup-source.jpg", ".hidden.jpg");
try {
  fs.symlinkSync("/etc/hostname", path.join(upDir, "link.jpg"));
} catch {
  /* ignore */
}
r = pgs(["upload", upDir, "-r", "--dry-run", "--album", A.code], { noAuth: true });
ok(r.code === 0 && /将上传 4 个文件/.test(r.out), "dry-run:只统计 4 个媒体(忽略 txt/隐藏文件/符号链接)", r.out.trim());
r = pgs(["upload", upDir, "--album", A.code, "--dry-run"], { noAuth: true });
ok(/将上传 2 个文件/.test(r.out), "不加 -r 只取顶层 2 个文件", r.out.trim());
r = pgs(["upload", upDir, "-r", "--album", A.code, "-c", "3", "--note", "cli-note"], { noAuth: true });
ok(r.code === 0 && /成功 4, 重复 0, 失败 0/.test(r.out), "upload -r -c 3 成功 4 个", r.out.trim().split("\n").pop());
r = pgs(["upload", upDir, "-r", "--album", A.code], { noAuth: true });
ok(r.code === 0 && /全部文件已存在/.test(r.out), "再次上传:按 hash 幂等跳过", r.out.trim());
r = pgs(["upload", upDir, "-r", "--album", A.code, "--duplicate", "keep"], { noAuth: true });
ok(r.code === 0 && /成功 4/.test(r.out), "--duplicate keep 重复也入库", r.out.trim().split("\n").pop());
r = pgs(["upload", path.join(upDir, "ignore.txt")], { noAuth: true });
ok(r.code !== 0, "只有非媒体文件 → 报错退出");
r = pgs(["upload", "/no/such/path"], { noAuth: true });
ok(r.code !== 0, "路径不存在 → 非 0");
r = pgs(["upload"], { noAuth: true });
ok(r.code !== 0, "缺少参数 → 非 0");
r = pgs(["upload", path.join(upDir, "a.jpg"), "--album", "alb_nonexist"], { noAuth: true });
ok(r.code !== 0 || /✗/.test(r.out), "上传到不存在的相册 → 失败", r.out.trim().slice(0, 120));
r = pgs(["upload", path.join(upDir, "a.jpg"), "--storage", "s3"], { noAuth: true });
ok(r.code !== 0 || /✗/.test(r.out), "未配置 S3 → storage=s3 失败");

section("media 子命令");
r = pgs(["media", "list", "--album", A.code, "--all", "--json"], { noAuth: true });
const items = json(r) || [];
ok(r.code === 0 && items.length === 8, "media list --all --json 共 8 条(4 + keep 4)", String(items.length));
await waitFor(async () => (await api.get(`/albums/${A.code}/status`)).data.pending === 0, { timeout: 90_000, what: "CLI 上传处理完" }).catch(() => null);
r = pgs(["media", "list", "--album", A.code, "-q", "b.png", "--kind", "image", "--limit", "1"], { noAuth: true });
ok(r.code === 0 && /b\.png/.test(r.out), "media list -q --kind --limit(表格输出)");
const exifItem = items.find((i) => i.filename === "a.jpg");
r = pgs(["media", "get", exifItem.id], { noAuth: true });
ok(json(r)?.note === "cli-note", "上传 --note 生效", json(r)?.note);
r = pgs(["media", "get", exifItem.id, "--links"], { noAuth: true });
ok(json(r)?.file?.includes(`/f/${exifItem.id}`) && json(r)?.markdown, "media get --links");
r = pgs(["media", "note", exifItem.id, "新", "备", "注"], { noAuth: true });
ok(r.code === 0 && json(r)?.note === "新 备 注" || (await api.get(`/media/${exifItem.id}`)).data.note === "新 备 注", "media note 多词合并");
r = pgs(["media", "move", exifItem.id, "--album", A1.code], { noAuth: true });
ok(r.code === 0 && (await api.get(`/media/${exifItem.id}`)).data.album === A1.code, "media move --album");
r = pgs(["media", "move", exifItem.id, "--album", "none"], { noAuth: true });
ok(r.code === 0 && (await api.get(`/media/${exifItem.id}`)).data.album === null, "media move --album none → 未归类");
r = pgs(["media", "reprocess", exifItem.id], { noAuth: true });
ok(r.code === 0, "media reprocess");
r = pgs(["reprocess"], { noAuth: true });
ok(r.code === 0, "reprocess");
r = pgs(["regenerate-derived"], { noAuth: true });
ok(r.code === 0, "regenerate-derived");
r = pgs(["media", "rm", exifItem.id], { noAuth: true });
ok(r.code === 0 && json(r)?.blocked === true, "media rm → 排除(blocked)");
r = pgs(["blocklist", "list", "--json"], { noAuth: true });
const bl = (json(r) || []).find((b) => b.filename === "a.jpg");
ok(r.code === 0 && !!bl, "blocklist list --json 含 a.jpg");
r = pgs(["blocklist", "list"], { noAuth: true });
ok(r.code === 0 && /a\.jpg/.test(r.out), "blocklist list 表格");
r = pgs(["blocklist", "restore", bl.id], { noAuth: true });
ok(r.code === 0, "blocklist restore");
r = pgs(["media", "rm", exifItem.id, "--purge"], { noAuth: true });
ok(r.code === 0 && json(r)?.purge === true, "media rm --purge 物理删除");
r = pgs(["media", "rm", exifItem.id], { noAuth: true });
ok(r.code !== 0, "重复删除 → 非 0");
r = pgs(["media", "get", "nonexistent"], { noAuth: true });
ok(r.code !== 0, "media get 不存在 → 非 0");

/* ---------- 挂载 / 导入 ---------- */
section("album mount / scan / import / --dir");
if (!MNT_HOST) skip("mount/import", "未设置 MOUNT_HOST_DIR");
else {
  try { process.umask(0); } catch {}
  const H = path.join(MNT_HOST, "cli-lib-" + Date.now());
  const V = path.join(MNT_SRV, path.basename(H));
  fs.mkdirSync(path.join(H, "inner"), { recursive: true, mode: 0o777 });
  try { fs.chmodSync(H, 0o777); fs.chmodSync(path.join(H, "inner"), 0o777); } catch {}
  fs.copyFileSync(path.join(SAMPLES, "synth/fmt.webp"), path.join(H, "top.webp"));
  fs.copyFileSync(path.join(SAMPLES, "synth/fmt.gif"), path.join(H, "inner/in.gif"));
  r = pgs(["album", "mount", V, "--name", "CLI挂载", "--public"], { noAuth: true });
  const M = json(r);
  ok(r.code === 0 && /^dir_/.test(M?.code) && M.readonly === true, "album mount 默认只读", r.err.trim().slice(0, 150));
  await waitFor(async () => (await api.get(`/albums/${M.code}/status`)).data.descendants >= 1, { timeout: 60_000, what: "挂载扫描" });
  r = pgs(["album", "scan", M.code, "--wait"], { noAuth: true });
  ok(r.code === 0 && json(r)?.added === 0, "album scan --wait 幂等", r.out.trim().slice(0, 150));
  fs.copyFileSync(path.join(SAMPLES, "synth/fmt.tif"), path.join(H, "new.tif"));
  r = pgs(["album", "scan", M.code, "--wait"], { noAuth: true });
  ok(json(r)?.added === 1, "磁盘新增文件后 scan --wait → added=1");
  r = pgs(["upload", path.join(upDir, "a.jpg"), "--album", M.code], { noAuth: true });
  ok(r.code !== 0 || /✗/.test(r.out), "upload 到只读挂载相册被拒");
  r = pgs(["upload", path.join(upDir, "a.jpg"), "--dir", V], { noAuth: true });
  ok(r.code !== 0 || /✗/.test(r.out), "upload --dir 指向只读挂载目录被拒");
  r = pgs(["album", "set", M.code, "--no-readonly"], { noAuth: true });
  ok(r.code === 0 && json(r)?.readonly === false, "album set --no-readonly");
  r = pgs(["upload", path.join(upDir, "a.jpg"), "--dir", V], { noAuth: true });
  ok(r.code === 0 && fs.existsSync(path.join(H, "a.jpg")), "关闭只读后 upload --dir 落到挂载目录磁盘");
  r = pgs(["import", path.join(V, "top.webp"), "--album", A.code], { noAuth: true });
  ok(r.code === 0 && fs.existsSync(path.join(H, "top.webp")), "import 复制导入(源文件保留)", r.out.trim().slice(0, 120));
  r = pgs(["album", "set", M.code, "--readonly"], { noAuth: true });
  ok(r.code === 0 && json(r)?.readonly === true, "album set --readonly");
  r = pgs(["album", "rm", M.code], { noAuth: true });
  ok(r.code === 0 && fs.existsSync(path.join(H, "top.webp")), "album rm 挂载相册只解除登记,磁盘文件保留");
  try { fs.rmSync(H, { recursive: true, force: true }); } catch {}
}

/* ---------- key / user / settings ---------- */
section("key / user / settings");
const keyPlain = "cli-key-" + Date.now() + "-abcdefgh";
r = pgs(["key", "set", "--key", keyPlain, "--ttl", "24h", "--label", "cli"], { noAuth: true });
ok(r.code === 0 && json(r)?.expiresAt, "key set --ttl 24h");
r = pgs(["key", "set", "--ttl", "never"], { noAuth: true });
const autoKey = json(r);
ok(r.code === 0 && autoKey?.key?.length >= 16, "key set 自动生成密钥");
r = pgs(["key", "list"], { noAuth: true });
ok(r.code === 0 && !r.out.includes(keyPlain), "key list 不泄露明文");
const klist = (await api.get("/keys")).data.keys;
const krow = klist.find((k) => k.label === "cli");
r = pgs(["key", "rm", krow.id], { noAuth: true });
ok(r.code === 0, "key rm <id>");
r = pgs(["key", "rm", "--key", autoKey.key], { noAuth: true });
ok(r.code === 0, "key rm --key 明文");
r = pgs(["key", "set", "--ttl", "bogus"], { noAuth: true });
ok(r.code !== 0, "非法 ttl → 非 0");

const uname = "cliu_" + Date.now().toString(36).slice(-6);
r = pgs(["user", "add", uname, "--pw", "password-123", "--role", "uploader"], { noAuth: true });
ok(r.code === 0, "user add");
r = pgs(["user", "list"], { noAuth: true });
ok(r.out.includes(uname), "user list 含新用户");
r = pgs(["user", "set", uname, "--role", "viewer", "--disable"], { noAuth: true });
ok(r.code === 0, "user set --role --disable");
let lr = await api.req("POST", "/auth/login", { json: { username: uname, password: "password-123" }, auth: "none" });
ok(lr.status === 401 || lr.status === 403, "被禁用后无法登录");
r = pgs(["user", "set", uname, "--enable", "--pw", "password-456"], { noAuth: true });
lr = await api.req("POST", "/auth/login", { json: { username: uname, password: "password-456" }, auth: "none" });
ok(lr.status === 200 && lr.data?.user?.role === "viewer", "启用并改密码后可登录且角色为 viewer");
r = pgs(["user", "add", uname, "--pw", "password-123"], { noAuth: true });
ok(r.code !== 0, "重复用户名 → 非 0");
r = pgs(["user", "add", "bad name!", "--pw", "password-123"], { noAuth: true });
ok(r.code !== 0, "非法用户名 → 非 0");
r = pgs(["user", "rm", uname], { noAuth: true });
ok(r.code === 0, "user rm");
r = pgs(["user", "rm", "admin"], { noAuth: true });
ok(r.code !== 0, "不能删除 env 管理员");

r = pgs(["settings", "get"], { noAuth: true });
const s0 = json(r);
ok(r.code === 0 && s0?.siteName, "settings get");
r = pgs(["settings", "set", JSON.stringify({ siteName: "CLI站点", timezone: "Asia/Tokyo" })], { noAuth: true });
ok(r.code === 0 && json(r)?.siteName === "CLI站点" && json(r)?.timezone === "Asia/Tokyo", "settings set JSON 补丁");
r = pgs(["settings", "set", "{bad json"], { noAuth: true });
ok(r.code !== 0, "settings set 非法 JSON → 非 0");
r = pgs(["settings", "set", JSON.stringify({ theme: { preset: "nope" } })], { noAuth: true });
ok(r.code !== 0, "settings set 非法主题 → 非 0");
pgs(["settings", "set", JSON.stringify({ siteName: s0.siteName, timezone: s0.timezone })], { noAuth: true });
const iconSrc = path.join(upDir, "icon.png");
fs.writeFileSync(iconSrc, fs.readFileSync(path.join(SAMPLES, "synth/fmt.webp")));
r = pgs(["settings", "icon", iconSrc], { noAuth: true });
ok(r.code === 0 || r.code !== 0, "settings icon(webp 作图标,不要求特定结果但不得崩溃)", `code=${r.code} ${r.err.trim().slice(0, 100)}`);
ok(!/TypeError|ReferenceError|at .*\.mjs/.test(r.err), "settings icon 无未处理异常堆栈", r.err.slice(0, 200));
r = pgs(["settings", "icon-reset"], { noAuth: true });
ok(r.code === 0, "settings icon-reset");
r = pgs(["bogus-command"], { noAuth: true });
ok(r.code !== 0, "未知命令 → 非 0");
r = pgs(["album", "bogus"], { noAuth: true });
ok(r.code !== 0, "未知 album 子命令 → 非 0");

section("清理");
r = pgs(["album", "rm", A.code, "--delete-media"], { noAuth: true });
ok(r.code === 0, "album rm --delete-media(含子相册)");
r = pgs(["logout"], { noAuth: true });
ok(r.code === 0 && !fs.existsSync(credFile), "logout 删除令牌文件");
fs.rmSync(upDir, { recursive: true, force: true });
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(T.summary() ? 0 : 1);
