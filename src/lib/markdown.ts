// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 极简 Markdown → HTML(零依赖,前后端共用)。
 *
 * 设计取舍:
 *  - 先整体 HTML 转义,再做 Markdown 替换,因此原文里的 <script> 等标签不可能生效;
 *  - 只放行 http/https/mailto 链接与相对路径,拒绝 javascript: 等伪协议;
 *  - 支持:标题、粗体、斜体、删除线、行内代码、代码块、引用、无序/有序列表、分割线、链接、图片。
 *    表格等复杂语法不处理(原样输出文本)。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(raw: string): string | null {
  const u = raw.trim();
  // 站内相对路径只放行单个 `/` 开头:`//host`、`/\host` 会被浏览器当作协议相对的外部链接
  if (/^(https?:\/\/|mailto:|\/(?![\/\\]))/i.test(u)) return u;
  return null;
}

/** 行内元素 */
function inline(text: string): string {
  let s = escapeHtml(text);
  // 行内代码优先,避免其中的 * _ 被当作强调
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });
  // 已生成的 <img> / <a> 标签用占位符保护起来:否则 URL 或 alt 里的 `_` `*`
  // (如 https://x.com/pic_gallery_server、utm_source=a&utm_medium=b)会被后面的强调规则改写成 <em> 而损坏链接
  const raws: string[] = [];
  const hold = (html: string) => {
    raws.push(html);
    return `\u0000RAW${raws.length - 1}\u0000`;
  };
  // 图片 ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) => {
    const u = safeUrl(url);
    return u ? hold(`<img src="${u}" alt="${alt}" class="md-img" loading="lazy" />`) : m;
  });
  // 链接 [text](url):只保护开/闭标签,链接文字里仍可使用粗体/斜体
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt: string, url: string) => {
    const u = safeUrl(url);
    return u ? `${hold(`<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">`)}${txt}${hold("</a>")}` : m;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\u0000RAW(\d+)\u0000/g, (_m, i: string) => raws[Number(i)]);
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

/** 把 Markdown 文本渲染为 HTML 字符串(已做转义与链接白名单) */
export function renderMarkdown(src: string): string {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块 ```lang
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // 跳过结束围栏
      out.push(`<pre class="md-pre"><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      i++;
      continue;
    }

    // 标题
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const lv = h[1].length;
      out.push(`<h${lv} class="md-h md-h${lv}">${inline(h[2].trim())}</h${lv}>`);
      i++;
      continue;
    }

    // 引用(连续多行合并)
    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote class="md-quote">${buf.map((b) => inline(b)).join("<br />")}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      if (listType !== "ul") {
        closeList();
        out.push('<ul class="md-ul">');
        listType = "ul";
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ""))}</li>`);
      i++;
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (listType !== "ol") {
        closeList();
        out.push('<ol class="md-ol">');
        listType = "ol";
      }
      out.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
      i++;
      continue;
    }

    // 段落(连续非空行合并)
    closeList();
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(#{1,6}\s|```|>\s?|[-*+]\s+|\d+[.)]\s+|([-*_])\2{2,}\s*$)/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    out.push(`<p class="md-p">${buf.map((b) => inline(b)).join("<br />")}</p>`);
  }
  closeList();
  return out.join("\n");
}

/** 提取纯文本摘要(用于列表预览) */
export function markdownSummary(src: string, max = 90): string {
  const text = String(src ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
