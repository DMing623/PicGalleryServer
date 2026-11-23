#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * PicGalleryServer 命令行管理工具(零依赖,需要 Node 20+)。
 *
 * 认证(按优先级):
 *   1. PGS_TOKEN / --token:个人登录令牌(Bearer,推荐;用 `pgs login` 获取并保存)
 *   2. PGS_USER + PGS_PASSWORD / --password / --password-stdin / PGS_PASSWORD_FILE(HTTP Basic)
 * 密码走命令行参数会出现在 ps 与 shell 历史里,建议用 --password-stdin 或环境变量。
 * 用法见 `node cli/pgs.mjs help`。
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const VERSION = "1.3.6";

/* ---------- 参数解析(util.parseArgs:未知参数直接报错,支持 --k=v 与 -- 结束符) ---------- */

const OPTIONS = {
  url: { type: "string" },
  user: { type: "string" },
  password: { type: "string" },
  "password-stdin": { type: "boolean" },
  token: { type: "string" },
  album: { type: "string" },
  dir: { type: "string" },
  storage: { type: "string" },
  concurrency: { type: "string", short: "c" },
  q: { type: "string", short: "q" },
  recursive: { type: "boolean", short: "r" },
  "no-recursive": { type: "boolean" },
  readonly: { type: "boolean" },
  "no-readonly": { type: "boolean" },
  public: { type: "boolean" },
  private: { type: "boolean" },
  cascade: { type: "boolean" },
  purge: { type: "boolean" },
  "delete-media": { type: "boolean" },
  json: { type: "boolean" },
  wait: { type: "boolean" },
  tree: { type: "boolean" },
  links: { type: "boolean" },
  watch: { type: "boolean" },
  disable: { type: "boolean" },
  enable: { type: "boolean" },
  name: { type: "string" },
  parent: { type: "string" },
  role: { type: "string" },
  pw: { type: "string" },
  key: { type: "string" },
  ttl: { type: "string" },
  label: { type: "string" },
  kind: { type: "string" },
  limit: { type: "string" },
  cursor: { type: "string" },
  all: { type: "boolean" },
  "dry-run": { type: "boolean" },
  duplicate: { type: "string" },
  note: { type: "string" },
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
};

let parsed;
try {
  parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true });
} catch (e) {
  console.error(`参数错误: ${e.message}\n用 \`pgs help\` 查看用法`);
  process.exit(2);
}
const flags = parsed.values;
const pos = parsed.positionals;

if (flags.version) {
  console.log(`pgs ${VERSION}`);
  process.exit(0);
}

const BASE = (flags.url ?? process.env.PGS_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const USER = flags.user ?? process.env.PGS_USER ?? "admin";
const CRED_FILE = path.join(process.env.HOME ?? ".", ".config", "pgs", "credentials.json");

function readCredFile() {
  try {
    const j = JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
    return j && typeof j.token === "string" ? j : null;
  } catch {
    return null;
  }
}

function readPassword() {
  if (flags["password-stdin"]) {
    const s = fs.readFileSync(0, "utf8").trim();
    if (!s) throw new Error("--password-stdin 没有读到内容");
    return s;
  }
  if (flags.password) return flags.password;
  if (process.env.PGS_PASSWORD_FILE) {
    return fs.readFileSync(process.env.PGS_PASSWORD_FILE, "utf8").trim();
  }
  return process.env.PGS_PASSWORD ?? "";
}

const TOKEN = flags.token ?? process.env.PGS_TOKEN ?? readCredFile()?.token ?? "";
const PASS = TOKEN ? "" : readPassword();

if (!TOKEN && !PASS && !["login", "help", undefined].includes(pos[0])) {
  console.error("缺少凭据:请先 `pgs login`,或设置 PGS_PASSWORD / 使用 --password-stdin");
  process.exit(2);
}
if (!TOKEN && PASS && /^http:\/\//i.test(BASE) && !/^http:\/\/(127\.|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(BASE)) {
  console.error("警告:正在用 http:// 明文连接远程服务器,密码将以明文发送。建议改用 HTTPS。");
}

const AUTH = TOKEN ? `Bearer ${TOKEN}` : "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

/** 带超时与指数退避重试的请求(429/5xx/网络错误重试,issue §4.3) */
async function call(method, p, body, { retries = 3, timeoutMs = 120_000 } = {}) {
  const headers = { authorization: AUTH };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/v1${p}`, {
        method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!j.ok) {
        const e = new Error(j.error?.message ?? `HTTP ${res.status}`);
        e.status = res.status;
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        throw e;
      }
      return j.data;
    } catch (e) {
      lastErr = e;
      const retryable = !e.status || e.status === 429 || e.status >= 500;
      if (!retryable || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const table = (rows, cols) => {
  if (flags.json) return out(rows);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  console.log(cols.map((c, i) => c.padEnd(w[i])).join("  "));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? "").padEnd(w[i])).join("  "));
};

const EXT = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic|heif|hif|mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|mpe?g|ts)$/i;
/** 收集文件:损坏的符号链接 / 无权限的文件只跳过,不让整个命令崩溃(issue §4.3) */
function collect(inputs, recursive) {
  const files = [];
  const skipped = [];
  const walk = (p, depth) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      skipped.push(`${p}: ${e.code ?? e.message}`);
      return;
    }
    if (st.isSymbolicLink()) {
      skipped.push(`${p}: 符号链接(已跳过)`);
      return;
    }
    if (st.isFile()) {
      if (EXT.test(p)) files.push(p);
    } else if (st.isDirectory() && depth < 12) {
      let entries;
      try {
        entries = fs.readdirSync(p);
      } catch (e) {
        skipped.push(`${p}: ${e.code ?? e.message}`);
        return;
      }
      for (const e of entries) {
        if (e.startsWith(".")) continue;
        walk(path.join(p, e), depth + 1);
      }
    }
  };
  inputs.forEach((p) => walk(path.resolve(p), 0));
  return { files, skipped };
}

/** 流式计算 SHA-256(用于先查后传的幂等同步) */
async function sha256File(file) {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file);
    rs.on("data", (c) => h.update(c));
    rs.on("error", reject);
    rs.on("end", resolve);
  });
  return h.digest("hex");
}

async function upload(inputs) {
  if (!inputs.length) throw new Error("用法: upload <文件或目录...> [--album 代码 | --dir /绝对路径] [--storage local|s3] [-c 并发] [--duplicate skip|keep] [--note 文本] [-r] [--dry-run]");
  const { files, skipped } = collect(inputs, !!flags.recursive);
  if (!files.length) throw new Error("没有找到可上传的图片/视频");
  if (skipped.length) console.error(`跳过 ${skipped.length} 个路径:\n  ${skipped.slice(0, 20).join("\n  ")}`);
  if (flags["dry-run"]) {
    console.log(`将上传 ${files.length} 个文件(试运行,未发送任何请求)`);
    return;
  }

  // 幂等同步:先算本地 hash,批量查询服务端是否已存在,只传缺的(issue §4.3)
  let pending = files;
  if (flags.duplicate !== "keep") {
    try {
      const hashes = await Promise.all(files.map(sha256File));
      const { existing } = await call("POST", "/media/exists", { hashes });
      const have = new Set(existing.map((x) => x.hash));
      pending = files.filter((_, i) => !have.has(hashes[i]));
      if (pending.length < files.length) console.log(`已存在 ${files.length - pending.length} 个文件,跳过`);
    } catch {
      /* 服务端不支持 /media/exists 时退回全量上传 */
    }
  }
  if (!pending.length) {
    console.log("全部文件已存在,无需上传");
    return;
  }

  const conc = Math.max(1, Math.min(32, Number(flags.concurrency) || 4));
  const q = qs({ album: flags.album, dir: flags.dir, storage: flags.storage, duplicate: flags.duplicate, note: flags.note, concurrency: flags.concurrency });
  let idx = 0;
  let ok = 0;
  let dup = 0;
  const failed = [];
  const worker = async () => {
    while (idx < pending.length) {
      const f = pending[idx++];
      try {
        const fd = new FormData();
        const blob = await fs.openAsBlob(f);
        fd.append("file", blob, path.basename(f));
        const r = await call("POST", `/media/upload${q}`, fd);
        const x = r.results[0];
        if (x.status === "created") {
          ok++;
          console.log(`✓ ${f} -> ${x.link}`);
        } else if (x.status === "duplicate") {
          dup++;
          console.log(`= ${f} (已存在 ${x.link})`);
        } else {
          failed.push({ file: f, error: x.error });
          console.log(`✗ ${f}: ${x.error}`);
        }
      } catch (e) {
        failed.push({ file: f, error: e.message });
        console.log(`✗ ${f}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  console.log(`完成: 成功 ${ok}, 重复 ${dup}, 失败 ${failed.length}, 共 ${pending.length}`);
  if (failed.length) {
    console.log("失败清单:");
    for (const x of failed.slice(0, 50)) console.log(`  ${x.file}: ${x.error}`);
    process.exitCode = 1;
  }
}

const HELP = `PicGalleryServer CLI ${VERSION}
认证: PGS_URL + (PGS_TOKEN 或 PGS_USER/PGS_PASSWORD)
      --password-stdin 从标准输入读密码;PGS_PASSWORD_FILE 从文件读
      pgs login 会把令牌保存到 ~/.config/pgs/credentials.json(权限 0600)

  login [--user 用户名] [--password-stdin]      登录并保存令牌
  logout                                       删除本地保存的令牌
  status                                       系统状态(队列/空间/工具)
  status queue [--watch]                       队列状态(可 2 秒刷新)
  album list [--tree] [--parent 代码]          相册列表 / 树
  album info <code> | album status <code>      相册详情 / 状态
  album create <名称> [--parent 代码] [--public] [--storage local|s3]
  album mount <绝对路径> [--name 名] [--parent 代码] [--public] [--no-recursive] [--no-readonly]
  album set <code> [--name 名] [--public|--private] [--cascade] [--parent 代码|root] [--readonly|--no-readonly]
  album rm <code> [--delete-media] [--purge]
  album scan <code> [--wait]
  upload <文件/目录...> [--album 代码|--dir /绝对路径] [--storage local|s3] [-c 并发]
         [--duplicate skip|keep] [--note 文本] [-r] [--dry-run]
  import <服务器路径...> [--album|--dir|--storage] [-c 并发]   服务器本地路径复制导入
  media list [--album 代码] [-q 关键词] [--kind image|video] [--limit N] [--cursor C] [--all] [--json]
  media get <id> [--links] | media note <id> <文本> | media rm <id> [--purge]
  media move <id,id,..> --album 代码|none | media reprocess <id,id,..>
  blocklist list | blocklist restore <id> | blocklist purge <id>
  key list | key set [--key 密钥] [--ttl never|24h|<小时>] [--label 标签] | key rm <id> | key rm --key 密钥
  user list | user add <用户名> --pw 密码 [--role admin|manager|uploader|viewer]
  user set <用户名> [--role r] [--pw 新密码] [--disable|--enable] | user rm <用户名>
  settings get | settings set '<JSON补丁>' | settings icon <文件> | settings icon-reset
  reprocess                                    重新处理失败/待处理文件
  regenerate-derived                           重新生成全部缩略图/预览图
  version                                      显示版本
`;

async function userByName(name) {
  const { users } = await call("GET", "/users");
  const u = users.find((x) => x.username === name || x.id === name);
  if (!u) throw new Error(`用户不存在: ${name}`);
  return u;
}

async function main() {
  const [cmd, sub, a1, ...more] = pos;
  switch (cmd) {
    case undefined:
    case "help":
      return console.log(HELP);
    case "version":
      return console.log(`pgs ${VERSION}`);
    case "login": {
      const body = { username: flags.user ?? process.env.PGS_USER ?? "admin", password: PASS };
      if (!body.password) throw new Error("请用 --password-stdin 或 PGS_PASSWORD 提供密码");
      const r = await call("POST", "/auth/login", body);
      fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
      fs.writeFileSync(CRED_FILE, JSON.stringify({ url: BASE, token: r.token, username: r.user.username }, null, 2), { mode: 0o600 });
      console.log(`已登录 ${r.user.username}(${r.user.role}),令牌已保存到 ${CRED_FILE}`);
      return;
    }
    case "logout":
      fs.rmSync(CRED_FILE, { force: true });
      return console.log("已删除本地保存的令牌");
    case "status":
      if (sub === "queue") {
        if (!flags.watch) return out(await call("GET", "/status/queue"));
        for (;;) {
          const q = await call("GET", "/status/queue");
          console.log(`${new Date().toLocaleTimeString()} 运行 ${q.running} / 等待 ${q.waiting} / 完成 ${q.done} / 失败 ${q.failed}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      return out(await call("GET", "/status"));
    case "upload":
      return upload(pos.slice(1));
    case "import":
      return out(
        await call("POST", "/media/import", {
          paths: pos.slice(1), album: flags.album, dir: flags.dir, storage: flags.storage, concurrency: Number(flags.concurrency) || 4,
          duplicate: flags.duplicate, note: flags.note, recursive: !flags["no-recursive"],
        }),
      );
    case "reprocess":
      return out(await call("POST", "/system/reprocess"));
    case "regenerate-derived":
      return out(await call("POST", "/system/regenerate-derived"));
    case "blocklist":
      switch (sub) {
        case undefined:
        case "list": {
          const r = await call("GET", "/blocklist");
          if (flags.json) return out(r.items);
          return table(
            r.items.map((b) => ({ id: b.id, filename: b.filename, album: b.albumName ?? b.albumCode ?? "", size: b.size, createdAt: b.createdAt })),
            ["id", "filename", "album", "size", "createdAt"],
          );
        }
        case "restore":
          return out(await call("POST", `/blocklist/${a1}/restore`));
        case "purge":
          return out(await call("DELETE", `/blocklist/${a1}`));
        default:
          throw new Error("未知 blocklist 子命令");
      }
    case "album":
      switch (sub) {
        case undefined:
        case "list": {
          const r = await call("GET", `/albums${flags.tree ? "?tree=1" : flags.parent !== undefined ? `?parent=${encodeURIComponent(flags.parent)}` : ""}`);
          if (flags.tree) {
            const walk = (list, d) =>
              list.forEach((a) => {
                console.log(`${"  ".repeat(d)}${a.name}  [${a.code}] ${a.visibility} ${a.counts.media}项`);
                walk(a.children, d + 1);
              });
            return walk(r.albums, 0);
          }
          return table(
            r.albums.map((a) => ({ code: a.code, name: a.name, kind: a.kind, visibility: a.visibility, media: a.counts.media, parent: a.parent ?? "" })),
            ["code", "name", "kind", "visibility", "media", "parent"],
          );
        }
        case "info":
          return out(await call("GET", `/albums/${a1}`));
        case "status":
          return out(await call("GET", `/albums/${a1}/status`));
        case "create":
          return out(await call("POST", "/albums", { name: a1, parent: flags.parent, storage: flags.storage, visibility: flags.public ? "public" : "private" }));
        case "mount":
          return out(await call("POST", "/albums/mount", { path: a1, name: flags.name, parent: flags.parent, visibility: flags.public ? "public" : "private", recursive: !flags["no-recursive"], readonly: flags["no-readonly"] ? false : flags.readonly === undefined ? true : flags.readonly }));
        case "set": {
          const patch = {};
          if (flags.name) patch.name = flags.name;
          if (flags.public) patch.visibility = "public";
          if (flags.private) patch.visibility = "private";
          if (flags.cascade) patch.cascade = true;
          if (flags.readonly !== undefined) patch.readonly = flags.readonly;
          if (flags["no-readonly"]) patch.readonly = false;
          if (flags.parent) patch.parent = flags.parent === "root" ? null : flags.parent;
          return out(await call("PATCH", `/albums/${a1}`, patch));
        }
        case "rm":
          return out(await call("DELETE", `/albums/${a1}${qs({ media: flags["delete-media"] ? "delete" : "move", purge: flags.purge ? 1 : 0 })}`));
        case "scan":
          return out(await call("POST", `/albums/${a1}/scan${qs({ wait: flags.wait ? 1 : 0 })}`));
        default:
          throw new Error("未知 album 子命令");
      }
    case "media":
      switch (sub) {
        case undefined:
        case "list": {
          const rows = [];
          let cursor = flags.cursor;
          for (;;) {
            const r = await call("GET", `/media${qs({ album: flags.album, q: flags.q, kind: flags.kind, limit: flags.limit ?? 50, cursor })}`);
            rows.push(...r.items);
            if (!flags.all || !r.nextCursor) break;
            cursor = r.nextCursor;
          }
          if (flags.json) return out(rows);
          return table(rows.map((i) => ({ id: i.id, kind: i.kind, filename: i.filename, album: i.album ?? "", status: i.status })), ["id", "kind", "filename", "album", "status"]);
        }
        case "get": {
          const d = await call("GET", `/media/${a1}`);
          if (flags.links) return out(d.links);
          return out(d);
        }
        case "note":
          return out(await call("PATCH", `/media/${a1}`, { note: more.join(" ") }));
        case "rm":
          return out(await call("DELETE", `/media/${a1}${qs({ purge: flags.purge ? 1 : 0 })}`));
        case "move":
          return out(await call("POST", "/media/batch", { action: "move", ids: a1.split(","), album: flags.album === "none" ? null : flags.album }));
        case "reprocess":
          return out(await call("POST", "/media/batch", { action: "reprocess", ids: a1.split(",") }));
        default:
          throw new Error("未知 media 子命令");
      }
    case "key":
      switch (sub) {
        case undefined:
        case "list":
          return table(
            (await call("GET", "/keys")).keys.map((k) => ({ id: k.id, hint: k.hint, label: k.label, expiresAt: k.expiresAt ?? "never", uses: k.useCount })),
            ["id", "hint", "label", "expiresAt", "uses"],
          );
        case "set": {
          const ttl = flags.ttl ?? "never";
          return out(
            await call("POST", "/keys", {
              key: flags.key, label: flags.label, expires: ttl === "never" ? "never" : ttl === "24h" ? "24h" : "custom", ttlHours: /^\d+$/.test(ttl) ? Number(ttl) : undefined,
            }),
          );
        }
        case "rm":
          return out(flags.key ? await call("DELETE", `/keys${qs({ key: flags.key })}`) : await call("DELETE", `/keys/${a1}`));
        default:
          throw new Error("未知 key 子命令");
      }
    case "user":
      switch (sub) {
        case undefined:
        case "list":
          return table(
            (await call("GET", "/users")).users.map((u) => ({ id: u.id, username: u.username, role: u.role, disabled: u.disabled, source: u.source })),
            ["id", "username", "role", "disabled", "source"],
          );
        case "add":
          return out(await call("POST", "/users", { username: a1, password: flags.pw, role: flags.role ?? "viewer" }));
        case "set": {
          const u = await userByName(a1);
          const patch = {};
          if (flags.role) patch.role = flags.role;
          if (flags.pw) patch.password = flags.pw;
          if (flags.disable) patch.disabled = true;
          if (flags.enable) patch.disabled = false;
          return out(await call("PATCH", `/users/${u.id}`, patch));
        }
        case "rm":
          return out(await call("DELETE", `/users/${(await userByName(a1)).id}`));
        default:
          throw new Error("未知 user 子命令");
      }
    case "settings":
      switch (sub) {
        case undefined:
        case "get":
          return out(await call("GET", "/settings"));
        case "set":
          return out(await call("PUT", "/settings", JSON.parse(a1)));
        case "icon": {
          const fd = new FormData();
          fd.append("icon", new Blob([fs.readFileSync(a1)]), path.basename(a1));
          return out(await call("POST", "/settings/icon", fd));
        }
        case "icon-reset":
          return out(await call("DELETE", "/settings/icon"));
        default:
          throw new Error("未知 settings 子命令");
      }
    default:
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`错误: ${e.message}`);
  process.exit(1);
});
