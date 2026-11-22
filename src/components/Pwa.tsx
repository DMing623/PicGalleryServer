"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useEffect, useState } from "react";

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();

/** 注册 Service Worker 并捕获「安装到主屏幕」事件(仅生产环境注册,避免干扰开发热更新) */
export function PwaRegister() {
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      deferred = e as InstallEvent;
      listeners.forEach((f) => f());
    };
    const onInstalled = () => {
      deferred = null;
      listeners.forEach((f) => f());
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return null;
}

/** 是否可以弹出安装提示,以及触发安装 */
export function useInstall() {
  const [can, setCan] = useState(false);
  useEffect(() => {
    const f = () => setCan(!!deferred);
    listeners.add(f);
    f();
    return () => void listeners.delete(f);
  }, []);
  return {
    can,
    install: async () => {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice.catch(() => undefined);
      deferred = null;
      listeners.forEach((f) => f());
    },
  };
}
