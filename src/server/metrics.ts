// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 运行时观测:RSS 滑动窗口峰值、事件循环延迟、cgroup 水位、sharp 计数器。
 * 采样器每秒一次、unref(不阻止进程退出);状态挂在 globalThis,开发热重载下只有一份。
 * /status 的 5 秒缓存不影响这里的峰值采样。
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import os from "node:os";
import sharp from "sharp";
import { readCgroup, workingSetBytes, type CgroupInfo } from "./cgroup";

/** 峰值窗口:10 分钟,按秒采样,每 10 秒一个桶 → 60 个桶 */
const WINDOW_BUCKETS = 60;
const BUCKET_SEC = 10;

interface MetricsState {
  timer: ReturnType<typeof setInterval> | null;
  hist: IntervalHistogram | null;
  /** 每个桶内的 RSS / 工作集最大值 */
  rssBuckets: number[];
  wsBuckets: number[];
  loopP99Buckets: number[];
  loopMaxBuckets: number[];
  tick: number;
  maxRss: number;
  cgroup: CgroupInfo | null;
  /** 最近一次采样到的 cgroup 工作集占上限的比例(无上限时为 null) */
  ratio: number | null;
}

const g = globalThis as typeof globalThis & { __pgsMetrics?: MetricsState };
const st: MetricsState = (g.__pgsMetrics ??= {
  timer: null, hist: null, rssBuckets: [], wsBuckets: [], loopP99Buckets: [], loopMaxBuckets: [], tick: 0, maxRss: 0, cgroup: null, ratio: null,
});

type SampleListener = (s: { rss: number; workingSet: number; limit: number | null; ratio: number }) => void;
const listeners = new Set<SampleListener>();
/** 订阅每秒一次的内存采样(压力状态机用);返回取消订阅函数 */
export function onSample(fn: SampleListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 可用内存上限:cgroup 上限优先,无限制时用宿主机内存(与压力判据口径一致) */
export function memoryLimitBytes(cg: CgroupInfo | null = st.cgroup): number | null {
  return cg?.max ?? null;
}

function push(arr: number[], v: number) {
  const last = arr.length - 1;
  if (last < 0) arr.push(v);
  else arr[last] = Math.max(arr[last], v);
}
function rotate(arr: number[]) {
  arr.push(0);
  while (arr.length > WINDOW_BUCKETS) arr.shift();
}

function sample() {
  const rss = process.memoryUsage.rss();
  st.maxRss = Math.max(st.maxRss, rss);
  st.cgroup = readCgroup();
  const ws = workingSetBytes(st.cgroup) ?? rss;
  push(st.rssBuckets, rss);
  push(st.wsBuckets, ws);
  const limit = memoryLimitBytes(st.cgroup) ?? os.totalmem();
  st.ratio = limit > 0 ? ws / limit : null;
  if (st.hist) {
    push(st.loopP99Buckets, st.hist.percentile(99) / 1e6);
    push(st.loopMaxBuckets, st.hist.max / 1e6);
  }
  if (++st.tick % BUCKET_SEC === 0) {
    rotate(st.rssBuckets);
    rotate(st.wsBuckets);
    rotate(st.loopP99Buckets);
    rotate(st.loopMaxBuckets);
    st.hist?.reset();
  }
  if (listeners.size && st.ratio !== null) {
    for (const fn of listeners) {
      try {
        fn({ rss, workingSet: ws, limit: memoryLimitBytes(st.cgroup), ratio: st.ratio });
      } catch {
        /* 监听者异常不应影响采样 */
      }
    }
  }
}

/** 启动采样器(幂等) */
export function startMetrics() {
  if (st.timer) return;
  for (const a of [st.rssBuckets, st.wsBuckets, st.loopP99Buckets, st.loopMaxBuckets]) a.push(0);
  try {
    st.hist = monitorEventLoopDelay({ resolution: 20 });
    st.hist.enable();
  } catch {
    st.hist = null;
  }
  sample();
  st.timer = setInterval(sample, 1000);
  st.timer.unref?.();
}

const mb = (n: number | null) => (n === null ? null : Math.round((n / 1048576) * 10) / 10);

/** /status 使用的内存与运行时快照 */
export function runtimeSnapshot() {
  const m = process.memoryUsage();
  const cg = st.cgroup ?? readCgroup();
  const ws = workingSetBytes(cg);
  const winMax = (a: number[]) => (a.length ? Math.max(...a) : 0);
  let sharpInfo: Record<string, unknown>;
  try {
    sharpInfo = { cache: sharp.cache(), counters: sharp.counters(), concurrency: sharp.concurrency() };
  } catch {
    sharpInfo = {};
  }
  return {
    memory: {
      rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers,
      /** 进程启动以来 RSS 最大值 */
      maxRss: Math.max(st.maxRss, m.rss),
      /** 最近 10 分钟内 RSS 的最大值 */
      rssPeak10m: Math.max(winMax(st.rssBuckets), m.rss),
      workingSetPeak10m: winMax(st.wsBuckets),
      cgroup: cg
        ? { version: cg.version, current: cg.current, max: cg.max, anon: cg.anon, inactiveFile: cg.inactiveFile, workingSet: ws }
        : null,
      /** 工作集 / 上限(0~1);无 cgroup 上限时按宿主机内存折算 */
      pressureRatio: st.ratio === null ? null : Math.round(st.ratio * 1000) / 1000,
      totalMemory: os.totalmem(),
    },
    sharp: sharpInfo,
    eventLoop: st.hist
      ? { p99Ms: Math.round(winMax(st.loopP99Buckets) * 10) / 10, maxMs: Math.round(winMax(st.loopMaxBuckets) * 10) / 10, windowSec: WINDOW_BUCKETS * BUCKET_SEC }
      : null,
  };
}

export { mb as toMb };
