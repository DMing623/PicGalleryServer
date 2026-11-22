#!/usr/bin/env node
/**
 * PicGalleryServer 命令行管理工具(零依赖,需要 Node 18+)。
 * 认证: 管理员用户名 + 密码(HTTP Basic),可用环境变量或参数提供:
 *   PGS_URL=http://127.0.0.1:3000  PGS_USER=admin  PGS_PASSWORD=xxxx
 * 用法见 `node cli/pgs.mjs help`。
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
const BOOL = new Set(["public", "private", "cascade", "purge", "delete-media", "no-recursive", "json", "recursive", "wait", "tree", "disable", "enable"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    if (BOOL.has(k)) flags[k] = true;
    else flags[k] = argv[++i];
  } else if (a === "-c") flags.concurrency = argv[++i];
  else if (a === "-q") flags.q = argv[++i];
  else if (a === "-r") flags.recursive = true;
  else pos.push(a);
}

const BASE = (flags.url ?? process.env.PGS_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const USER = flags.user ?? process.env.PGS_USER ?? "admin";
const PASS = flags.password ?? process.env.PGS_PASSWORD ?? "";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

async function call(method, p, body) {
  const headers = { authorization: AUTH };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/api/v1${p}`, { method, headers, body: payload });
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
    throw e;
  }
  return j.data;
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
function collect(inputs, recursive) {
  const files = [];
  const walk = (p, depth) => {
    const st = fs.statSync(p);
    if (st.isFile()) {
      if (EXT.test(p)) files.push(p);
    } else if (st.isDirectory() && depth < 12) {
      for (const e of fs.readdirSync(p)) {
        if (e.startsWith(".")) continue;
        const c = path.join(p, e);
        if (recursive || !fs.statSync(c).isDirectory()) walk(c, depth + 1);
      }
    }
  };
  inputs.forEach((p) => walk(path.resolve(p), 0));
  return files;
}

async function upload(inputs) {
  if (!inputs.length) throw new Error("用法: upload <文件或目录...> [--album 代码 | --dir /绝对路径] [--storage local|s3] [-c 并发] [--duplicate skip|keep] [--note 文本] [-r]");
  const files = collect(inputs, !!flags.recursive);
  if (!files.length) throw new Error("没有找到可上传的图片/视频");
  const conc = Math.max(1, Math.min(32, Number(flags.concurrency) || 4));
  const q = qs({ album: flags.album, dir: flags.dir, storage: flags.storage, duplicate: flags.duplicate, note: flags.note, concurrency: flags.concurrency });
  let idx = 0;
  let ok = 0;
  let dup = 0;
  let bad = 0;
  const worker = async () => {
    while (idx < files.length) {
      const f = files[idx++];
      try {
        const fd = new FormData();
        const blob = fs.openAsBlob ? await fs.openAsBlob(f) : new Blob([fs.readFileSync(f)]);
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
          bad++;
          console.log(`✗ ${f}: ${x.error}`);
        }
      } catch (e) {
        bad++;
        console.log(`✗ ${f}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  console.log(`完成: 成功 ${ok}, 重复 ${dup}, 失败 ${bad}, 共 ${files.length}`);
  if (bad) process.exitCode = 1;
}

const HELP = `PicGalleryServer CLI
认证: 环境变量 PGS_URL PGS_USER PGS_PASSWORD (或 --url --user --password)

  status                                   系统状态(队列/空间/工具)
  album list [--tree]                      相册列表 / 树
  album info <code> | album status <code>  相册详情 / 状态
  album create <名称> [--parent 代码] [--public] [--storage local|s3]
  album mount <绝对路径> [--name 名] [--parent 代码] [--public] [--no-recursive]
  album set <code> [--name 名] [--public|--private] [--cascade] [--parent 代码|root]
  album rm <code> [--delete-media] [--purge]
  album scan <code> [--wait]
  upload <文件/目录...> [--album 代码|--dir /绝对路径] [--storage local|s3] [-c 并发] [--duplicate skip|keep] [--note 文本] [-r]
  import <服务器路径...> [--album|--dir|--storage] [-c 并发]   服务器本地路径复制导入
  media list [--album 代码] [-q 关键词] [--kind image|video]
  media get <id> | media note <id> <文本> | media rm <id> [--purge]
  media move <id,id,..> --album 代码|none | media reprocess <id,id,..>
  key list | key set [--key 密钥] [--ttl never|24h|<小时>] [--label 标签] | key rm <id> | key rm --key 密钥
  user list | user add <用户名> --pw 密码 [--role admin|manager|uploader|viewer]
  user set <用户名> [--role r] [--pw 新密码] [--disable|--enable] | user rm <用户名>
  settings get | settings set '<JSON补丁>' | settings icon <文件> | settings icon-reset
  reprocess                                重新处理失败/待处理文件
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
    case "status":
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
    case "album":
      switch (sub) {
        case undefined:
        case "list": {
          const r = await call("GET", `/albums${flags.tree ? "?tree=1" : ""}`);
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
          return out(await call("POST", "/albums/mount", { path: a1, name: flags.name, parent: flags.parent, visibility: flags.public ? "public" : "private", recursive: !flags["no-recursive"] }));
        case "set": {
          const patch = {};
          if (flags.name) patch.name = flags.name;
          if (flags.public) patch.visibility = "public";
          if (flags.private) patch.visibility = "private";
          if (flags.cascade) patch.cascade = true;
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
          const r = await call("GET", `/media${qs({ album: flags.album, q: flags.q, kind: flags.kind, limit: flags.limit ?? 50 })}`);
          return table(r.items.map((i) => ({ id: i.id, kind: i.kind, filename: i.filename, album: i.album ?? "", status: i.status })), ["id", "kind", "filename", "album", "status"]);
        }
        case "get":
          return out(await call("GET", `/media/${a1}`));
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
