// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config, dirs } from "../config";

/**
 * 高清预览临时磁盘缓存(与永久派生图 DATA_DIR/derived 完全分离)。
 *  - 基图文件名: <id>.<version>.<width>.webp;version 由「原文件大小 + 修改时间 + 内容哈希」决定,
 *    原文件被替换/修改后 version 变化,旧缓存自然失效;删除/重处理时主动 invalidateHd(id)。
 *  - 游客水印成品(variant):<id>.<version>.<width>.<wmFp>.webp。游客水印不含用户标识,结果由
 *    「图片 + 版本 + 宽度 + 水印指纹(文字/透明度/字号/角度/密度/字体,见 watermark.ts#wmFingerprint)」唯一确定,
 *    可直接复用。缓存的是「处理结果」不是「访问权限」:调用方必须在读取前完成令牌/限流/可见性校验。
 *    同一 (id,version,width) 只保留 1 个成品(水印配置变化后旧指纹立刻被替换),全局条目数有上限。
 *  - 淘汰: LRU(按最近访问时间)直到总量 ≤ HD_CACHE_MAX_MB;并按 HD_CACHE_TTL_DAYS 过期。
 *  - 该目录不属于任何静态资源路径,只能经 /api/v1/media/:id/hd(带权限校验)读取。
 */

interface Entry {
  key: string;
  id: string;
  ver: string;
  w: number;
  /** 水印指纹;空串 = 未加水印的基图 */
  fp: string;
  file: string;
  size: number;
  createdAt: number;
  lastAccess: number;
}

interface State {
  index: Map<string, Entry>;
  total: number;
  loaded: Promise<void> | null;
  /** id → 失效代数。转换期间 id 被失效,则丢弃该次转换结果,避免写入过期缓存 */
  gen: Map<string, number>;
  stats: { hits: number; misses: number; evicted: number; expired: number; invalidated: number; conversions: number; coalesced: number; wmHits: number; wmStores: number };
}

const g = globalThis as typeof globalThis & { __pgsHd?: State };
const st: State = (g.__pgsHd ??= {
  index: new Map(),
  total: 0,
  loaded: null,
  gen: new Map(),
  stats: { hits: 0, misses: 0, evicted: 0, expired: 0, invalidated: 0, conversions: 0, coalesced: 0, wmHits: 0, wmStores: 0 },
});

export const hdStats = st.stats;
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 水印成品条目数上限(防止被大量图片 × 宽度撑出海量小文件;容量仍受 HD_CACHE_MAX_MB 约束) */
export const WM_CACHE_MAX_ENTRIES = 5000;
const FP_RE = /^[0-9a-f]{8}$/;

const keyOf = (id: string, ver: string, w: number, fp = "") => (fp ? `${id}.${ver}.${w}.${fp}` : `${id}.${ver}.${w}`);
const fileOf = (id: string, ver: string, w: number, fp = "") => path.join(dirs.hdCache, id.slice(0, 2), `${keyOf(id, ver, w, fp)}.webp`);

async function unlinkQuiet(file: string) {
  await fs.unlink(file).catch(() => undefined);
}

function drop(e: Entry) {
  if (st.index.delete(e.key)) st.total -= e.size;
}

/** 启动后首次使用时扫描缓存目录,重建内存索引(同时清理遗留的 .tmp) */
function ensureIndex(): Promise<void> {
  if (!st.loaded) {
    st.loaded = (async () => {
      await fs.mkdir(dirs.hdCache, { recursive: true });
      for (const shard of await fs.readdir(dirs.hdCache).catch(() => [] as string[])) {
        const dir = path.join(dirs.hdCache, shard);
        for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
          const file = path.join(dir, f);
          if (f.endsWith(".tmp")) {
            await unlinkQuiet(file);
            continue;
          }
          const m = /^([A-Za-z0-9_-]+)\.([0-9a-f]{12})\.(\d+)(?:\.([0-9a-f]{8}))?\.webp$/.exec(f);
          const s = await fs.stat(file).catch(() => null);
          if (!m || !s) continue;
          const fp = m[4] ?? "";
          const e: Entry = { key: keyOf(m[1], m[2], Number(m[3]), fp), id: m[1], ver: m[2], w: Number(m[3]), fp, file, size: s.size, createdAt: s.mtimeMs, lastAccess: s.atimeMs };
          st.index.set(e.key, e);
          st.total += e.size;
        }
      }
    })().catch((err) => {
      st.loaded = null;
      throw err;
    });
  }
  return st.loaded;
}

export function genOf(id: string): number {
  return st.gen.get(id) ?? 0;
}

export async function getCached(id: string, ver: string, w: number, fp = ""): Promise<Buffer | null> {
  await ensureIndex();
  const e = st.index.get(keyOf(id, ver, w, fp));
  if (!e) return null;
  if (Date.now() - e.createdAt > config.hd.cacheTtlMs) {
    drop(e);
    st.stats.expired++;
    await unlinkQuiet(e.file);
    return null;
  }
  try {
    // 读成 Buffer 是必要的:水印合成需要完整图像。这里只读一次,响应时不再复制
    // (旧实现响应阶段又 new Uint8Array(out) 复制一份,并发下内存翻倍,见 issue §6.7)
    const buf = await fs.readFile(e.file);
    e.lastAccess = Date.now();
    void fs.utimes(e.file, new Date(e.lastAccess), new Date(e.createdAt)).catch(() => undefined);
    return buf;
  } catch {
    drop(e);
    return null;
  }
}

export async function putCached(id: string, ver: string, w: number, buf: Buffer, gen: number, fp = ""): Promise<void> {
  if (fp && !FP_RE.test(fp)) return;
  await ensureIndex();
  if (genOf(id) !== gen) return; // 转换期间原文件已变化/被删除
  // 同一图片的旧版本缓存立刻清掉;同一 (版本,宽度) 的水印成品只保留当前指纹(配置变更后的旧成品不可能再命中)
  for (const e of [...st.index.values()]) {
    if (e.id !== id) continue;
    if (e.ver !== ver || (fp && e.fp && e.w === w && e.fp !== fp)) {
      drop(e);
      await unlinkQuiet(e.file);
    }
  }
  const file = fileOf(id, ver, w, fp);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, buf);
  if (genOf(id) !== gen) {
    await unlinkQuiet(tmp);
    return;
  }
  await fs.rename(tmp, file);
  const old = st.index.get(keyOf(id, ver, w, fp));
  if (old) drop(old);
  const now = Date.now();
  const e: Entry = { key: keyOf(id, ver, w, fp), id, ver, w, fp, file, size: buf.length, createdAt: now, lastAccess: now };
  st.index.set(e.key, e);
  st.total += e.size;
  if (fp) st.stats.wmStores++;
  await evict();
}

/** 游客水印成品:读取。调用方须已完成令牌 / 限流 / 可见性校验 */
export async function getCachedWm(id: string, ver: string, w: number, fp: string): Promise<Buffer | null> {
  if (!FP_RE.test(fp)) return null;
  const buf = await getCached(id, ver, w, fp);
  if (buf) st.stats.wmHits++;
  return buf;
}

/** 游客水印成品:写入(失败/超限都不影响主流程) */
export async function putCachedWm(id: string, ver: string, w: number, fp: string, buf: Buffer, gen: number): Promise<void> {
  await putCached(id, ver, w, buf, gen, fp);
}

async function evict() {
  // 水印成品条目数上限:超出时淘汰最久未访问的成品(不动基图)
  let wmCount = 0;
  for (const e of st.index.values()) if (e.fp) wmCount++;
  if (wmCount > WM_CACHE_MAX_ENTRIES) {
    const wms = [...st.index.values()].filter((e) => e.fp).sort((a, b) => a.lastAccess - b.lastAccess);
    for (const e of wms) {
      if (wmCount <= WM_CACHE_MAX_ENTRIES) break;
      drop(e);
      wmCount--;
      st.stats.evicted++;
      await unlinkQuiet(e.file);
    }
  }
  if (st.total <= config.hd.cacheMaxBytes) return;
  const list = [...st.index.values()].sort((a, b) => a.lastAccess - b.lastAccess); // LRU:最久未访问优先
  for (const e of list) {
    if (st.total <= config.hd.cacheMaxBytes) break;
    drop(e);
    st.stats.evicted++;
    await unlinkQuiet(e.file);
  }
}

/** 原文件替换 / 修改 / 删除 / 重处理时调用:清除该图片所有高清缓存,并使在途转换结果作废 */
export async function invalidateHd(id: string): Promise<void> {
  if (!ID_RE.test(id)) return;
  st.gen.set(id, genOf(id) + 1);
  if (st.gen.size > 5000) st.gen.clear(); // 防止无限增长
  try {
    await ensureIndex();
    for (const e of [...st.index.values()]) {
      if (e.id === id) {
        drop(e);
        st.stats.invalidated++;
        await unlinkQuiet(e.file);
      }
    }
    const dir = path.join(dirs.hdCache, id.slice(0, 2));
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (f.startsWith(`${id}.`)) await unlinkQuiet(path.join(dir, f));
    }
  } catch {
    /* 缓存清理失败不应影响主流程 */
  }
}

/** 定时清理:过期、超量、遗留临时文件。不触碰原图/缩略图/普通预览图 */
export async function sweepHdCache(): Promise<void> {
  await ensureIndex();
  const now = Date.now();
  for (const e of [...st.index.values()]) {
    if (now - e.createdAt > config.hd.cacheTtlMs) {
      drop(e);
      st.stats.expired++;
      await unlinkQuiet(e.file);
    }
  }
  await evict();
  for (const shard of await fs.readdir(dirs.hdCache).catch(() => [] as string[])) {
    const dir = path.join(dirs.hdCache, shard);
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith(".tmp")) continue;
      const s = await fs.stat(path.join(dir, f)).catch(() => null);
      if (s && now - s.mtimeMs > 3600_000) await unlinkQuiet(path.join(dir, f));
    }
  }
}

export async function hdCacheInfo() {
  await ensureIndex();
  let wmFiles = 0;
  for (const e of st.index.values()) if (e.fp) wmFiles++;
  return { files: st.index.size, wmFiles, bytes: st.total, maxBytes: config.hd.cacheMaxBytes, ttlDays: config.hd.cacheTtlMs / 86_400_000, ...st.stats };
}
