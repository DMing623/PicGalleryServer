// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 进程内任务队列:限制并发(THUMB_CONCURRENCY),防止批量导入时 CPU/内存被打满。
 * 状态挂在 globalThis,开发热重载下也只有一个队列。
 */
import { config } from "./config";

type Runner = (id: string) => Promise<void>;

interface QueueState {
  /** 待处理队列:用游标 head 代替 shift(),避免大数组上的 O(n) 移动(issue §6.6) */
  waiting: string[];
  head: number;
  queued: Set<string>;
  running: number;
  done: number;
  failed: number;
  runner: Runner | null;
  waiters: Array<() => void>;
  /** 每个 id 的重试次数(指数退避,issue §2.7) */
  attempts: Map<string, number>;
}

const g = globalThis as typeof globalThis & { __pgsQueue?: QueueState };
const state: QueueState = (g.__pgsQueue ??= {
  waiting: [], head: 0, queued: new Set(), running: 0, done: 0, failed: 0, runner: null, waiters: [], attempts: new Map(),
});

const MAX_ATTEMPTS = 3;

export function setRunner(r: Runner) {
  state.runner = r;
}

function pendingCount() {
  return state.waiting.length - state.head;
}

function pump() {
  while (state.runner && state.running < config.thumbConcurrency && pendingCount() > 0) {
    const id = state.waiting[state.head++];
    // 定期压缩数组,防止 head 无限增长
    if (state.head > 4096 && state.head * 2 > state.waiting.length) {
      state.waiting = state.waiting.slice(state.head);
      state.head = 0;
    }
    state.running++;
    state
      .runner(id)
      .then(() => {
        state.done++;
        state.attempts.delete(id);
      })
      .catch(() => {
        // 失败重试:最多 3 次,间隔指数退避(1s/4s/16s)
        const n = (state.attempts.get(id) ?? 0) + 1;
        if (n <= MAX_ATTEMPTS) {
          state.attempts.set(id, n);
          setTimeout(() => {
            if (!state.queued.has(id)) return;
            state.queued.delete(id);
            enqueue(id, true);
          }, 1000 * 4 ** (n - 1)).unref?.();
        } else {
          state.attempts.delete(id);
          state.failed++;
        }
      })
      .finally(() => {
        state.running--;
        state.queued.delete(id);
        pump();
        if (!state.running && !pendingCount()) {
          const w = state.waiters.splice(0);
          w.forEach((f) => f());
        }
      });
  }
}

/** 加入队列(同 id 去重)。priority=true 插队到最前。 */
export function enqueue(id: string, priority = false) {
  if (state.queued.has(id)) return;
  state.queued.add(id);
  if (priority) {
    // 插到游标前一位,保持 O(1)
    if (state.head > 0) state.waiting[--state.head] = id;
    else state.waiting.unshift(id);
  } else state.waiting.push(id);
  pump();
}

export function queueStats() {
  return {
    concurrency: config.thumbConcurrency,
    running: state.running,
    waiting: pendingCount(),
    done: state.done,
    failed: state.failed,
    retrying: state.attempts.size,
  };
}

/** 等待队列清空(整体) */
export function idle(timeoutMs: number): Promise<void> {
  if (!state.running && !pendingCount()) return Promise.resolve();
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
      for (const id of [...target]) if (!state.queued.has(id)) target.delete(id);
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

/** 小型并发限制器(单个请求内部使用) */
export function limiter(max: number) {
  let active = 0;
  const q: Array<() => void> = [];
  const next = () => {
    if (active >= max || !q.length) return;
    active++;
    q.shift()!();
  };
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
