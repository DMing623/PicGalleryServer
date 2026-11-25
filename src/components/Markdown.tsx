"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { memo, useMemo } from "react";
import { renderMarkdown } from "@/lib/markdown";

/** 渲染 Markdown(已在 lib/markdown.ts 里做 HTML 转义与链接白名单,缓存解析结果避免无关重渲染) */
export default memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const html = useMemo(() => ({ __html: renderMarkdown(text) }), [text]);
  return <div className={`md-body ${className}`} dangerouslySetInnerHTML={html} />;
});
