// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 进程内任务队列:负责「任务清单 / 去重 / 重试 / dirty 补跑」;
 * 「何时可以开跑」只由 admission.ts 的 Scheduler 决定(类别并发 → 内存预算 → FIFO + 老化)。
 *
 * 流程:enqueue → 等待表(先探测类别与内存估算,只读文件头,绝不解码、绝不触发 S3 下载)
 *        → Scheduler.pick() 放行 → runner 执行 → finish 释放资源并再次 pump。
 * 状态挂在 globalThis,开发热重载下也只有一个队列。
 */
import { Scheduler, type Cls, type Limits } from "./admission";
import { config } from "./config";
import { onSample } from "./metrics";
import { NO_PRESSURE, pressureView, stepPressure, type PressureMemo } from "./pressure";

type Runner = (id: string) => Promise<void>;

/** 探测结果:类别 + 内存估算(MB)+ 置信度;reject 有值表示超出硬限制,不再解码,直接以 [LIMIT] 失败 */
export interface ProbeResult {
  cls: Cls;
  estMB: number;
  confidence?: "high" | "medium" | "low";
  reject?: string;
}
type Prober = (id: string) => Promise<ProbeResult | null>;
type Rejector = (id: string, reason: string) => Promise<void>;

interface QueueState {
  sched: Scheduler;
  queued: Set<string>;
  done: number;
  failed: number;
  runner: Runner | null;
  prober: Prober | null;
  rejector: Rejector | null;
  waiters: Array<() => void>;
  /** 每个 id 的重试次数(指数退避,issue §2.7) */
  attempts: Map<string, number>;
  /** 退避等待中的重试定时器:退避期间任务不在 queued/running,必须靠它才能让 idle/idleIds 知道「还没处理完」 */
  retryTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** 正在执行的 id 集合,以及「执行期间又被要求重新处理」的 id(执行结束后补跑一次) */
  runningIds: Set<string>;
  dirty: Set<string>;
  probing: Set<string>;
  pressure: PressureMemo;
  pressureSince: number;
  pressureReason: string;
  sampling: boolean;
}

export function schedulerLimits(): Limits {
  const total = config.thumbConcurrency;
  return {
    total,
    byClass: { image: total, heic: Math.min(total, config.heicConcurrency), video: Math.min(total, config.videoConcurrency) },
    budgetMB: config.media.budgetMB,
    heavyMB: config.media.heavyMB,
    agingMs: 30_000,
    window: 64,
  };
}

const g = globalThis as typeof globalThis & { __pgsQueue2?: QueueState };
const state: QueueState = (g.__pgsQueue2 ??= {
  sched: new Scheduler(schedulerLimits()),
  queued: new Set(), done: 0, failed: 0, runner: null, prober: null, rejector: null, waiters: [], attempts: new Map(), retryTimers: new Map(),
  runningIds: new Set(), dirty: new Set(), probing: new Set(),
  pressure: { state: "normal", below: 0 }, pressureSince: Date.now(), pressureReason: "", sampling: false,
});
state.retryTimers ??= new Map(); // 热重载沿用旧 globalThis 状态时补齐新字段
const sched = state.sched;
sched.limits = schedulerLimits(); // 热重载后配置可能变化

/** 准入控制器(HD 请求也通过它申请内存预算) */
export function getScheduler(): Scheduler {
  return sched;
}

const MAX_ATTEMPTS = 3;
const PROBE_PARALLEL = 4;
let probeActive = 0;

export function setRunner(r: Runner) {
  state.runner = r;
}
export function setProber(p: Prober, rejector: Rejector) {
  state.prober = p;
  state.rejector = rejector;
}

/** 压力保护:订阅每秒内存采样,用纯函数状态机驱动准入(只订阅一次) */
function startPressureGuard() {
  if (state.sampling || !config.media.pressureGuard) return;
  state.sampling = true;
  onSample((s) => {
    const { memo, changed } = stepPressure(state.pressure, s.ratio);
    state.pressure = memo;
    if (changed) {
      state.pressureSince = Date.now();
      state.pressureReason = `水位 ${Math.round(s.ratio * 100)}%(工作集 ${Math.round(s.workingSet / 1048576)}MB)`;
      console.warn(`[media] 内存压力 → ${memo.state}:${state.pressureReason}`);
    }
    sched.setPressure(memo.state === "normal" ? NO_PRESSURE : pressureView(memo.state));
  });
}

function finishTask(id: string) {
  state.queued.delete(id);
  if (state.dirty.delete(id)) {
    state.attempts.delete(id);
    enqueue(id, true);
  }
}

/** 探测队首窗口内尚未探测的任务(独立的小并发,只读文件头;不占内存预算) */
function probeWindow() {
  if (!state.prober) {
    // 没有探测器(测试/早期启动):按普通图片直接放行
    for (const e of sched.unprobed()) sched.setProbed(e.id, "image", 0);
    return;
  }
  for (const e of sched.unprobed()) {
    if (probeActive >= PROBE_PARALLEL) break;
    if (state.probing.has(e.id)) continue;
    state.probing.add(e.id);
    probeActive++;
    const id = e.id;
    state
      .prober(id)
      .catch(() => null)
      .then(async (res) => {
        if (res?.reject) {
          if (sched.remove(id)) {
            sched.counters.rejectedLimit++;
            state.failed++;
            try {
              await state.rejector?.(id, res.reject);
            } catch {
              /* 写库失败时记录仍是 pending,下次启动会重新探测 */
            }
            finishTask(id);
          }
          return;
        }
        if (res?.confidence === "low") sched.counters.lowConfidence++;
        // 探测失败(null)时按普通图片、零估算放行,由 processMedia 自己报错
        sched.setProbed(id, res?.cls ?? "image", res?.estMB ?? 0);
      })
      .finally(() => {
        state.probing.delete(id);
        probeActive--;
        pump();
      });
  }
}

function pump() {
  if (!state.runner) return;
  startPressureGuard();
  probeWindow();
  for (;;) {
    const p = sched.pick();
    if (!p) break;
    runTask(p.entry);
  }
  if (!sched.run.running && !sched.waiting && !state.retryTimers.size) {
    const w = state.waiters.splice(0);
    w.forEach((f) => f());
  }
}
sched.onFreed = () => pump();

function runTask(entry: { id: string; cls: Cls; estMB: number }) {
  const id = entry.id;
  state.runningIds.add(id);
  state
    .runner!(id)
    .then(() => {
      state.done++;
      state.attempts.delete(id);
    })
    .catch(() => {
      // 失败重试:最多 3 次,间隔指数退避(1s/4s/16s)
      const n = (state.attempts.get(id) ?? 0) + 1;
      if (n <= MAX_ATTEMPTS) {
        state.attempts.set(id, n);
        // 退避期间 id 会被 finally 移出 queued,所以把定时器登记到 retryTimers:
        // idle()/idleIds() 据此判断「还有重试没做完」,媒体被删除时也能 cancelRetry() 取消
        // (以前定时器句柄没有记录,upload?wait=1 会在退避窗口内提前返回)
        const old = state.retryTimers.get(id);
        if (old) clearTimeout(old);
        const timer = setTimeout(() => {
          state.retryTimers.delete(id);
          enqueue(id, true);
        }, 1000 * 4 ** (n - 1));
        timer.unref?.();
        state.retryTimers.set(id, timer);
      } else {
        state.attempts.delete(id);
        state.failed++;
      }
    })
    .finally(() => {
      state.runningIds.delete(id);
      finishTask(id);
      sched.finish(entry); // 释放类别名额与内存预算,并触发 pump
    });
}

/** 加入队列(同 id 去重)。priority=true 插队到最前。 */
export function enqueue(id: string, priority = false) {
  // 手动/补跑入队优先于退避等待:取消尚未触发的重试定时器,立即重新处理
  const pending = state.retryTimers.get(id);
  if (pending) {
    clearTimeout(pending);
    state.retryTimers.delete(id);
  }
  if (state.queued.has(id)) {
    if (state.runningIds.has(id)) state.dirty.add(id);
    return;
  }
  state.queued.add(id);
  sched.add(id, priority);
  pump();
}

/** 媒体被删除等场景:取消退避中的重试并清掉重试计数,避免到期后对已不存在的记录再次入队 */
export function cancelRetry(ids: string[]) {
  let changed = false;
  for (const id of ids) {
    const t = state.retryTimers.get(id);
    if (t) {
      clearTimeout(t);
      state.retryTimers.delete(id);
      changed = true;
    }
    state.attempts.delete(id);
  }
  if (changed) pump();
}

export function queueStats() {
  const st = sched.stats();
  return {
    concurrency: config.thumbConcurrency,
    running: sched.run.running,
    waiting: sched.waiting,
    done: state.done,
    failed: state.failed,
    retrying: state.attempts.size,
    byClass: st.byClass,
    admission: {
      budgetMB: st.budgetMB,
      usedMB: st.usedMB,
      waiting: st.hdWaiting,
      exclusive: st.exclusive,
      lowConfidenceCount: st.lowConfidence,
      rejectedLimit: st.rejectedLimit,
      exclusiveStarts: st.exclusiveStarts,
      hdTimeouts: st.hdTimeouts,
      pressureState: st.pressureState,
      pressureReason: state.pressureReason || null,
      pressureSince: state.pressure.state === "normal" ? null : new Date(state.pressureSince).toISOString(),
    },
  };
}

/** 等待队列清空(整体) */
export function idle(timeoutMs: number): Promise<void> {
  if (!sched.run.running && !sched.waiting && !state.retryTimers.size) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    state.waiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** 等待指定 id 集合处理完(上传接口用:只等本次上传的文件,不被后台扫描拖住) */
export function idleIds(ids: string[], timeoutMs: number): Promise<void> {
  const target = new Set(ids);
  if (!target.size) return Promise.resolve();
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      for (const id of [...target]) if (!state.queued.has(id) && !state.retryTimers.has(id)) target.delete(id);
      if (!target.size || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    };
    const timer = setInterval(tick, 200);
    timer.unref?.();
    tick();
  });
}

/** 已命名限流器的运行统计(/status 展示各闸门的 active/waiting) */
const gates = ((globalThis as typeof globalThis & { __pgsGates?: Map<string, { max: number; stats: () => { active: number; waiting: number } }> }).__pgsGates ??= new Map());

export function gateStats(): Record<string, { max: number; active: number; waiting: number }> {
  const out: Record<string, { max: number; active: number; waiting: number }> = {};
  for (const [name, g] of gates) out[name] = { max: g.max, ...g.stats() };
  return out;
}

/** 小型并发限制器(单个请求内部使用);传 name 则登记到 /status */
export function limiter(max: number, name?: string) {
  let active = 0;
  const q: Array<() => void> = [];
  const next = () => {
    if (active >= max || !q.length) return;
    active++;
    q.shift()!();
  };
  if (name) gates.set(name, { max, stats: () => ({ active, waiting: q.length }) });
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      q.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
