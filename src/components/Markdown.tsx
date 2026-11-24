"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { renderMarkdown } from "@/lib/markdown";

/** 渲染 Markdown(已在 lib/markdown.ts 里做 HTML 转义与链接白名单) */
export default function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return <div className={`md-body ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
