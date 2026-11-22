// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaItem } from "./Gallery";

/**
 * 高清预览加载:
 *  1) GET /media/:id/hd-token  申请 90 秒短期令牌(只对该图片有效)
 *  2) GET /media/:id/hd?t=…    取得带水印的高清 WebP → Blob URL
 *  - 仅使用已加载的高清预览图进行缩放,绝不请求原始文件
 *  - 只保留「当前 + 前一张 + 后一张」的 Blob URL,切换时立即 revoke,避免内存持续增长
 *  - 预加载最多 2 张(相邻图片),且在当前图加载完成后才开始
 */

export interface HdState {
  status: "loading" | "ready" | "error";
  url?: string;
  error?: string;
}

/** 按屏幕分辨率选择请求宽度(服务端会吸附到 1280/1600/1920/2560 档位,并受 HD_WIDTH 上限约束) */
function wantWidth(): number {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  return Math.round(Math.max(window.innerWidth * dpr, window.innerHeight * dpr * 0.75));
}

async function errorOf(res: Response): Promise<string> {
  let msg = `加载失败 (${res.status})`;
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    if (j.error?.message) msg = j.error.message;
  } catch {
    /* 非 JSON */
  }
  if (res.status === 429) {
    const ra = res.headers.get("retry-after");
    msg = `${msg}${ra ? `(约 ${ra} 秒后可重试)` : ""}`;
  }
  return msg;
}

async function fetchHd(id: string, signal: AbortSignal): Promise<string> {
  const w = wantWidth();
  const tRes = await fetch(`/api/v1/media/${id}/hd-token?w=${w}`, { credentials: "same-origin", cache: "no-store", signal });
  if (!tRes.ok) throw new Error(await errorOf(tRes));
  const tj = (await tRes.json()) as { data?: { token: string; width: number } };
  const token = tj.data?.token;
  if (!token) throw new Error("获取高清访问令牌失败");
  const res = await fetch(`/api/v1/media/${id}/hd?t=${encodeURIComponent(token)}&w=${tj.data?.width ?? w}`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(await errorOf(res));
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function useHd(items: MediaItem[], index: number) {
  const [states, setStates] = useState<Record<string, HdState>>({});
  const ctrls = useRef(new Map<string, AbortController>());
  const urls = useRef(new Map<string, string>());

  const release = useCallback((id: string) => {
    ctrls.current.get(id)?.abort();
    ctrls.current.delete(id);
    const u = urls.current.get(id);
    if (u) URL.revokeObjectURL(u);
    urls.current.delete(id);
    setStates((s) => {
      if (!(id in s)) return s;
      const n = { ...s };
      delete n[id];
      return n;
    });
  }, []);

  const start = useCallback((id: string) => {
    if (ctrls.current.has(id)) return;
    const ctrl = new AbortController();
    ctrls.current.set(id, ctrl);
    setStates((s) => ({ ...s, [id]: { status: "loading" } }));
    fetchHd(id, ctrl.signal)
      .then((url) => {
        if (ctrls.current.get(id) !== ctrl) {
          URL.revokeObjectURL(url); // 已被移出窗口
          return;
        }
        urls.current.set(id, url);
        setStates((s) => ({ ...s, [id]: { status: "ready", url } }));
      })
      .catch((e: Error) => {
        if (ctrl.signal.aborted || ctrls.current.get(id) !== ctrl) return;
        setStates((s) => ({ ...s, [id]: { status: "error", error: e.message || "加载失败" } }));
      });
  }, []);

  const cur = items[index];
  const curId = cur && cur.kind === "image" ? cur.id : null;
  const state: HdState | null = curId ? states[curId] ?? { status: "loading" } : null;
  const curStatus = state?.status;

  // 只保留 当前 + 前一张 + 后一张:释放窗口外的 Blob URL
  useEffect(() => {
    const keep = new Set<string>();
    for (const i of [index - 1, index, index + 1]) {
      const it = items[i];
      if (it && it.kind === "image") keep.add(it.id);
    }
    for (const id of [...ctrls.current.keys()]) if (!keep.has(id)) release(id);
  }, [index, items, release]);

  // 加载当前图
  useEffect(() => {
    if (curId) start(curId);
  }, [curId, start]);

  // 当前图就绪后,预加载相邻 2 张
  useEffect(() => {
    if (curStatus !== "ready") return;
    const t = setTimeout(() => {
      for (const i of [index + 1, index - 1]) {
        const it = items[i];
        if (it && it.kind === "image") start(it.id);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [curStatus, index, items, start]);

  // 卸载:全部释放
  useEffect(() => {
    const c = ctrls.current;
    const u = urls.current;
    return () => {
      for (const ctrl of c.values()) ctrl.abort();
      for (const url of u.values()) URL.revokeObjectURL(url);
      c.clear();
      u.clear();
    };
  }, []);

  const retry = useCallback(() => {
    if (!curId) return;
    release(curId);
    start(curId);
  }, [curId, release, start]);

  return { state, retry };
}
