#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 纯逻辑单元测试入口(node:test,零依赖,不需要构建/数据库/Docker/root)。
 * 被测模块(src/server 下不引用项目内其它模块的纯函数文件)直接以 .ts 导入,
 * 依赖 Node 的类型剥离(≥22.6 用 --experimental-strip-types;22.18+ 默认开启,传该参数无副作用)。
 *
 * 用法: node scripts/test-unit.mjs            全部
 *       node scripts/test-unit.mjs admission  只跑文件名含 admission 的
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "unit");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`需要 Node ≥ 22.6(当前 ${process.version}),用于直接导入 .ts 纯逻辑模块`);
  process.exit(2);
}
const filter = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs") && (!filter || f.includes(filter))).map((f) => path.join(dir, f));
if (!files.length) {
  console.error("没有匹配的单元测试文件");
  process.exit(2);
}
const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
