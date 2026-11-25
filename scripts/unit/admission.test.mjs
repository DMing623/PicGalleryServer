// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// 准入控制 / 分池调度 / 压力状态机的纯逻辑测试(不依赖 sharp / DB / 网络)
import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler, canAdmit, budgetVerdict, AdmissionTimeoutError, AdmissionAbortError } from "../../src/server/admission.ts";
import { stepPressure, levelFor, pressureView, DEFAULT_PRESSURE } from "../../src/server/pressure.ts";

const limits = (o = {}) => ({ total: 4, byClass: { image: 4, heic: 1, video: 2 }, budgetMB: 0, heavyMB: 100, agingMs: 30_000, window: 64, ...o });
const clock = () => {
  let t = 0;
  return { now: () => t, adv: (ms) => (t += ms) };
};
/** 模拟「任务跑完」:按 durations 驱动事件,返回每个任务的完成时刻 */
function simulate(jobs, lim, { budget = false, ck = clock() } = {}) {
  const s = new Scheduler(lim, ck.now);
  for (const j of jobs) s.add(j.id, false, { cls: j.cls, estMB: j.est ?? 0 });
  const done = {};
  const running = [];
  let guard = 0;
  while ((s.waiting || running.length) && guard++ < 100000) {
    let p;
    while ((p = s.pick())) running.push({ e: p.entry, end: ck.now() + jobs.find((j) => j.id === p.entry.id).dur });
    if (!running.length) throw new Error("死锁:有等待任务但无运行任务且无法启动 " + s.waiting);
    running.sort((a, b) => a.end - b.end);
    const r = running.shift();
    ck.adv(Math.max(0, r.end - ck.now()));
    done[r.e.id] = ck.now();
    s.finish(r.e);
  }
  return { done, s };
}

test("canAdmit:总并发 → 类别并发 → 预算 的判定顺序", () => {
  const l = limits({ budgetMB: 100 });
  const st = { running: 4, byClass: { image: 4, heic: 0, video: 0 }, usedMB: 0, holders: 4 };
  assert.deepEqual(canAdmit({ cls: "image", estMB: 1 }, st, l), { ok: false, reason: "total" });
  const st2 = { running: 1, byClass: { image: 0, heic: 1, video: 0 }, usedMB: 10, holders: 1 };
  assert.deepEqual(canAdmit({ cls: "heic", estMB: 1 }, st2, l), { ok: false, reason: "class" });
  assert.deepEqual(canAdmit({ cls: "image", estMB: 95 }, st2, l), { ok: false, reason: "budget" });
  assert.deepEqual(canAdmit({ cls: "image", estMB: 90 }, st2, l), { ok: true, exclusive: false });
});

test("T-3:100 个 HEIC + 100 个 JPEG 同时入队——JPEG 不被 HEIC 拖到最后,HEIC 也不会被饿死", () => {
  const jobs = [];
  for (let i = 0; i < 100; i++) jobs.push({ id: `h${i}`, cls: "heic", dur: 2000 });
  for (let i = 0; i < 100; i++) jobs.push({ id: `j${i}`, cls: "image", dur: 200 });
  const { done } = simulate(jobs, limits());
  const lastJpeg = Math.max(...Object.entries(done).filter(([k]) => k[0] === "j").map(([, v]) => v));
  const lastHeic = Math.max(...Object.entries(done).filter(([k]) => k[0] === "h").map(([, v]) => v));
  // 旧实现(嵌套闸门):4 个槽里 3 个占着等 HEIC 闸门,JPEG 吞吐只剩 ~1 路 → ≈ 100×200ms/1 = 20s 且被拖到 HEIC 之后
  // 分池后:JPEG 跑在 3 个空闲槽里,≈ 100×200/3 ≈ 7s 内全部完成,远早于 HEIC(100×2s=200s)
  assert.ok(lastJpeg < 10_000, `JPEG 应在 10s 内完成,实际 ${lastJpeg}`);
  assert.ok(lastHeic <= 100 * 2000 + 1000, `HEIC 应近似串行完成,实际 ${lastHeic}`);
  assert.equal(Object.keys(done).length, 200);
});

test("HEIC 在持续到来的 JPEG 流中不被饿死(FIFO:更早入队的 HEIC 先拿到槽)", () => {
  const ck = clock();
  const s = new Scheduler(limits({ total: 2, byClass: { image: 2, heic: 1, video: 1 } }), ck.now);
  s.add("h0", false, { cls: "heic", estMB: 0 });
  for (let i = 0; i < 10; i++) s.add(`j${i}`, false, { cls: "image", estMB: 0 });
  const first = s.pick();
  assert.equal(first.entry.id, "h0");
});

test("类别满额时跳过队首,取后面可运行的任务(不再队首阻塞)", () => {
  const s = new Scheduler(limits({ total: 3 }));
  for (const id of ["h1", "h2", "h3"]) s.add(id, false, { cls: "heic", estMB: 0 });
  s.add("j1", false, { cls: "image", estMB: 0 });
  assert.equal(s.pick().entry.id, "h1");
  assert.equal(s.pick().entry.id, "j1"); // h2、h3 因 heic 类满被跳过
  assert.equal(s.pick(), null, "h2、h3 受 heic 类上限约束,此时已无其它可运行任务");
});

test("未探测的任务不会被启动;probed 之后才可运行;remove 可摘除(超限拒绝)", () => {
  const s = new Scheduler(limits());
  s.add("a");
  assert.equal(s.pick(), null);
  assert.equal(s.unprobed().length, 1);
  s.setProbed("a", "image", 10);
  assert.equal(s.pick().entry.id, "a");
  s.add("b");
  assert.equal(s.remove("b"), true);
  assert.equal(s.waiting, 0);
});

test("priority 插队到最前", () => {
  const s = new Scheduler(limits({ total: 1 }));
  s.add("a", false, { cls: "image", estMB: 0 });
  s.add("b", true, { cls: "image", estMB: 0 });
  assert.equal(s.pick().entry.id, "b");
});

test("软预算:超预算任务只在空闲时独占启动,期间其他任务等待", () => {
  const s = new Scheduler(limits({ budgetMB: 100 }));
  s.add("big", false, { cls: "image", estMB: 300 });
  s.add("small", false, { cls: "image", estMB: 10 });
  const p = s.pick();
  assert.equal(p.entry.id, "big");
  assert.equal(p.exclusive, true);
  assert.equal(s.pick(), null, "独占期间 small 必须等待");
  s.finish(p.entry);
  assert.equal(s.pick().entry.id, "small");
});

test("预算:并发总和不超过 budgetMB(4×60MB 在 150MB 预算下最多同时 2 个)", () => {
  const jobs = Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, cls: "image", est: 60, dur: 1000 }));
  const s = new Scheduler(limits({ budgetMB: 150 }));
  for (const j of jobs) s.add(j.id, false, { cls: j.cls, estMB: j.est });
  let n = 0;
  while (s.pick()) n++;
  assert.equal(n, 2);
  assert.ok(s.run.usedMB <= 150);
});

test("老化:被预算阻塞且等待过久的大任务成为栅栏,后来的小任务不得插队", () => {
  const ck = clock();
  const s = new Scheduler(limits({ budgetMB: 100, agingMs: 5000 }), ck.now);
  s.add("run", false, { cls: "image", estMB: 60 });
  const r = s.pick();
  s.add("big", false, { cls: "image", estMB: 80 }); // 60+80 > 100,被阻塞
  s.add("tiny", false, { cls: "image", estMB: 5 });
  assert.equal(s.pick().entry.id, "tiny", "未到老化时间:小任务可以越过大任务");
  ck.adv(6000);
  s.add("tiny2", false, { cls: "image", estMB: 5 });
  assert.equal(s.pick(), null, "已老化:big 成为栅栏,tiny2 不得插队");
  s.finish(r.entry);
  assert.equal(s.pick().entry.id, "big");
});

test("压力 critical:有任务在跑时暂停新准入;空闲时仍放行一个(永不死锁)", () => {
  const s = new Scheduler(limits());
  s.setPressure(pressureView("critical"));
  s.add("a", false, { cls: "image", estMB: 10 });
  s.add("b", false, { cls: "image", estMB: 10 });
  const a = s.pick();
  assert.equal(a.entry.id, "a", "空闲时放行");
  assert.equal(s.pick(), null, "已有任务在跑 → 暂停");
  s.finish(a.entry);
  assert.equal(s.pick().entry.id, "b");
});

test("压力 high:暂停重型(HEIC/视频/大图),轻任务继续", () => {
  const s = new Scheduler(limits({ heavyMB: 100 }));
  s.add("light", false, { cls: "image", estMB: 10 });
  const l = s.pick();
  s.setPressure(pressureView("high"));
  s.add("heic", false, { cls: "heic", estMB: 50 });
  s.add("bigimg", false, { cls: "image", estMB: 200 });
  s.add("light2", false, { cls: "image", estMB: 10 });
  assert.equal(s.pick().entry.id, "light2");
  void l;
});

test("压力 elevated:有效预算 ×0.7", () => {
  const l = limits({ budgetMB: 100 });
  const st = { running: 1, byClass: { image: 1, heic: 0, video: 0 }, usedMB: 50, holders: 1 };
  assert.equal(budgetVerdict(40, "image", st, l, pressureView("normal")).ok, true);
  assert.equal(budgetVerdict(40, "image", st, l, pressureView("elevated")).ok, false);
});

test("HD:预算内立即放行;超预算排队,释放后按序放行;优先于后台任务", async () => {
  const s = new Scheduler(limits({ budgetMB: 100 }));
  const r1 = await s.acquireHd(70);
  let granted = false;
  const p2 = s.acquireHd(70).then((r) => ((granted = true), r));
  await Promise.resolve();
  assert.equal(granted, false);
  s.add("bg", false, { cls: "image", estMB: 10 });
  assert.equal(s.pick(), null, "HD 在等预算时后台任务不得抢占");
  r1.release();
  const r2 = await p2;
  assert.equal(granted, true);
  r2.release();
  assert.ok(s.pick());
});

test("HD:AbortSignal 取消后从等待表摘除;超时抛 AdmissionTimeoutError", async () => {
  const s = new Scheduler(limits({ budgetMB: 50 }));
  const hold = await s.acquireHd(40);
  const ac = new AbortController();
  const p = s.acquireHd(40, { signal: ac.signal });
  assert.equal(s.hdWaiting, 1);
  ac.abort();
  await assert.rejects(p, AdmissionAbortError);
  assert.equal(s.hdWaiting, 0);
  await assert.rejects(s.acquireHd(40, { timeoutMs: 20 }), AdmissionTimeoutError);
  assert.equal(s.hdWaiting, 0);
  hold.release();
  assert.equal(s.run.usedMB, 0);
});

test("HD:adjust 收缩预算会立即唤醒等待者;release 幂等", async () => {
  const s = new Scheduler(limits({ budgetMB: 100 }));
  const r = await s.acquireHd(90);
  const waiter = s.acquireHd(50);
  r.adjust(30);
  const r2 = await waiter;
  assert.equal(s.run.usedMB, 80);
  r.release();
  r.release();
  r2.release();
  assert.equal(s.run.usedMB, 0);
  assert.equal(s.run.holders, 0);
});

test("禁止嵌套申请:在 withHd 内再次 acquireHd 直接抛错", async () => {
  const s = new Scheduler(limits({ budgetMB: 1000 }));
  await s.withHd(10, async () => {
    await assert.rejects(s.acquireHd(10), /嵌套/);
  });
  assert.equal(s.run.holders, 0);
});

test("预算关闭(budgetMB=0)时行为只受并发限制", () => {
  const s = new Scheduler(limits({ budgetMB: 0 }));
  for (let i = 0; i < 6; i++) s.add(`x${i}`, false, { cls: "image", estMB: 99999 });
  let n = 0;
  while (s.pick()) n++;
  assert.equal(n, 4);
});

/* ---------- 压力状态机 ---------- */
test("压力状态机:升级立即、降级需迟滞 + 连续 3 次", () => {
  let m = { state: "normal", below: 0 };
  const feed = (r) => ((m = stepPressure(m, r).memo), m.state);
  assert.equal(feed(0.5), "normal");
  assert.equal(feed(0.72), "elevated");
  assert.equal(feed(0.9), "high");
  assert.equal(feed(0.95), "critical");
  // 水位回落到 0.8(< 0.93-0.05):需要连续 3 次才降级,且一次降到与水位相称的档位(0.8 → elevated)
  assert.equal(feed(0.8), "critical");
  assert.equal(feed(0.8), "critical");
  assert.equal(feed(0.8), "elevated");
  // 在迟滞带内(0.68 ≥ 0.70-0.05=0.65)即使原始档位是 normal 也不降级
  for (let i = 0; i < 5; i++) assert.equal(feed(0.68), "elevated");
  assert.equal(feed(0.5), "elevated");
  assert.equal(feed(0.5), "elevated");
  assert.equal(feed(0.5), "normal");
});

test("压力状态机:抖动不会反复切换;阈值边界", () => {
  assert.equal(levelFor(0.699), "normal");
  assert.equal(levelFor(0.7), "elevated");
  assert.equal(levelFor(0.85), "high");
  assert.equal(levelFor(0.93), "critical");
  let m = { state: "elevated", below: 0 };
  let changes = 0;
  for (const r of [0.66, 0.72, 0.66, 0.72, 0.66, 0.72]) {
    const x = stepPressure(m, r, DEFAULT_PRESSURE);
    if (x.changed) changes++;
    m = x.memo;
  }
  assert.equal(changes, 0);
  assert.equal(m.state, "elevated");
});

test("pressureView 映射", () => {
  assert.deepEqual(pressureView("normal"), { state: "normal", factor: 1, blockHeavy: false, blockAll: false });
  assert.equal(pressureView("elevated").factor, 0.7);
  assert.equal(pressureView("high").blockHeavy, true);
  assert.equal(pressureView("critical").blockAll, true);
});
