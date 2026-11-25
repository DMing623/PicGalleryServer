// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseKv, parseCgroupV1, parseCgroupV2, readCgroup, workingSetBytes } from "../../src/server/cgroup.ts";

test("parseKv 解析 memory.stat,忽略坏行", () => {
  assert.deepEqual(parseKv("anon 100\nfile 200\nbad line\n\ninactive_file 5\n"), { anon: 100, file: 200, inactive_file: 5 });
  assert.deepEqual(parseKv(null), {});
});

test("cgroup v2:max=max → 无限制;anon 来自 memory.stat", () => {
  const r = parseCgroupV2({ current: "1000\n", max: "max\n", stat: "anon 400\ninactive_file 300\n" });
  assert.equal(r.max, null);
  assert.equal(r.current, 1000);
  assert.equal(r.anon, 400);
  assert.equal(workingSetBytes(r), 400);
});

test("cgroup v2:无 anon 时回落 current − inactive_file", () => {
  const r = parseCgroupV2({ current: "1000", max: "2048", stat: "inactive_file 300\n" });
  assert.equal(r.max, 2048);
  assert.equal(workingSetBytes(r), 700);
});

test("cgroup v1:巨大 limit 视为无限制;anon 取 total_rss", () => {
  const r = parseCgroupV1({ usage: "5000", limit: "9223372036854771712", stat: "total_rss 1234\ntotal_inactive_file 10\n" });
  assert.equal(r.max, null);
  assert.equal(r.anon, 1234);
  const r2 = parseCgroupV1({ usage: "5000", limit: "1073741824", stat: "" });
  assert.equal(r2.max, 1073741824);
  assert.equal(workingSetBytes(r2), 5000);
});

test("readCgroup:读 v2 目录;目录不存在返回 null(非 root/无 cgroup 环境安全)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cg-"));
  try {
    assert.equal(readCgroup(path.join(d, "nope")), null);
    fs.writeFileSync(path.join(d, "memory.current"), "2048\n");
    fs.writeFileSync(path.join(d, "memory.max"), "4096\n");
    fs.writeFileSync(path.join(d, "memory.stat"), "anon 1024\n");
    const r = readCgroup(d);
    assert.equal(r?.version, 2);
    assert.equal(r?.max, 4096);
    assert.equal(workingSetBytes(r), 1024);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("workingSetBytes(null) = null", () => assert.equal(workingSetBytes(null), null));
