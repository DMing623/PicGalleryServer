// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../../src/lib/markdown.ts";

test("链接 URL 中的下划线不被改写成 <em>(issue #4)", () => {
  const h = renderMarkdown("[项目](https://example.com/pic_gallery_server/doc)");
  assert.match(h, /href="https:\/\/example\.com\/pic_gallery_server\/doc"/);
  assert.ok(!h.includes("<em>"));
});

test("带 utm_ 参数的链接保持完整", () => {
  const h = renderMarkdown("[a](https://x.com/?utm_source=a&utm_medium=b)");
  assert.match(h, /href="https:\/\/x\.com\/\?utm_source=a&amp;utm_medium=b"/);
  assert.ok(!h.includes("<em>"));
});

test("图片 src / alt 中的下划线与星号不被改写", () => {
  const h = renderMarkdown("![my_cool_pic](https://x.com/a_b_c.png)");
  assert.match(h, /src="https:\/\/x\.com\/a_b_c\.png" alt="my_cool_pic"/);
  assert.ok(!h.includes("<em>"));
});

test("链接文字里的粗体 / 斜体仍然生效", () => {
  const h = renderMarkdown("[**粗** 与 *斜*](https://x.com/a_b_c)");
  assert.match(h, /<a href="https:\/\/x\.com\/a_b_c"[^>]*><strong>粗<\/strong> 与 <em>斜<\/em><\/a>/);
});

test("链接外的强调与行内代码照常渲染", () => {
  const h = renderMarkdown("_斜_ 与 **粗** 与 `a_b_c`");
  assert.match(h, /<em>斜<\/em>/);
  assert.match(h, /<strong>粗<\/strong>/);
  assert.match(h, /<code>a_b_c<\/code>/);
});

test("协议相对 / 伪协议链接不会生成 <a>", () => {
  for (const u of ["//evil.com", "/\\evil.com", "javascript:alert(1)"]) {
    const h = renderMarkdown(`[x](${u})`);
    assert.ok(!h.includes("<a "), u);
  }
  assert.match(renderMarkdown("[x](/albums/abc)"), /<a href="\/albums\/abc"/);
  assert.match(renderMarkdown("[x](mailto:a@b.com)"), /<a href="mailto:a@b\.com"/);
});

test("原始 HTML 被转义", () => {
  const h = renderMarkdown('<script>alert(1)</script> [x](https://a.com/"onmouseover="y)');
  assert.ok(!h.includes("<script>"));
  assert.ok(!/ onmouseover=/.test(h.replace(/&quot;/g, "")) || !h.includes('"onmouseover="'));
});
