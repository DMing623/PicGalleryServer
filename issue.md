# PicGalleryServer 代码审查与问题清单 (issue.md)

> 对照 `README.md` 与 `project.md`（v1.5.0）对全仓源码（`src/`、`cli/`、`public/`、`scripts/`）进行静态审查与逻辑走查。
> 每条问题均标明：**代码定位**、**问题描述与复现路径**、**与文档/预期功能的差异**，以及**性质判定（确实是缺陷 vs 项目特意如此的设计取舍）**。
> 按要求仅创建并追加本文件，不改动任何业务源码。

---

## Issue #1：CLI 在本地已有凭据文件时执行 `pgs login` 恒报“缺少密码”而无法重新登录或切换账号

- **性质判定**：✅ **确实是缺陷（Actual Bug）**
- **代码定位**：`cli/pgs.mjs` 第 114–115 行、第 350–353 行
- **预期功能（`README.md` / `cli/pgs.mjs` 帮助文档）**：
  支持随时执行 `node cli/pgs.mjs login --user <用户名> --password-stdin`（或配合 `PGS_PASSWORD` / `--password`）重新登录、刷新过期令牌、切换账户或切换目标服务器并将新令牌写入 `~/.config/pgs/credentials.json`。
- **实际代码实现与问题分析**：
  在 `cli/pgs.mjs` 顶层初始化阶段（第 114–115 行）：
  ```js
  const TOKEN = flags.token ?? process.env.PGS_TOKEN ?? readCredFile()?.token ?? "";
  const PASS = TOKEN ? "" : readPassword();
  ```
  当用户曾经登录过一次后，`~/.config/pgs/credentials.json` 中已存在 `token`，导致 `readCredFile()?.token` 返回非空字符串，进而 `TOKEN` 非空。此时第 115 行三元表达式 `TOKEN ? "" : readPassword()` 直接将 `PASS` 赋值为空字符串 `""`，跳过了 `readPassword()`。
  随后进入 `main()` 的 `case "login":` 分支（第 350–353 行）：
  ```js
  case "login": {
    const body = { username: flags.user ?? process.env.PGS_USER ?? "admin", password: PASS };
    if (!body.password) throw new Error("请用 --password-stdin 或 PGS_PASSWORD 提供密码");
  ```
  即便用户已经传入了 `--password-stdin`、`--password` 或 `PGS_PASSWORD` 环境变量，只要本地已有 `credentials.json`，`PASS` 就恒为 `""`，导致 `pgs login` 100% 抛出 `错误: 请用 --password-stdin 或 PGS_PASSWORD 提供密码`，除非用户先手动执行 `pgs logout` 删除凭据文件。
- **是否特意如此**：否。顶层 `TOKEN ? "" : readPassword()` 的本意是在日常业务子命令（如 `album list`、`upload`）中优先使用 Bearer Token 而免去读取密码，但遗漏了 `pos[0] === "login"` 时必须读取密码的分支。

---

## Issue #2：SQLite 模式下搜索含下划线 `_` 或百分号 `%` 的关键词（如 `IMG_001`）始终返回 0 条结果

- **性质判定**：✅ **确实是缺陷（Actual Bug / 双数据库驱动兼容性缺陷）**
- **代码定位**：`src/server/media/service.ts` 第 86–95 行
- **预期功能（`README.md` / `project.md` §2 & §4.4）**：
  PostgreSQL 与 SQLite 两种数据库驱动对外搜索行为一致；搜索文件名、相机型号、AI 提示词或备注时，输入包含 `_`、`%`、`\` 的关键词（例如常见相机与截图文件名 `IMG_1234`、`DSC_0001`、`Screenshot_2026`）应按字面量匹配对应文件。
- **实际代码实现与问题分析**：
  在 `listMedia()` 构建 `LIKE` 模糊查询条件时：
  ```ts
  const terms = (o.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  for (const term of terms) {
    const pat = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    conds.push(
      o.user
        ? sql`(${media.searchText} LIKE ${pat} OR lower(${media.note}) LIKE ${pat})`
        : like(media.searchText, pat),
    );
  }
  ```
  代码将搜索词中的 `\`、`%`、`_` 转义为 `\\`、`\%`、`\_`（例如 `IMG_001` 变为 `%img\_001%`）。
  - 在 **PostgreSQL** 中，`LIKE` 默认将反斜杠 `\` 视为转义字符，因此 `LIKE '%img\_001%'` 能正常匹配 `img_001.jpg`。
  - 但在 **SQLite**（`DB_DRIVER=sqlite`）中，`LIKE` **默认没有转义字符**，必须显式声明 `ESCAPE '\'`（即 `LIKE ? ESCAPE '\'`）才会将 `\` 解析为转义符。未写 `ESCAPE '\'` 时，SQLite 会把 `\_` 当作「字面量反斜杠 `\` + 单字符通配符 `_`」去匹配。由于实际文件名 `img_001.jpg` 中并没有反斜杠 `\`，导致在 SQLite 模式下搜索任何带下划线 `_` 或 `%` 的文件名/提示词均返回 0 条结果。
- **是否特意如此**：否。作者加 `term.replace(/[\\%_]/g, "\\$&")` 的本意是防止用户输入的 `_` 和 `%` 被当成 SQL 通配符，但在适配双数据库驱动时忽略了 SQLite 的 `LIKE` 必须显式指定 `ESCAPE '\'`。

---

## Issue #3：服务器本地路径导入 `collectFiles(paths, recursive)` 完全忽略了 `recursive` 参数

- **性质判定**：✅ **确实是缺陷（Actual Bug / 代码实现与接口契约不符）**
- **代码定位**：`src/server/media/ingest.ts` 第 242–261 行（调用处：`src/server/api/media.ts` 第 183 行、`cli/pgs.mjs` 第 378 行）
- **预期功能（`project.md` §6.8 & §8.4、`cli/pgs.mjs`）**：
  `POST /api/v1/media/import` 支持参数 `recursive?=true`（命令行支持 `pgs import <路径> --no-recursive`），当 `recursive=false` 时应只导入指定目录本层的文件而不递归下探子目录。
- **实际代码实现与问题分析**：
  查看 `src/server/media/ingest.ts` 第 242–261 行：
  ```ts
  export async function collectFiles(paths: string[], recursive: boolean): Promise<string[]> {
    const out: string[] = [];
    const walk = async (p: string, depth: number) => {
      const st = await fs.lstat(p).catch(() => null);
      if (!st || st.isSymbolicLink()) return;
      if (st.isFile()) {
        if (detectKind(p)) out.push(p);
      } else if (st.isDirectory() && depth < 12) {
        for (const e of await fs.readdir(p)) {
          if (e.startsWith(".")) continue;
          await walk(path.join(p, e), depth + 1);
        }
      }
    };
    for (const p of paths) {
      const abs = await assertMountAllowed(path.resolve(p));
      await walk(abs, 0);
    }
    return out;
  }
  ```
  函数签名接收了 `recursive: boolean`，但函数体内**从未读取 `recursive` 参数**（对比 `cli/pgs.mjs` 第 202 行本地 `upload` 的 `collect` 函数写了 `else if (st.isDirectory() && depth < 12 && (depth === 0 || recursive))`）。因此在服务端 `import` 接口中，无论传 `recursive: false` 还是 `pgs import --no-recursive`，都会强制递归遍历最多 12 层子目录。
- **是否特意如此**：否。API 路由层（`b.recursive !== false`）与 CLI 层（`recursive: !flags["no-recursive"]`）都完整透传了该参数，仅 `collectFiles` 内部遗漏了 `depth === 0 || recursive` 判断。

---

## Issue #4：Markdown 渲染器未对已生成的链接/图片标签做占位保护，导致含下划线 `_` 的 URL 被错误替换为 `<em>` / `<strong>`

- **性质判定**：✅ **确实是缺陷（Actual Bug）**
- **代码定位**：`src/lib/markdown.ts` 第 28–53 行
- **预期功能（`README.md` / `project.md` §3）**：
  站点通知支持 Markdown 语法（含链接 `[文本](https://...)` 与图片 `![alt](https://...)`），合法的 `http/https` 链接应当原样渲染进 `href` / `src` 属性。
- **实际代码实现与问题分析**：
  在 `src/lib/markdown.ts` 的 `inline(text)` 函数中：
  ```ts
  // 图片 ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) => {
    const u = safeUrl(url);
    return u ? `<img src="${u}" alt="${alt}" class="md-img" loading="lazy" />` : m;
  });
  // 链接 [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt: string, url: string) => {
    const u = safeUrl(url);
    return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${txt}</a>` : m;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  ```
  1. 代码虽然对行内代码 `` `code` `` 使用了 `\u0000CODE...\u0000` 占位符防止其内部的 `*` 和 `_` 被当作斜体/粗体，但**没有对生成的 `<img>` 和 `<a>` 标签做占位保护**。
  2. 当 URL（或图片的 `alt` 属性）中含有两个及以上下划线 `_`（例如 `[项目地址](https://example.com/pic_gallery_server/doc)` 或带 `utm_source=a&utm_medium=b` 的链接）时，后续执行的 `s.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>")` 会在已生成的 HTML 字符串上直接把 `href` 属性里的 `_gallery_` 替换成 `<em>gallery</em>`，产出 `<a href="https://example.com/pic<em>gallery</em>server/doc">` 的损坏链接。
  3. 此外第 23 行 `safeUrl` 的正则 `/^(https?:\/\/|mailto:|\/)/i` 会放行以 `//` 开头的协议相对外部链接（如 `//evil.com`）。
- **是否特意如此**：否。注释虽说明“表格等复杂语法不处理”是设计取舍，但链接/图片是明确声明支持的核心语法，URL 中的 `_` 被斜体正则破坏属于典型的替换顺序缺陷。

---

## Issue #5：站点通知的「置顶 (`pinned`)」功能在发布页可勾选保存，但在通知面板与服务端查询中完全未生效

- **性质判定**：✅ **确实是缺陷（功能未闭环 / 与代码注释及 UI 设计不一致）**
- **代码定位**：
  - `src/db/schema.ts` 第 167–168 行
  - `src/server/notices.ts` 第 32–36 行
  - `src/components/NoticeBell.tsx` 第 161–172 行、第 368–388 行
  - `src/components/settings/NoticeTab.tsx` 第 59 行、第 141 行、第 164 行
  - `src/db/index.ts` 第 82 行
- **预期功能**：
  `src/db/schema.ts` 第 167 行明确注释：`/** 置顶(在通知面板里优先展示) */ pinned: boolean("pinned").notNull().default(false)`；且「设置 → 通知发布」（`NoticeTab.tsx` 第 141 行）提供了「置顶」复选框并在已发布列表显示 `<span className="chip">置顶</span>`。
- **实际代码实现与问题分析**：
  1. **服务端查询未按 `pinned` 排序**：`src/server/notices.ts` 第 32–36 行 `listNotices()` 仅执行 `.orderBy(desc(notices.createdAt)).limit(MAX_NOTICES)`，未将 `desc(notices.pinned)` 放在排序首位（若置顶通知是较早发布的且总通知数超过 300 条，甚至会被 `.limit(300)` 截断丢弃）。
  2. **前端通知面板 (`NoticeBell.tsx`) 完全忽略了 `pinned` 字段**：`NoticeBell.tsx` 在第 161–172 行按日期分组并在组内仅按 `b.createdAt.localeCompare(a.createdAt)` 排序；在渲染面板顶部概况栏（第 180 行 `const latest = items[0]`）和展开通知列表（第 368–388 行）时，既没有优先展示置顶通知，也没有渲染任何「置顶」标记。
  3. **SQLite 布尔列白名单遗漏 `pinned`**：`src/db/index.ts` 第 82 行 `const BOOL_COLUMNS = new Set(["disabled", "readonly"])` 未加入后来新增的 `"pinned"` 列（虽然 `notices.ts` 通过 `pinned: !!r.pinned` 手动强转规避了 API 返回 `0/1`，但 Drizzle 查询出的原始行对象在 SQLite 下 `r.pinned` 为数字 `0/1` 而非布尔值）。
- **是否特意如此**：否。数据库字段、API 读写、管理端「置顶」复选框均已实现，仅展示端与排序逻辑漏掉了对 `pinned` 的处理。
