#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 文档 ↔ 代码静态一致性校验(零依赖,不需要构建、数据库、Docker,也不需要 root 权限)。
 * 目的:防止代码演进后 project.md 等开发文档再次漂移(D-4)。
 *
 *   ① src/server/api/*.ts 的 route(method, path, access) ↔ project.md §8 接口表(双向)
 *   ② src/server/config.ts (+ db/index.ts)读取的环境变量 ↔ project.md §10(含 §10.1)
 *   ③ src/ · cli/ · scripts/ · .github/workflows/ 文件清单 ↔ project.md §3 目录树(双向)
 *   ④ package.json 版本 ↔ package-lock.json ↔ project.md 头部当前版本
 *   ⑤ 文档(project.md / scripts/TESTING.md / scripts/bench/README.md)中引用的仓库文件路径是否存在
 *
 * 用法: node scripts/check-docs.mjs          退出码 0 = 通过;1 = 有问题;2 = 脚本读不到文件
 *       node scripts/check-docs.mjs --json   以 JSON 输出(给 CI 用)
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
    else out.push(rel);
  }
  return out;
};

const doc = read("project.md");

function sectionSlice(headingRe, nextHeadingRe) {
  const m = headingRe.exec(doc);
  if (!m) return "";
  const rest = doc.slice(m.index);
  const n = nextHeadingRe ? nextHeadingRe.exec(rest.slice(m[0].length)) : null;
  return n ? rest.slice(0, m[0].length + n.index) : rest;
}

/* ---------- ① REST 路由清单 ↔ project.md §8 ---------- */
const codeRoutes = new Map(); // "METHOD /path" → { access, file }
for (const f of walk("src/server/api").filter((x) => x.endsWith(".ts"))) {
  const src = read(f);
  for (const m of src.matchAll(/\broute\(\s*"([A-Z]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/g)) {
    codeRoutes.set(`${m[1]} ${m[2]}`, { access: m[3], file: f });
  }
  // 展开形如 for (const v of ["thumb", "preview", ...]) route("GET", `/media/:id/${v}`, "public", ...)
  for (const m of src.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+\[([^\]]+)\][^{]*\{\s*route\(\s*"([A-Z]+)"\s*,\s*`([^`]+)`\s*,\s*"([^"]+)"/g)) {
    const [, varName, listRaw, method, tpl, access] = m;
    for (const item of listRaw.matchAll(/"([^"]+)"/g)) {
      const p = tpl.replace(`\${${varName}}`, item[1]);
      codeRoutes.set(`${method} ${p}`, { access, file: f });
    }
  }
}

const sec8 = sectionSlice(/^## 8\. REST API/m, /^## 9\./m);
const docRoutes = new Set();
for (const line of sec8.split("\n")) {
  if (!line.startsWith("|")) continue;
  for (const m of line.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+`(\/[^`\s?]*)[^`]*`/g)) {
    docRoutes.add(`${m[1]} ${m[2]}`);
  }
}

for (const [key, info] of codeRoutes) {
  if (!docRoutes.has(key)) fail("routes", `代码路由 ${key} (${info.file}) 未在 project.md §8 列出`);
}
for (const key of docRoutes) {
  if (!codeRoutes.has(key)) fail("routes", `project.md §8 列出了 ${key},但 src/server/api/*.ts 中不存在该路由`);
}

/* ---------- ② 环境变量 ↔ project.md §10 ---------- */
const ENV_EXEMPT = new Set(["NODE_ENV", "NEXT_PHASE", "NEXT_RUNTIME", "HOME"]);
const codeEnvs = new Set();
for (const f of ["src/server/config.ts", "src/db/index.ts"]) {
  const src = read(f);
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    if (!m[1].startsWith("PGS_") && !ENV_EXEMPT.has(m[1])) codeEnvs.add(m[1]);
  }
  for (const m of src.matchAll(/\b(?:int|num|flag|enumOf|list)\(\s*"([A-Z][A-Z0-9_]*)"/g)) {
    if (!m[1].startsWith("PGS_") && !ENV_EXEMPT.has(m[1])) codeEnvs.add(m[1]);
  }
}

const sec10 = sectionSlice(/^## 10\. 环境变量/m, /^## 11\./m);
const docEnvs = new Set([...sec10.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]));
for (const name of codeEnvs) {
  if (!docEnvs.has(name)) fail("env", `环境变量 ${name} 在代码中读取,但未在 project.md §10 文档化`);
}

/* ---------- ③ 文件清单 ↔ project.md §3 目录树 ---------- */
const sec3 = sectionSlice(/^## 3\. 目录与文件职责/m, /^## 4\./m);
const allFiles = [
  ...walk("src"),
  ...walk("cli"),
  ...walk("scripts"),
  ...walk(".github/workflows"),
];

for (const rel of allFiles) {
  const base = path.posix.basename(rel);
  // 对同名文件(如 route.ts / page.tsx / layout.tsx / index.ts / service.ts / README.md)检查带父目录的片段或文件名
  const parentBase = path.posix.join(path.posix.basename(path.posix.dirname(rel)), base);
  if (!sec3.includes(rel) && !sec3.includes(parentBase) && !sec3.includes(base)) {
    fail("tree", `文件 ${rel} 未出现在 project.md §3 目录树中`);
  }
}

/* ---------- ④ 版本号一致性 ---------- */
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
if (lock.version !== pkg.version) {
  fail("version", `package-lock.json version (${lock.version}) ≠ package.json (${pkg.version})`);
}
if (!doc.slice(0, 800).includes(`v${pkg.version}`)) {
  fail("version", `project.md 头部未标注当前版本 v${pkg.version}`);
}

/* ---------- ⑤ 文档中引用的仓库路径是否存在 ---------- */
for (const docFile of ["project.md", "scripts/TESTING.md", "scripts/bench/README.md"]) {
  const text = read(docFile);
  for (const m of text.matchAll(/`((?:src|scripts|cli|\.github\/workflows)\/[A-Za-z0-9_./-]+)`/g)) {
    const ref = m[1].replace(/\/$/, "");
    if (ref.includes("*") || ref.includes("<") || ref.includes("...")) continue;
    if (!fs.existsSync(path.join(ROOT, ref))) {
      fail("paths", `${docFile} 引用了不存在的路径 \`${ref}\``);
    }
  }
  if (/`todo\.md`/.test(text)) {
    fail("paths", `${docFile} 仍引用已删除的 \`todo.md\``);
  }
}

notes.push(`路由:代码 ${codeRoutes.size} 条 ↔ project.md §8 ${docRoutes.size} 条`);
notes.push(`环境变量:代码 ${codeEnvs.size} 个 ↔ project.md §10 已覆盖`);
notes.push(`文件树:已核对 ${allFiles.length} 个源码/脚本/工作流文件;版本 v${pkg.version}`);

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: !problems.length, problems, notes }, null, 2));
} else {
  for (const n of notes) console.log(`· ${n}`);
  if (problems.length) {
    console.error(`\n✗ 发现 ${problems.length} 个文档一致性问题:`);
    for (const p of problems) console.error(`  [${p.area}] ${p.msg}`);
  } else {
    console.log("✓ project.md 与代码一致性检查通过");
  }
}
process.exit(problems.length ? 1 : 0);
