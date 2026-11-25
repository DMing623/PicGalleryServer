#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 媒体内存治理的黑盒测试 —— 对一个【正在运行】的服务做验证(不需要 root、不需要 Docker)。
 *
 * 被测服务必须用 `MEDIA_MAX_INPUT_MP=10`(最小值)启动,test-matrix.mjs 的 media 阶段会自动这样做;
 * 单独运行:
 *   MEDIA_MAX_INPUT_MP=10 SHARP_CONCURRENCY=1 ADMIN_PASSWORD=test-pass-123 SESSION_SECRET=test-secret \
 *     DATA_DIR=/tmp/pgs-m DB_DRIVER=sqlite PORT=3300 node node_modules/next/dist/bin/next start -p 3300 &
 *   BASE=http://127.0.0.1:3300 ADMIN_PASSWORD=test-pass-123 DATA_DIR=/tmp/pgs-m node scripts/test-media.mjs
 *
 * 覆盖:/status 观测字段(external/arrayBuffers/cgroup/sharp/闸门/事件循环/类别队列/准入)、
 *       超过输入像素上限 → [LIMIT](不解码、不重试)、「疑似损坏文件」清理绝不删除 [LIMIT] 的原文件、
 *       重新处理幂等、批量小图全部 ready 且预算归零、普通图 HD 正常、非 root 下的数据目录可写。
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Client, createSuite, sleep, waitFor, waitProcessed } from "./lib/harness.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:3300";
const PASS = process.env.ADMIN_PASSWORD || "test-pass-123";
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;
const t = createSuite("media-governance");

const solid = (w, h, c = { r: 90, g: 120, b: 200 }) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).jpeg({ quality: 70 }).toBuffer();
const rnd = () => ({ r: Math.random() * 255, g: Math.random() * 255, b: Math.random() * 255 });

const admin = await new Client(BASE).login("admin", PASS);
const stat = async () => (await admin.get("/status")).data;
const maxMp = (await stat()).config.mediaMaxInputMp;

t.section("1. /status 观测字段");
{
  const s = await stat();
  const m = s.memory;
  for (const k of ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers", "maxRss", "rssPeak10m"]) t.ok(typeof m[k] === "number", `memory.${k} 是数字`);
  t.ok(m.maxRss >= m.rss * 0.5, "maxRss 合理");
  // cgroup:容器里应有对象;裸机/macOS 可以为 null,但字段必须存在
  t.ok("cgroup" in m, "memory.cgroup 字段存在(无 cgroup 时为 null)");
  if (m.cgroup) t.ok(m.cgroup.workingSet === null || m.cgroup.workingSet > 0, "cgroup.workingSet 有值");
  t.ok(s.sharp && typeof s.sharp.concurrency === "number" && s.sharp.counters && s.sharp.cache, "sharp.{cache,counters,concurrency}");
  t.ok(s.eventLoop && typeof s.eventLoop.p99Ms === "number", "eventLoop.p99Ms");
  t.ok(s.queue.gates && "hd" in s.queue.gates && "heic" in s.queue.gates, "queue.gates 含 hd / heic 闸门", JSON.stringify(Object.keys(s.queue.gates || {})));
  t.ok(s.queue.byClass && ["image", "heic", "video"].every((c) => c in s.queue.byClass), "queue.byClass 含三类");
  const a = s.queue.admission;
  t.ok(a && "usedMB" in a && "budgetMB" in a && "pressureState" in a && "lowConfidenceCount" in a, "queue.admission 字段齐全");
  t.eq(s.config.mediaMaxInputMp, Number(process.env.EXPECT_MAX_INPUT_MP || 10), "有效配置 mediaMaxInputMp 与启动参数一致");
  t.ok(s.config.mediaBudget && s.config.mediaBudget.derivation, "预算推导过程可见(config.mediaBudget.derivation)");
}

t.section("2. 正常图片与超限图片");
const alb = (await admin.post("/albums", { name: "media-gov-" + Date.now(), visibility: "public" })).data;
const upload1 = async (buf, name) => {
  const r = await admin.upload({ album: alb.code }, [{ data: buf, filename: name }]);
  const res = r.data?.results?.[0];
  if (!res?.id) throw new Error("上传失败 " + r.buf.toString().slice(0, 200));
  return res.id;
};
const smallId = await upload1(await solid(800, 600, rnd()), "ok.jpg");
// 超限:宽高乘积 > maxMp 百万像素(纯色 JPEG 文件很小)
const side = Math.ceil(Math.sqrt((maxMp + 2) * 1e6 * (4 / 3)));
const bigW = side, bigH = Math.round((maxMp + 2) * 1e6 / side) + 1;
const bigId = await upload1(await solid(bigW, bigH, rnd()), "huge.jpg");
const done = await waitProcessed(admin, [smallId, bigId], { timeout: 90_000 });
t.eq(done[smallId].status, "ready", "正常图片 ready");
t.eq(done[bigId].status, "failed", `${bigW}×${bigH}(>${maxMp}MP)被拒绝`);
t.ok(String(done[bigId].error || "").startsWith("[LIMIT]"), "错误信息以 [LIMIT] 开头", String(done[bigId].error));
t.ok(/MEDIA_MAX_INPUT_MP/.test(String(done[bigId].error || "")), "错误信息告诉用户该调哪个配置");
{
  const th = await admin.get(`/media/${smallId}/thumb`);
  t.eq(th.status, 200, "正常图片缩略图可取");
}

t.section("3. [LIMIT] 不是「疑似损坏」:不计入清理列表、清理不删原文件");
{
  const c = (await admin.get("/status/corrupt")).data;
  t.ok(!c.items.some((i) => i.id === bigId), "[LIMIT] 文件不在疑似损坏列表里");
  t.ok(c.limited >= 1, "corrupt.limited 单独统计超限文件", String(c.limited));
  const r = await admin.post("/status/corrupt/purge", {});
  t.ok(r.status === 200, "清理接口可调用(无损坏文件时 removed=0)");
  const d = await admin.get(`/media/${bigId}`);
  t.eq(d.status, 200, "清理后超限文件的记录仍在");
  if (DATA) {
    const key = d.data?.storageKey;
    // storageKey 相对于 DATA_DIR(受管相册形如 albums/<相册>/<文件>),兼容相对 albums 目录的写法
    const cands = key ? [path.join(DATA, key), path.join(DATA, "albums", key)] : [];
    t.ok(cands.some((f) => fs.existsSync(f)), "清理后超限文件的原文件仍在磁盘上", cands.join(" | "));
  } else t.skip("磁盘上原文件仍在", "未提供 DATA_DIR");
}

t.section("4. 重新处理超限文件:幂等、不陷入重试循环");
{
  const r = await admin.post(`/media/${bigId}/reprocess`);
  t.ok(r.status === 200, "reprocess 接口 200");
  const d = (await waitProcessed(admin, [bigId], { timeout: 60_000 }))[bigId];
  t.eq(d.status, "failed", "仍超限 → 再次以 failed 结束");
  t.ok(String(d.error).startsWith("[LIMIT]"), "仍是 [LIMIT]");
  await sleep(2500); // 若误入重试(退避 1s/4s/16s),这里会再次变化或 /status 的 retrying>0
  const s = await stat();
  t.eq(s.queue.retrying, 0, "没有重试中的任务(超限不重试)");
}

t.section("5. 批量小图:全部 ready,准入预算归零");
{
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(await upload1(await solid(640 + i, 480, rnd()), `b${i}.jpg`));
  const res = await waitProcessed(admin, ids, { timeout: 90_000 });
  t.ok(ids.every((id) => res[id].status === "ready"), "12 张全部 ready");
  await waitFor(async () => {
    const s = await stat();
    return s.queue.running === 0 && s.queue.waiting === 0;
  }, { timeout: 30_000, what: "队列空闲" });
  await sleep(5200); // /status 有 5 秒缓存
  const s = await stat();
  t.eq(s.queue.admission.usedMB, 0, "空闲后已用预算为 0(没有泄漏)");
  t.eq(s.queue.admission.pressureState === "normal" || typeof s.queue.admission.pressureState === "string", true, "压力状态有值");
  t.ok(s.queue.done >= 13, "完成计数增长", String(s.queue.done));
}

t.section("6. 高清预览仍正常(预算只增不拦)");
{
  const tok = await admin.get(`/media/${smallId}/hd-token?w=1280`);
  const tokData = tok.data;
  if (!tokData?.token) t.skip("HD 令牌接口形态与预期不同,HD 由 test-hd.mjs 覆盖", `status ${tok.status}`);
  else {
    const r = await admin.get(`/media/${smallId}/hd?t=${encodeURIComponent(tokData.token)}&w=1280`);
    t.ok(r.status === 200 && (r.headers.get("content-type") || "").includes("webp"), "HD 返回 webp", `status ${r.status}`);
  }
}

t.section("7. 数据目录写入(非 root 运行也必须可写)");
if (DATA) {
  const probe = path.join(DATA, "tmp", `.write-probe-${process.pid}`);
  try {
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, "x");
    fs.unlinkSync(probe);
    t.ok(true, "DATA_DIR/tmp 可写");
  } catch (e) {
    t.ok(false, "DATA_DIR/tmp 可写", String(e.message));
  }
  t.ok(fs.existsSync(path.join(DATA, "derived")), "derived 目录已创建");
} else t.skip("数据目录写入检查", "未提供 DATA_DIR");

process.exit(t.summary() ? 0 : 1);
