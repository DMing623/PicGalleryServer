#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 全链路矩阵编排:对每个数据库驱动(PostgreSQL / SQLite)启动一个全新的服务实例,
 * 依次跑 e2e → cli → hd → 重启持久化检查,最后汇总。需要已 `npm run build`。
 *
 * 用法:
 *   node scripts/test-matrix.mjs                         # 两种数据库全跑
 *   node scripts/test-matrix.mjs --drivers sqlite        # 只跑 SQLite
 *   node scripts/test-matrix.mjs --only e2e,cli          # 只跑指定套件(e2e|cli|hd|restart)
 *   node scripts/test-matrix.mjs --static                # 先做 typecheck + lint + build
 *   node scripts/test-matrix.mjs --keep                  # 结束后保留 /tmp/pgs-run-* 以便排查
 *
 * 环境变量:
 *   SAMPLES_DIR  素材目录(默认 /tmp/pgs-samples;不存在会自动调用 fetch-samples.mjs)
 *   FFMPEG_PATH / FFPROBE_PATH  ffmpeg 位置(不可用则视频相关断言自动跳过)
 *   PG_ADMIN_URL PostgreSQL 超级用户连接串(默认 postgresql://postgres:postgres@127.0.0.1:5432/postgres)
 *   PORT_BASE    起始端口(默认 3100,postgres=+0,sqlite=+1)
 *   TEST_TMP     临时目录根(默认 /tmp)
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Client, ROOT, resetPgDb, startServer } from "./lib/harness.mjs";

const { values: a } = parseArgs({
  options: {
    drivers: { type: "string", default: "postgres,sqlite" },
    only: { type: "string", default: "e2e,cli,hd,media,restart" },
    static: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    "e2e-only": { type: "string", default: "" },
  },
});
const SAMPLES = process.env.SAMPLES_DIR || "/tmp/pgs-samples";
const TMP = process.env.TEST_TMP || "/tmp";
const PORT_BASE = Number(process.env.PORT_BASE || 3100);
const suites = new Set(a.only.split(","));
const PASS = "test-pass-123";
const results = [];

const run = (cmd, args, env = {}) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
    p.on("exit", (code) => resolve(code ?? 1));
  });

if (a.static) {
  console.log("\n######## 静态检查 ########");
  for (const [name, args] of [["typecheck", ["run", "typecheck"]], ["lint", ["run", "lint"]], ["build", ["run", "build"]]]) {
    const code = await run("npm", args, { DATABASE_URL: "postgresql://build:build@127.0.0.1:5432/build", NEXT_TELEMETRY_DISABLED: "1" });
    results.push({ name: `static:${name}`, ok: code === 0 });
    if (code !== 0 && name === "build") process.exit(1);
  }
}
if (!fs.existsSync(path.join(ROOT, ".next/BUILD_ID"))) {
  console.error("未找到 .next 构建产物,请先 npm run build(或加 --static)");
  process.exit(2);
}
if (!fs.existsSync(path.join(SAMPLES, "manifest.json"))) {
  console.log("素材不存在,自动下载…");
  const code = await run(process.execPath, ["scripts/fetch-samples.mjs", "--out", SAMPLES]);
  if (code !== 0) process.exit(2);
}

const ff = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]);
const HAS_VIDEO = ff.status === 0;
if (!HAS_VIDEO) console.warn("⚠ 未检测到 ffmpeg,视频相关断言将跳过(设置 FFMPEG_PATH 可启用)");

async function snapshot(c) {
  const st = (await c.get("/status")).data;
  const albums = (await c.get("/albums")).data;
  const media = (await c.get("/media?limit=200")).data;
  return { counts: st.counts, albums: albums.albums.length, mediaIds: media.items.map((i) => i.id).sort(), firstId: media.items[0]?.id };
}

for (const driver of a.drivers.split(",")) {
  const idx = driver === "postgres" ? 0 : 1;
  const port = PORT_BASE + idx;
  const root = path.join(TMP, `pgs-run-${driver}`);
  fs.rmSync(root, { recursive: true, force: true });
  const dataDir = path.join(root, "data");
  const mnt = path.join(root, "mnt");
  fs.mkdirSync(mnt, { recursive: true });
  const pgDb = `pgs_test_${driver}`;
  const label = driver;
  console.log(`\n################ ${driver.toUpperCase()} (端口 ${port}) ################`);
  let srv;
  const env = {
    ALLOWED_MOUNT_ROOTS: mnt,
    ADMIN_PASSWORD: PASS,
    SESSION_SECRET: "test-secret",
    HD_SCAN_DISTINCT: "9",
    FFMPEG_PATH: process.env.FFMPEG_PATH || "ffmpeg",
    FFPROBE_PATH: process.env.FFPROBE_PATH || "ffprobe",
  };
  try {
    if (driver === "postgres") {
      await resetPgDb(pgDb);
      if (suites.has("media")) await resetPgDb(pgDb + "_media");
    }
    srv = await startServer({ driver, port, dataDir: dataDir, pgDb, env });
    const common = { BASE: srv.base, ADMIN_PASSWORD: PASS, SESSION_SECRET: "test-secret", SAMPLES_DIR: SAMPLES, DATA_DIR: dataDir, MOUNT_HOST_DIR: mnt, MOUNT_SERVER_DIR: mnt, HAS_VIDEO: HAS_VIDEO ? "1" : "0", TEST_LABEL: label, HD_SCAN_DISTINCT: "9" };

    if (suites.has("e2e")) {
      const code = await run(process.execPath, ["scripts/test-e2e.mjs"], { ...common, ONLY: a["e2e-only"] });
      results.push({ name: `${label}:e2e`, ok: code === 0 });
    }
    if (suites.has("cli")) {
      const code = await run(process.execPath, ["scripts/test-cli.mjs"], { ...common, MOUNT_HOST_DIR: mnt });
      results.push({ name: `${label}:cli`, ok: code === 0 });
    }
    if (suites.has("hd")) {
      const code = await run(process.execPath, ["scripts/test-hd.mjs"], { ...common, DATA_DIR: dataDir });
      results.push({ name: `${label}:hd`, ok: code === 0 });
    }
    if (suites.has("media")) {
      // 媒体内存治理:单独起一个 MEDIA_MAX_INPUT_MP=10、SHARP_CONCURRENCY=1 的服务,验证 [LIMIT] 与观测字段
      let msrv;
      try {
        const mData = path.join(root, "media-data");
        msrv = await startServer({ driver, port: port + 10, dataDir: mData, pgDb: pgDb + "_media", tag: driver + "-media", env: { ...env, MEDIA_MAX_INPUT_MP: "10", SHARP_CONCURRENCY: "1" } });
        const code = await run(process.execPath, ["scripts/test-media.mjs"], { BASE: msrv.base, ADMIN_PASSWORD: PASS, DATA_DIR: mData, EXPECT_MAX_INPUT_MP: "10" });
        results.push({ name: `${label}:media`, ok: code === 0 });
      } catch (e) {
        console.error(`✗ ${driver} media 阶段异常:`, e.message);
        results.push({ name: `${label}:media`, ok: false });
      } finally {
        if (msrv) await msrv.stop();
      }
    }
    if (suites.has("restart")) {
      console.log(`\n# 重启持久化检查(${driver})`);
      const c = new Client(srv.base, { user: "admin", password: PASS });
      const before = await snapshot(c);
      await srv.stop();
      srv = await startServer({ driver, port, dataDir, pgDb, env, tag: driver + "-restart" });
      const c2 = new Client(srv.base, { user: "admin", password: PASS });
      const after = await snapshot(c2);
      const same = JSON.stringify(before.mediaIds) === JSON.stringify(after.mediaIds) && before.albums === after.albums && before.counts.total === after.counts.total && before.counts.users === after.counts.users;
      const th = before.firstId ? await c2.get(`/media/${before.firstId}/thumb`) : { status: 200 };
      const good = same && th.status === 200;
      console.log(`  ${good ? "✓" : "✗ FAIL"} 重启后数据一致(媒体 ${after.mediaIds.length} / 相册 ${after.albums} / 用户 ${after.counts.users}),缩略图可取`);
      if (!good) console.log("   before", JSON.stringify(before.counts), "after", JSON.stringify(after.counts));
      results.push({ name: `${label}:restart`, ok: good });
    }
  } catch (e) {
    console.error(`✗ ${driver} 运行异常:`, e.message);
    results.push({ name: `${label}:harness`, ok: false });
  } finally {
    if (srv) {
      await srv.stop();
      const log = fs.readFileSync(srv.logFile, "utf8").replace(/\0/g, "");
      const errs = log.split("\n").filter((l) => /unhandled error|UnhandledPromise|TypeError|ReferenceError|Failed query/.test(l));
      console.log(`\n服务日志:${srv.logFile}(unhandled/异常行 ${errs.length} 条)`);
      for (const l of errs.slice(0, 8)) console.log("   ! " + l.slice(0, 220));
      results.push({ name: `${label}:server-log-clean`, ok: errs.length === 0, soft: true });
    }
    if (!a.keep) fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log("\n==================== 总结 ====================");
for (const r of results) console.log(`${r.ok ? "✓ PASS" : r.soft ? "⚠ WARN" : "✗ FAIL"}  ${r.name}`);
const failed = results.filter((r) => !r.ok && !r.soft);
console.log(failed.length ? `\n${failed.length} 项失败` : "\n全部通过");
process.exit(failed.length ? 1 : 0);
