// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from "node:test";
import assert from "node:assert/strict";
import { estimateMemory, megapixelsFromSize, limitMessage, pixelLimitMessage, NON_CORRUPT_ERROR_PREFIXES } from "../../src/server/media/estimate.ts";

const E = (m, s = "derive") => estimateMemory(m, s);

test("流式 < 渐进/隔行 < CMYK(同像素量)", () => {
  const base = { format: "jpeg", width: 6000, height: 4000 };
  const stream = E(base).estMB;
  const prog = E({ ...base, progressive: true }).estMB;
  const cmyk = E({ ...base, space: "cmyk" }).estMB;
  assert.ok(stream < prog && prog < cmyk, `${stream} < ${prog} < ${cmyk}`);
});

test("与 bench 基线一致(误差内,且不低估):渐进 JPEG 12MP derive 实测 ≈65MB", () => {
  const e = E({ format: "jpeg", width: 4000, height: 3000, progressive: true });
  assert.ok(e.estMB >= 65 && e.estMB <= 65 * 1.6, `估算 ${e.estMB}MB`);
  assert.equal(e.confidence, "medium");
  assert.equal(e.source, "measured-synthetic");
});

test("100MP 隔行 PNG 的 HD 估算与旧实测(≈345MB 增量)同量级,不低估", () => {
  const e = E({ format: "png", width: 10000, height: 10000, progressive: true }, "hd-miss");
  assert.ok(e.estMB >= 345 && e.estMB <= 345 * 1.6, `估算 ${e.estMB}MB`);
});

test("低置信度自动 ×1.5:HEIC / 未知格式 / 仅知文件大小", () => {
  const heic = E({ width: 4032, height: 3024 }, "heic");
  assert.equal(heic.confidence, "low");
  assert.equal(heic.layout, "heic");
  const raw = 40 + 14 * ((4032 * 3024) / 1e6);
  assert.equal(heic.estMB, Math.ceil(raw * 1.5));
  const nosize = E({ sizeBytes: 5 * 1e6, mime: "image/jpeg", format: "jpeg" });
  assert.equal(nosize.confidence, "low");
  assert.match(nosize.reason, /按文件大小反推/);
});

test("16-bit 高位深逐像素部分放大", () => {
  const a = E({ format: "png", width: 6000, height: 4000 }).estMB;
  const b = E({ format: "png", width: 6000, height: 4000, depth: "ushort" }).estMB;
  assert.ok(b > a);
});

test("视频固定估算、水印阶段随像素增长", () => {
  assert.equal(E({}, "video").layout, "video");
  assert.ok(E({ width: 2560, height: 1707 }, "hd-wm").estMB >= 54);
  assert.ok(E({ width: 5120, height: 3414 }, "hd-wm").estMB > E({ width: 2560, height: 1707 }, "hd-wm").estMB);
});

test("按文件大小反推像素量", () => {
  assert.ok(Math.abs(megapixelsFromSize(2_000_000, "image/heic") - 10) < 1);
  assert.ok(megapixelsFromSize(0, "image/jpeg") > 0);
});

test("[LIMIT] 消息与固定前缀(corrupt.ts 据此排除)", () => {
  const est = E({ format: "png", width: 12000, height: 9000, progressive: true });
  assert.ok(limitMessage(est, 300).startsWith("[LIMIT]"));
  assert.ok(pixelLimitMessage(20000, 20000, 268).startsWith("[LIMIT]"));
  assert.deepEqual([...NON_CORRUPT_ERROR_PREFIXES], ["[LIMIT]", "[INTERRUPTED]"]);
});
