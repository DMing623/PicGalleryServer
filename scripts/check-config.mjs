#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 静态一致性校验(零依赖,不需要构建、数据库、Docker,也不需要 root 权限)。
 * 目的:让「代码 ↔ compose ↔ .env.example ↔ 数据库自举 ↔ 版本号」不再各改各的。
 *
 *   ① 代码读取的每个环境变量 ↔ docker-compose.yml 的 app.environment 映射
 *        要么已映射,要么登记在下面的 NOT_MAPPED(必须写理由);漏映射 = 配置静默失效
 *        反向:compose 里映射了但代码已不再读取 → 报「陈旧映射」
 *   ② 代码读取的每个环境变量 ↔ .env.example 有说明(NAME= 或 # NAME=)
 *   ③ compose 里不得再硬编码 `${PGS_XXX:-数字}` 形式的默认值(会盖掉 config.ts 的 CPU 自适应默认)
 *   ④ package.json 版本 ↔ compose 的 PGS_TAG 默认值 ↔ .env.example 的 PGS_TAG
 *   ⑤ src/db/schema.ts 的表/列 ↔ bootstrap.ts 的 PG_DDL / LITE_DDL(含 ALTER 升级)列集合一致
 *
 * 用法: node scripts/check-config.mjs          退出码 0 = 通过;1 = 有问题;2 = 脚本读不到文件
 *       node scripts/check-config.mjs --json   以 JSON 输出(给 CI 用)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSON_OUT = process.argv.includes("--json");
const problems = [];
const notes = [];
const fail = (area, msg) => problems.push({ area, msg });

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch (e) {
    console.error(`无法读取 ${rel}: ${e.message}`);
    process.exit(2);
  }
};
const walk = (dir, out = []) => {
  for (const f of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, f.name);
    if (f.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(f.name)) out.push(rel);
  }
  return out;
};

/** 显式【不映射】白名单:变量名 → 理由。新增条目必须写清为什么容器里不需要/不应该由 .env 控制 */
const NOT_MAPPED = {
  PORT: "容器内固定 3000,宿主机端口用 compose 的 ports 调整",
  DATA_DIR: "容器内固定 /app/data(与 volumes 对应),不允许通过环境变量改容器内部布局",
  HD_CACHE_DIR: "默认落在 DATA_DIR/cache/hd,随 /app/data 卷持久化;改位置请改 volumes",
  NODE_ENV: "镜像已设置 production",
  NEXT_PHASE: "Next.js 内部变量",
  NEXT_RUNTIME: "Next.js 内部变量",
  HOME: "操作系统变量",
};
/** 不属于服务端配置的变量前缀(命令行 pgs 的凭据等) */
const IGNORE_PREFIX = ["PGS_"];
/** compose 里允许存在、但代码不直接读取的变量(镜像/运行时层面) */
const COMPOSE_ONLY = new Set(["UV_THREADPOOL_SIZE", "NODE_OPTIONS", "MALLOC_ARENA_MAX"]);
/** .env.example 里不要求出现的变量 */
const ENV_EXAMPLE_EXEMPT = new Set(["NODE_ENV", "NEXT_PHASE", "NEXT_RUNTIME", "HOME"]);

/* ---------- ① 代码读取的环境变量 ---------- */
const files = [...walk("src/server"), ...walk("src/db"), "src/instrumentation.ts"];
const used = new Map(); // name → Set(files)
const add = (name, file) => {
  if (IGNORE_PREFIX.some((p) => name.startsWith(p))) return;
  if (!used.has(name)) used.set(name, new Set());
  used.get(name).add(file);
};
for (const f of files) {
  const src = read(f);
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) add(m[1], f);
  for (const m of src.matchAll(/process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g)) add(m[1], f);
  if (f.endsWith("server/config.ts")) {
    for (const m of src.matchAll(/\b(?:int|num|flag|enumOf|list)\(\s*"([A-Z][A-Z0-9_]*)"/g)) add(m[1], f);
  }
}

const compose = read("docker-compose.yml");
const appBlock = compose.slice(compose.indexOf("\n  app:"));
const envStart = appBlock.indexOf("    environment:");
const envEnd = appBlock.indexOf("\n    volumes:", envStart);
const envBlock = appBlock.slice(envStart, envEnd > 0 ? envEnd : undefined);
const mapped = new Map(); // name → 原始值表达式
for (const line of envBlock.split("\n")) {
  const m = /^ {6}([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
  if (m) mapped.set(m[1], m[2].trim());
}
if (!mapped.size) fail("compose", "没有解析到 app.environment 映射(compose 结构变了?)");

for (const [name, fl] of used) {
  if (mapped.has(name) || name in NOT_MAPPED) continue;
  fail("compose", `${name} 被代码读取(${[...fl].join(", ")})但未在 docker-compose.yml 的 app.environment 中映射,也未登记为「不映射」`);
}
for (const name of mapped.keys()) {
  if (used.has(name) || COMPOSE_ONLY.has(name)) continue;
  fail("compose", `${name} 在 compose 中映射了,但代码不再读取(陈旧映射?)`);
}
for (const [name, why] of Object.entries(NOT_MAPPED)) {
  if (!why || !String(why).trim()) fail("compose", `NOT_MAPPED.${name} 缺少理由`);
}

/* ---------- ② .env.example ---------- */
const envExample = read(".env.example");
const documented = new Set([...envExample.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
for (const name of used.keys()) {
  if (ENV_EXAMPLE_EXEMPT.has(name)) continue;
  if (!documented.has(name)) fail("env.example", `${name} 未在 .env.example 中说明`);
}

/* ---------- ③ compose 不得硬编码数字默认值覆盖 config.ts ---------- */
for (const [name, expr] of mapped) {
  if (/^\$\{PGS_[A-Z0-9_]+:-\d+\}$/.test(expr)) {
    fail("compose", `${name}: ${expr} 硬编码了数字默认值,会覆盖 config.ts 的自适应默认;请改成 \${${name}:-\${PGS_...:-}}`);
  }
}

/* ---------- ④ 版本号 ---------- */
const pkgVersion = JSON.parse(read("package.json")).version;
const composeTag = /PGS_TAG:-([^}]+)\}/.exec(compose)?.[1];
const envTag = /^PGS_TAG=(.*)$/m.exec(envExample)?.[1]?.trim();
if (composeTag !== pkgVersion) fail("version", `compose 的 PGS_TAG 默认值 ${composeTag} ≠ package.json ${pkgVersion}`);
if (envTag !== pkgVersion) fail("version", `.env.example 的 PGS_TAG=${envTag} ≠ package.json ${pkgVersion}`);

/* ---------- ⑤ schema.ts ↔ bootstrap.ts ---------- */
function schemaTables() {
  const src = read("src/db/schema.ts");
  const out = new Map();
  for (const m of src.matchAll(/pgTable\(\s*"([a-z0-9_]+)"\s*,\s*\{/g)) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    const body = src.slice(start, i - 1);
    const cols = new Set([...body.matchAll(/\b(?:text|integer|bigint|boolean|jsonb|real|timestamp|varchar|doublePrecision|serial)\(\s*"([a-z0-9_]+)"/g)].map((x) => x[1]));
    out.set(m[1], cols);
  }
  return out;
}
function ddlTables(constName) {
  const src = read("src/db/bootstrap.ts");
  const m = new RegExp("const " + constName + " = `([\\s\\S]*?)`;").exec(src);
  if (!m) {
    fail("bootstrap", `找不到 ${constName}`);
    return new Map();
  }
  const out = new Map();
  for (const t of m[1].matchAll(/CREATE TABLE IF NOT EXISTS "([a-z0-9_]+)" \(([\s\S]*?)\n\);/g)) {
    const cols = new Set();
    for (const line of t[2].split("\n")) {
      const c = /^\s*"([a-z0-9_]+)"\s+\w/.exec(line);
      if (c) cols.add(c[1]);
    }
    out.set(t[1], cols);
  }
  for (const a of m[1].matchAll(/ALTER TABLE "([a-z0-9_]+)" ADD COLUMN IF NOT EXISTS "([a-z0-9_]+)"/g)) out.get(a[1])?.add(a[2]);
  return out;
}
function liteUpgrades() {
  const src = read("src/db/bootstrap.ts");
  const m = /const LITE_UPGRADE[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src);
  const out = [];
  if (m) for (const x of m[1].matchAll(/table:\s*"([a-z0-9_]+)",\s*column:\s*"([a-z0-9_]+)"/g)) out.push([x[1], x[2]]);
  return out;
}
const schema = schemaTables();
const pg = ddlTables("PG_DDL");
const lite = ddlTables("LITE_DDL");
const liteUp = liteUpgrades();
for (const [t, cols] of schema) {
  for (const [label, ddl] of [["PG_DDL", pg], ["LITE_DDL", lite]]) {
    const have = ddl.get(t);
    if (!have) {
      fail("bootstrap", `${label} 缺少表 ${t}`);
      continue;
    }
    for (const c of cols) if (!have.has(c)) fail("bootstrap", `${label}: 表 ${t} 缺少列 ${c}(schema.ts 里有)`);
    for (const c of have) if (!cols.has(c)) fail("bootstrap", `${label}: 表 ${t} 多出列 ${c}(schema.ts 里没有)`);
  }
}
// 老库升级:凡是 LITE_UPGRADE 里的列,PG 也必须有 ALTER ... ADD COLUMN IF NOT EXISTS;反之亦然
const bootSrc = read("src/db/bootstrap.ts");
for (const [t, c] of liteUp) {
  if (!new RegExp(`ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "${c}"`).test(bootSrc)) {
    fail("bootstrap", `LITE_UPGRADE 里有 ${t}.${c},但 PG 侧缺少对应的 ALTER ... ADD COLUMN IF NOT EXISTS`);
  }
}
for (const a of bootSrc.matchAll(/ALTER TABLE "([a-z0-9_]+)" ADD COLUMN IF NOT EXISTS "([a-z0-9_]+)"/g)) {
  if (!liteUp.some(([t, c]) => t === a[1] && c === a[2])) fail("bootstrap", `PG 有 ALTER ${a[1]}.${a[2]},但 LITE_UPGRADE 里没有(SQLite 老库升级会缺列)`);
}
notes.push(`环境变量:代码读取 ${used.size} 个,compose 映射 ${mapped.size} 个,显式不映射 ${Object.keys(NOT_MAPPED).length} 个`);
notes.push(`数据表:schema ${schema.size} 张 / PG_DDL ${pg.size} 张 / LITE_DDL ${lite.size} 张;版本 ${pkgVersion}`);

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: !problems.length, problems, notes }, null, 2));
} else {
  for (const n of notes) console.log(`· ${n}`);
  if (problems.length) {
    console.error(`\n✗ 发现 ${problems.length} 个一致性问题:`);
    for (const p of problems) console.error(`  [${p.area}] ${p.msg}`);
  } else {
    console.log("✓ 配置/文档/数据库自举一致性检查通过");
  }
}
process.exit(problems.length ? 1 : 0);
