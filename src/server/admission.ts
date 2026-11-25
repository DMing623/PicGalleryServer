// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 媒体处理的【单点准入控制】(纯逻辑,无任何项目内依赖,便于 node:test 单测)。
 *
 * 原则:
 *  1. 预算是准入条件,不是第二个队列。所有「等待」只发生在这里:
 *     后台派生任务在 waiting 表里等,交互式 HD 请求在 hdWait 表里等;
 *     判定顺序固定:总并发 → 类别并发 → 内存预算(含压力折扣)→ FIFO + 老化(防饥饿)。
 *  2. 类别分池:图片 / HEIC / 视频各有容量,取下一个任务时跳过「暂时没有容量的类别」,
 *     不会再出现「HEIC 占着槽位等闸门、JPEG 明明能跑却被堵住」的队首阻塞。
 *  3. 软预算 / 硬限制:budgetMB 是软预算(空闲时允许独占启动一个超预算任务);
 *     超过硬限制的任务由调用方拒绝(见 estimate.ts / queue.ts),这里不负责。
 *  4. 永不死锁:没有任何持有者(holders === 0)时,无论预算与压力状态如何都放行一个。
 *  5. 禁止嵌套:在已持有 HD 预算的调用链里再申请会直接抛错(AsyncLocalStorage)。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type Cls = "image" | "heic" | "video";
export const CLASSES: readonly Cls[] = ["image", "heic", "video"];

export interface Limits {
  /** 后台任务总并发(= THUMB_CONCURRENCY) */
  total: number;
  /** 各类别并发上限(类别上限是 total 的子限制) */
  byClass: Record<Cls, number>;
  /** 软预算 MB;0 = 关闭预算(只按并发) */
  budgetMB: number;
  /** 「重型任务」的估算门槛(MB):压力 high 时被暂停 */
  heavyMB: number;
  /** 等待超过该时长的受预算阻塞任务成为栅栏,后面的小任务不得插队 */
  agingMs: number;
  /** 每个类别队首最多考察多少个任务(同时也是 probe 的窗口大小) */
  window: number;
}

export interface PressureLike {
  state: string;
  factor: number;
  blockHeavy: boolean;
  blockAll: boolean;
}
const CALM: PressureLike = { state: "normal", factor: 1, blockHeavy: false, blockAll: false };

export interface RunState {
  running: number;
  byClass: Record<Cls, number>;
  usedMB: number;
  /** 持有预算的总数(后台任务 + HD 请求) */
  holders: number;
}

export interface Entry {
  id: string;
  /** null = 尚未探测(调度器不会启动它,等待 setProbed) */
  cls: Cls | null;
  estMB: number;
  since: number;
  /** 全局入队序号(优先任务为负且递减),跨类别按它保持 FIFO */
  seq: number;
}

export type Verdict = { ok: true; exclusive: boolean } | { ok: false; reason: "total" | "class" | "budget" | "pressure" };

export const isHeavy = (cls: Cls, estMB: number, heavyMB: number) => cls !== "image" || estMB >= heavyMB;

/** 预算 + 压力判定(后台任务与 HD 共用) */
export function budgetVerdict(estMB: number, cls: Cls, s: RunState, l: Limits, p: PressureLike): Verdict {
  const idle = s.holders === 0;
  if (!idle && p.blockAll) return { ok: false, reason: "pressure" };
  if (!idle && p.blockHeavy && isHeavy(cls, estMB, l.heavyMB)) return { ok: false, reason: "pressure" };
  if (l.budgetMB <= 0) return { ok: true, exclusive: false };
  if (s.usedMB + estMB <= l.budgetMB * p.factor) return { ok: true, exclusive: false };
  if (idle) return { ok: true, exclusive: true };
  return { ok: false, reason: "budget" };
}

/** 后台任务能否启动(纯函数,可单测) */
export function canAdmit(e: { cls: Cls; estMB: number }, s: RunState, l: Limits, p: PressureLike = CALM): Verdict {
  if (s.running >= l.total) return { ok: false, reason: "total" };
  if (s.byClass[e.cls] >= l.byClass[e.cls]) return { ok: false, reason: "class" };
  return budgetVerdict(e.estMB, e.cls, s, l, p);
}

export class AdmissionTimeoutError extends Error {
  constructor(message = "等待内存预算超时") {
    super(message);
    this.name = "AdmissionTimeoutError";
  }
}
export class AdmissionAbortError extends Error {
  constructor(message = "请求已取消") {
    super(message);
    this.name = "AdmissionAbortError";
  }
}

export interface Reservation {
  readonly estMB: number;
  /** 收缩(或放大)已持有的估算值,收缩会立即唤醒等待者(例如 HD:转换完成后只需保留水印阶段的预算) */
  adjust(estMB: number): void;
  release(): void;
}

interface HdWaiter {
  estMB: number;
  cls: Cls;
  since: number;
  grant: (r: Reservation) => void;
  fail: (e: Error) => void;
  cleanup: () => void;
}

const nestedGuard = new AsyncLocalStorage<boolean>();

export class Scheduler {
  /**
   * 等待表按类别分队列(类别满额时整队跳过,不会再出现「队首是 HEIC 就堵住后面所有 JPEG」),
   * 每个条目带全局递增序号 seq,跨类别按 seq(= 入队先后)取最老的可运行任务,保持整体 FIFO。
   * 尚未探测(不知道类别/估算)的任务放在 pre 里按序等待 probe。
   */
  private qs: Record<Cls, Entry[]> = { image: [], heic: [], video: [] };
  private pre: Entry[] = [];
  private hi = 0;
  private lo = 0;
  readonly run: RunState = { running: 0, byClass: { image: 0, heic: 0, video: 0 }, usedMB: 0, holders: 0 };
  private hdWait: HdWaiter[] = [];
  private pressure: PressureLike = CALM;
  /** 预算被释放后回调(队列据此再次 pump) */
  onFreed: (() => void) | null = null;
  /** 统计 */
  readonly counters = { exclusiveStarts: 0, lowConfidence: 0, rejectedLimit: 0, hdTimeouts: 0, hdGranted: 0 };
  private lastExclusive = false;

  limits: Limits;
  private readonly now: () => number;

  // 注意:不使用「构造函数参数属性」语法,这样本文件可被 Node 直接以类型剥离方式加载(单测)
  constructor(limits: Limits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  get waiting(): number {
    return this.pre.length + this.qs.image.length + this.qs.heic.length + this.qs.video.length;
  }
  get hdWaiting(): number {
    return this.hdWait.length;
  }
  get pressureState(): string {
    return this.pressure.state;
  }
  get exclusive(): boolean {
    return this.lastExclusive;
  }

  setPressure(p: PressureLike) {
    const was = this.pressure.state;
    this.pressure = p;
    if (was !== p.state) this.poke();
  }

  private place(e: Entry & { cls: Cls }, front: boolean) {
    const q = this.qs[e.cls];
    if (front && (q.length === 0 || e.seq < q[0].seq)) {
      q.unshift(e);
      return;
    }
    // 按 seq 升序插入(探测可能乱序完成,必须还原入队先后)
    let i = q.length;
    while (i > 0 && q[i - 1].seq > e.seq) i--;
    q.splice(i, 0, e);
  }

  /** 加入等待表。priority = 插到最前。不传 probed 表示尚未探测。 */
  add(id: string, priority = false, probed?: { cls: Cls; estMB: number }) {
    const e: Entry = { id, cls: probed?.cls ?? null, estMB: probed?.estMB ?? 0, since: this.now(), seq: priority ? --this.lo : ++this.hi };
    if (e.cls) this.place(e as Entry & { cls: Cls }, priority);
    else if (priority) this.pre.unshift(e);
    else this.pre.push(e);
  }

  /** 等待探测队列的队首窗口 */
  unprobed(): Entry[] {
    return this.pre.slice(0, this.limits.window);
  }

  setProbed(id: string, cls: Cls, estMB: number) {
    const i = this.pre.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [e] = this.pre.splice(i, 1);
    e.cls = cls;
    e.estMB = estMB;
    this.place(e as Entry & { cls: Cls }, false);
  }

  /** 从等待表摘除(探测阶段被判定为超限等) */
  remove(id: string): boolean {
    let i = this.pre.findIndex((x) => x.id === id);
    if (i >= 0) {
      this.pre.splice(i, 1);
      return true;
    }
    for (const c of CLASSES) {
      i = this.qs[c].findIndex((x) => x.id === id);
      if (i >= 0) {
        this.qs[c].splice(i, 1);
        return true;
      }
    }
    return false;
  }

  /** 取下一个可以启动的任务(已预留资源);没有则返回 null */
  pick(): { entry: Entry & { cls: Cls }; exclusive: boolean } | null {
    if (this.run.running >= this.limits.total) return null;
    // 交互式 HD 优先:有 HD 请求在等预算时,后台任务不再启动,免得把刚释放的预算抢走
    if (this.hdWait.length && this.limits.budgetMB > 0 && this.run.holders > 0) return null;
    const t = this.now();
    // 有容量的类别,按各自队首的入队先后排序
    const order = CLASSES.filter((c) => this.qs[c].length && this.run.byClass[c] < this.limits.byClass[c]).sort((a, b) => this.qs[a][0].seq - this.qs[b][0].seq);
    for (const c of order) {
      const q = this.qs[c];
      const n = Math.min(this.limits.window, q.length);
      for (let i = 0; i < n; i++) {
        const e = q[i];
        const v = canAdmit({ cls: c, estMB: e.estMB }, this.run, this.limits, this.pressure);
        if (v.ok) {
          q.splice(i, 1);
          this.hold(c, e.estMB, true);
          this.lastExclusive = v.exclusive;
          if (v.exclusive) this.counters.exclusiveStarts++;
          return { entry: e as Entry & { cls: Cls }, exclusive: v.exclusive };
        }
        // 被预算/压力阻塞且已等待很久:成为栅栏,保护它不被后来的小任务饿死
        if ((v.reason === "budget" || v.reason === "pressure") && t - e.since >= this.limits.agingMs) return null;
      }
    }
    return null;
  }

  private hold(cls: Cls, estMB: number, background: boolean) {
    this.run.holders++;
    this.run.usedMB += estMB;
    if (background) {
      this.run.running++;
      this.run.byClass[cls]++;
    }
  }

  /** 后台任务结束 */
  finish(entry: { cls: Cls; estMB: number }) {
    this.run.running--;
    this.run.byClass[entry.cls]--;
    this.run.holders--;
    this.run.usedMB = Math.max(0, this.run.usedMB - entry.estMB);
    this.freed();
  }

  private freed() {
    this.drainHd();
    this.onFreed?.();
  }

  /** 状态变化(压力降级等)后重新尝试 */
  poke() {
    this.drainHd();
    this.onFreed?.();
  }

  private drainHd() {
    if (!this.hdWait.length) return;
    const t = this.now();
    for (let i = 0; i < this.hdWait.length; ) {
      const w = this.hdWait[i];
      const v = budgetVerdict(w.estMB, w.cls, this.run, this.limits, this.pressure);
      if (v.ok) {
        this.hdWait.splice(i, 1);
        w.cleanup();
        this.lastExclusive = v.exclusive;
        if (v.exclusive) this.counters.exclusiveStarts++;
        w.grant(this.makeReservation(w.cls, w.estMB));
        continue; // splice 后 i 不变
      }
      // 等得太久的 HD 请求同样是栅栏
      if (t - w.since >= this.limits.agingMs) break;
      i++;
    }
  }

  private makeReservation(cls: Cls, estMB: number): Reservation {
    this.hold(cls, estMB, false);
    this.counters.hdGranted++;
    let cur = estMB;
    let done = false;
    const self = this;
    return {
      get estMB() {
        return cur;
      },
      adjust(next: number) {
        if (done) return;
        self.run.usedMB = Math.max(0, self.run.usedMB - cur + next);
        const shrank = next < cur;
        cur = next;
        if (shrank) self.freed();
      },
      release() {
        if (done) return;
        done = true;
        self.run.holders--;
        self.run.usedMB = Math.max(0, self.run.usedMB - cur);
        self.freed();
      },
    };
  }

  /**
   * 交互式(HD)请求申请预算。预算关闭且无压力限制时立即放行。
   * 抛 AdmissionTimeoutError(等待超时)或 AdmissionAbortError(客户端断开)。
   */
  acquireHd(estMB: number, opts: { signal?: AbortSignal; timeoutMs?: number; cls?: Cls } = {}): Promise<Reservation> {
    if (nestedGuard.getStore()) return Promise.reject(new Error("admission: 禁止嵌套申请预算(同一调用链内已持有 HD 预算)"));
    const cls = opts.cls ?? "image";
    if (opts.signal?.aborted) return Promise.reject(new AdmissionAbortError());
    // 保持 FIFO:已有人在等且当前并非空闲时,排到队尾
    const v = this.hdWait.length === 0 || this.run.holders === 0 ? budgetVerdict(estMB, cls, this.run, this.limits, this.pressure) : null;
    if (v?.ok) {
      this.lastExclusive = v.exclusive;
      if (v.exclusive) this.counters.exclusiveStarts++;
      return Promise.resolve(this.makeReservation(cls, estMB));
    }
    return new Promise<Reservation>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        this.dropHd(w);
        reject(new AdmissionAbortError());
      };
      const w: HdWaiter = {
        estMB, cls, since: this.now(),
        grant: resolve,
        fail: reject,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
        },
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.dropHd(w);
          this.counters.hdTimeouts++;
          reject(new AdmissionTimeoutError());
        }, opts.timeoutMs);
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.hdWait.push(w);
    });
  }

  private dropHd(w: HdWaiter) {
    const i = this.hdWait.indexOf(w);
    if (i >= 0) this.hdWait.splice(i, 1);
    w.cleanup();
  }

  /** 申请 → 在「禁止嵌套」上下文里执行 → 必定释放 */
  async withHd<T>(estMB: number, fn: (r: Reservation) => Promise<T>, opts: { signal?: AbortSignal; timeoutMs?: number; cls?: Cls } = {}): Promise<T> {
    const r = await this.acquireHd(estMB, opts);
    try {
      return await nestedGuard.run(true, () => fn(r));
    } finally {
      r.release();
    }
  }

  stats() {
    return {
      budgetMB: this.limits.budgetMB,
      usedMB: Math.round(this.run.usedMB),
      holders: this.run.holders,
      hdWaiting: this.hdWait.length,
      exclusive: this.lastExclusive && this.run.holders > 0,
      pressureState: this.pressure.state,
      byClass: Object.fromEntries(CLASSES.map((c) => [c, { running: this.run.byClass[c], waiting: this.qs[c].length, max: this.limits.byClass[c] }])),
      unprobed: this.pre.length,
      ...this.counters,
    };
  }
}
