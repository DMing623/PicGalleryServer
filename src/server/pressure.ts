// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 动态内存压力状态机(纯函数,无任何项目内依赖,便于单测)。
 *
 * 输入:每秒一次的「cgroup 工作集(anon) / 内存上限」水位(0~1)。
 * 输出:压力状态 + 对准入控制(admission.ts)的影响:
 *
 *   normal    < 70%    正常准入
 *   elevated  70~85%   有效预算 × 0.7
 *   high      85~93%   暂停「重型」任务(HEIC/视频/大图);轻任务继续;交互式 HD 等待超时返回 503
 *   critical  > 93%    暂停全部新的媒体准入(只要还有任务在跑);永不死锁:空闲时仍放行一个
 *
 * 升级立即生效;降级需要水位低于阈值再下探 hysteresis 个百分点,并连续 downSamples 次采样,避免抖动。
 */
export type PressureState = "normal" | "elevated" | "high" | "critical";

export interface PressureConfig {
  elevated: number;
  high: number;
  critical: number;
  hysteresis: number;
  downSamples: number;
}

export const DEFAULT_PRESSURE: PressureConfig = { elevated: 0.7, high: 0.85, critical: 0.93, hysteresis: 0.05, downSamples: 3 };

export interface PressureMemo {
  state: PressureState;
  /** 已连续低于降级线的采样次数 */
  below: number;
}

const RANK: Record<PressureState, number> = { normal: 0, elevated: 1, high: 2, critical: 3 };
const ORDER: PressureState[] = ["normal", "elevated", "high", "critical"];

export function levelFor(ratio: number, c: PressureConfig = DEFAULT_PRESSURE): PressureState {
  if (ratio >= c.critical) return "critical";
  if (ratio >= c.high) return "high";
  if (ratio >= c.elevated) return "elevated";
  return "normal";
}

function thresholdOf(s: PressureState, c: PressureConfig): number {
  return s === "critical" ? c.critical : s === "high" ? c.high : s === "elevated" ? c.elevated : 0;
}

export function stepPressure(prev: PressureMemo, ratio: number, c: PressureConfig = DEFAULT_PRESSURE): { memo: PressureMemo; changed: boolean } {
  const raw = levelFor(ratio, c);
  if (RANK[raw] > RANK[prev.state]) return { memo: { state: raw, below: 0 }, changed: true };
  if (RANK[raw] < RANK[prev.state]) {
    if (ratio < thresholdOf(prev.state, c) - c.hysteresis) {
      const below = prev.below + 1;
      if (below >= c.downSamples) return { memo: { state: raw, below: 0 }, changed: true };
      return { memo: { state: prev.state, below }, changed: false };
    }
    return { memo: { state: prev.state, below: 0 }, changed: false };
  }
  return { memo: { state: prev.state, below: 0 }, changed: false };
}

/** 压力状态对准入控制的影响 */
export interface PressureView {
  state: PressureState;
  /** 预算折扣系数 */
  factor: number;
  blockHeavy: boolean;
  blockAll: boolean;
}

export function pressureView(state: PressureState): PressureView {
  return {
    state,
    factor: state === "normal" ? 1 : 0.7,
    blockHeavy: state === "high" || state === "critical",
    blockAll: state === "critical",
  };
}

export const NO_PRESSURE: PressureView = pressureView("normal");
export { ORDER as PRESSURE_ORDER };
