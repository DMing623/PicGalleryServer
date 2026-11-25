// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 容器 cgroup 内存读取(只读、零依赖,可在无 cgroup 的环境安全返回 null)。
 *
 * 关键点:`memory.current`(v2)/`memory.usage_in_bytes`(v1)包含可回收的页缓存,
 * 会随读写大文件虚高,不能直接当作「应用占用」。真正的工作集看 memory.stat 的
 *   v2: anon        v1: total_rss
 * 若读不到,退而求其次用 current − inactive_file(v2: inactive_file,v1: total_inactive_file)。
 */
import fs from "node:fs";

export interface CgroupInfo {
  version: 1 | 2;
  /** 含页缓存的当前用量(字节) */
  current: number | null;
  /** 内存上限(字节);无限制为 null */
  max: number | null;
  /** 匿名内存(不含可回收页缓存) */
  anon: number | null;
  inactiveFile: number | null;
}

/** 解析 `key value` 逐行格式(memory.stat) */
export function parseKv(text: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of (text ?? "").split("\n")) {
    const m = /^(\S+)\s+(-?\d+)\s*$/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

const num = (s: string | null | undefined): number | null => {
  const t = (s ?? "").trim();
  if (!t || t === "max") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** v1 的「无限制」是一个接近 2^63 的巨大值;≥ 2^60 视为无限制 */
const V1_UNLIMITED = 2 ** 60;

export function parseCgroupV2(f: { current?: string | null; max?: string | null; stat?: string | null }): CgroupInfo {
  const st = parseKv(f.stat);
  return { version: 2, current: num(f.current), max: num(f.max), anon: st.anon ?? null, inactiveFile: st.inactive_file ?? null };
}

export function parseCgroupV1(f: { usage?: string | null; limit?: string | null; stat?: string | null }): CgroupInfo {
  const st = parseKv(f.stat);
  const limit = num(f.limit);
  return {
    version: 1,
    current: num(f.usage),
    max: limit !== null && limit < V1_UNLIMITED ? limit : null,
    anon: st.total_rss ?? st.rss ?? null,
    inactiveFile: st.total_inactive_file ?? st.inactive_file ?? null,
  };
}

const rd = (p: string): string | null => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** 读取当前容器的 cgroup 内存信息;不在 cgroup 里(或读取失败)返回 null */
export function readCgroup(root = "/sys/fs/cgroup"): CgroupInfo | null {
  const cur2 = rd(`${root}/memory.current`);
  if (cur2 !== null) return parseCgroupV2({ current: cur2, max: rd(`${root}/memory.max`), stat: rd(`${root}/memory.stat`) });
  const usage1 = rd(`${root}/memory/memory.usage_in_bytes`);
  if (usage1 !== null) {
    return parseCgroupV1({ usage: usage1, limit: rd(`${root}/memory/memory.limit_in_bytes`), stat: rd(`${root}/memory/memory.stat`) });
  }
  return null;
}

/** 应用真实工作集:优先 anon,其次 current − inactiveFile,都没有返回 null */
export function workingSetBytes(cg: CgroupInfo | null): number | null {
  if (!cg) return null;
  if (cg.anon !== null) return cg.anon;
  if (cg.current !== null) return Math.max(0, cg.current - (cg.inactiveFile ?? 0));
  return null;
}
