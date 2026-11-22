"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useEffect } from "react";

/**
 * Next.js 开发模式悬浮球(DevTools)汉化。仅在 `next dev` 下生效,生产构建不渲染任何悬浮球。
 * 悬浮球的 UI 位于 <nextjs-portal> 的 Shadow DOM 内,Next 官方不提供多语言,
 * 这里用 MutationObserver 把已知英文文案替换为中文(未收录的文案保持原样)。
 */
const DICT: Record<string, string> = {
  "Route": "路由", "Static": "静态", "Dynamic": "动态", "Route Info": "路由信息", "Bundler": "打包器", "Turbopack": "Turbopack 打包器",
  "Preferences": "偏好设置", "Issues": "问题", "Issue": "问题", "Theme": "主题", "System": "跟随系统", "Light": "浅色", "Dark": "深色",
  "Position": "位置", "Bottom Left": "左下角", "Bottom Right": "右下角", "Top Left": "左上角", "Top Right": "右上角", "Size": "尺寸",
  "Hide": "隐藏", "Hide Dev Tools for this session": "本次会话隐藏开发工具", "Hide Dev Tools shortcut": "隐藏开发工具快捷键",
  "Disable Dev Tools for this project": "为本项目禁用开发工具", "Restart Dev Server": "重启开发服务器", "Restart": "重启",
  "Reset Bundler Cache": "重置打包缓存", "Reset Cache": "重置缓存", "Learn more": "了解更多", "Learn More": "了解更多", "Show More": "显示更多",
  "Rendering": "渲染", "Cache": "缓存", "Fetches": "数据请求", "Requests": "请求", "Method": "方法", "Status": "状态", "Duration": "耗时",
  "Reason": "原因", "Span": "跨度", "Trace": "追踪", "Internal": "内部", "Page load": "页面加载", "Client nav": "客户端导航",
  "Dynamic API": "动态 API", "Agent prompt": "智能体提示词", "Security Insight": "安全提示", "Debugger paused": "调试器已暂停",
  "Pause on navigations": "导航时暂停", "Toggle Overrides": "切换覆盖项", "Clear Segment Overrides": "清除分段覆盖项", "Close": "关闭",
  "Disable": "禁用", "Copy": "复制", "Copied": "已复制", "Next.js": "Next.js",
};

function translate(root: ParentNode) {
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const raw = n.nodeValue ?? "";
    const t = raw.trim();
    if (!t) continue;
    const hit = DICT[t];
    if (hit) n.nodeValue = raw.replace(t, hit);
  }
  (root as Element).querySelectorAll?.("[aria-label],[title]").forEach((el) => {
    for (const a of ["aria-label", "title"]) {
      const v = el.getAttribute(a);
      if (v && DICT[v]) el.setAttribute(a, DICT[v]);
    }
  });
}

export default function DevI18n() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const seen = new WeakSet<ShadowRoot>();
    const observe = (root: ShadowRoot) => {
      if (seen.has(root)) return;
      seen.add(root);
      translate(root);
      new MutationObserver(() => translate(root)).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "title"] });
    };
    const scan = () => {
      document.querySelectorAll("nextjs-portal").forEach((p) => p.shadowRoot && observe(p.shadowRoot));
    };
    scan();
    const t = setInterval(scan, 800);
    return () => clearInterval(t);
  }, []);
  return null;
}
