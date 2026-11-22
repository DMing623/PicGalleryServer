// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 进程内任务队列:限制并发(THUMB_CONCURRENCY),防止批量导入时 CPU/内存被打满。
 * 状态挂在 globalThis,开发热重载下也只有一个队列。
 */
import { config } from "./config";

type Runner = (id: string) => Promise<void>;

interface QueueState {
  waiting: string[];
  queued: Set<string>;
  running: number;
  done: number;
  failed: number;
  runner: Runner | null;
  waiters: Array<() => void>;
}

const g = globalThis as typeof globalThis & { __pgsQueue?: QueueState };
const state: QueueState = (g.__pgsQueue ??= {
  waiting: [], queued: new Set(), running: 0, done: 0, failed: 0, runner: null, waiters: [],
});

export function setRunner(r: Runner) {
  state.runner = r;
}

function pump() {
  while (state.runner && state.running < config.thumbConcurrency && state.waiting.length) {
    const id = state.waiting.shift()!;
    state.running++;
    state
      .runner(id)
      .then(() => void state.done++)
      .catch(() => void state.failed++)
      .finally(() => {
        state.running--;
        state.queued.delete(id);
        pump();
        if (!state.running && !state.waiting.length) {
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
  if (priority) state.waiting.unshift(id);
  else state.waiting.push(id);
  pump();
}

export function queueStats() {
  return {
    concurrency: config.thumbConcurrency,
    running: state.running,
    waiting: state.waiting.length,
    done: state.done,
    failed: state.failed,
  };
}

/** 等待队列清空(上传接口用:让客户端拿到处理完成的元数据) */
export function idle(timeoutMs: number): Promise<void> {
  if (!state.running && !state.waiting.length) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    state.waiters.push(() => {
      clearTimeout(t);
      resolve();
    });
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
