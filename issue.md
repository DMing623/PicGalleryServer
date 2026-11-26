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

---

## Issue #6：站点通知未读数计算 (`unreadCount`) 与已读接口 (`markRead` / `markAllRead`) 的一致性缺陷，及游客通知与 `project.md` 描述差异

- **性质判定**：✅ **(1)(2) 确实是缺陷（Actual Bug）；⚠️ (3) 属于刻意实现取舍但与 `project.md` 描述不一致**
- **代码定位**：`src/server/notices.ts` 第 30–67 行、第 141–162 行；对照 `project.md` §5（`pgs_notice_reads`）
- **实际代码实现与问题分析**：
  1. **`POST /notices/:id/read` 未校验通知是否存在，可污染未读数统计（确实是缺陷）**：
     `markRead(user, id)`（第 160–162 行）直接向 `pgs_notice_reads` 插入 `{ userId: user.id, noticeId: id }`，既无数据库外键约束，也未先查询 `id` 是否存在于 `pgs_notices`。
     而 `unreadCount()`（第 59–67 行）采用全表计数相减：
     ```ts
     const [total] = await db.select({ n: sql<number>`CAST(count(*) AS INTEGER)` }).from(notices);
     const [read] = await db.select({ n: sql<number>`CAST(count(*) AS INTEGER)` }).from(noticeReads).where(eq(noticeReads.userId, user.id));
     return Math.max(0, Number(total?.n ?? 0) - Number(read?.n ?? 0));
     ```
     一旦调用 `POST /api/v1/notices/<不存在的id>/read`，`pgs_notice_reads` 中便会多出孤儿行，导致该用户的 `read` 计数虚高，后续新发布的通知会被抵消而不再亮起铃铛未读红点。
  2. **`markAllRead` 缺少 `.orderBy(desc(notices.createdAt))` 且与 `unreadCount` 口径不一致（确实是缺陷）**：
     `markAllRead()` 第 142 行执行 `db.select({ id: notices.id }).from(notices).limit(MAX_NOTICES)` 时没有指定排序（`listNotices` 有 `orderBy(desc(notices.createdAt))`）。当通知总数超过 `MAX_NOTICES`（300）时，`markAllRead` 标记的是任意 300 条而非最新 300 条，且 `unreadCount()` 统计全表通知数，导致点击「一键已读」后顶栏铃铛红点仍无法清零。
  3. **游客通知行为与 `project.md` §5 描述不一致（服务端刻意设计 vs 文档/注释滞后）**：
     `project.md` §5 写明：“游客没有账户，其已读状态保存在浏览器 localStorage”；但 `src/server/notices.ts` 第 31 行 `if (!user) return { items: [], unread: 0, total: 0 };` 对未登录游客直接返回空列表，且 `NoticeBell.tsx` 中并无任何 `localStorage` 已读状态存储逻辑。根据 `notices.ts` 顶部注释（“站点通知:管理者及以上发布,所有登录用户可读”），仅对登录用户下发通知属于**服务端刻意设计**，但 `project.md` §5 中关于游客 `localStorage` 记录通知已读的描述与实际代码不符。

---

## Issue #7：删除黑名单两处缺陷：① `manager` 角色可借由黑名单绕过 `media.purge` 权限物理删除源文件；② SQLite 下唯一约束冲突错误码不兼容

- **性质判定**：✅ **确实是缺陷（Actual Bug / 权限边界绕过 + SQLite 驱动兼容性缺陷）**
- **代码定位**：
  - `src/server/api/blocklist.ts` 第 16 行
  - `src/server/blocklist.ts` 第 130–147 行、第 155–169 行
  - `src/server/media/ingest.ts` 第 97–104 行
- **预期功能（`project.md` §4.5 & §7.4）**：
  - 角色权限矩阵（§4.5）明确规定：`media.delete`（删除文件，默认只排除进黑名单）开放给 `admin` 与 `manager`；而 **`media.purge`（物理删除源文件）仅限 `admin`**（`manager` 不可物理删除服务器原文件）。
  - 在 `DELETE /api/v1/media/:id?purge=1` 与 `POST /api/v1/media/batch` 中，代码均严格检查了 `if (purge && !can(user, "media.purge")) throw E.forbidden("物理删除源文件需要管理员权限")`。
- **实际代码实现与问题分析**：
  1. **通过黑名单两步操作绕过 `media.purge` 限制**：
     在 `src/server/api/blocklist.ts` 第 16 行：
     ```ts
     route("DELETE", "/blocklist/:id", "media.delete", async (ctx) => purgeBlocked(ctx.params.id));
     ```
     该路由仅要求 `"media.delete"` 权限而未校验 `"media.purge"`（前端 `BlocklistTab` 的「彻底删除」按钮也未检查 `can("media.purge")`）。
     因此，`manager` 角色虽然不能直接 `DELETE /media/:id?purge=1`，但只需：
     - 第一步：调用 `DELETE /media/:id?purge=0`（仅需 `media.delete`）将文件移入黑名单；
     - 第二步：调用 `DELETE /blocklist/:blocklistId`（同样仅检查 `media.delete`）触发 `purgeBlocked()`，即可物理删除服务器或 S3 上的原文件，形成完整的权限绕过。
  2. **只读挂载相册解除挂载后黑名单残留记录可被物理删除**：
     `purgeBlocked()` 第 158–161 行通过 `b.albumId` 查询 `pgs_albums.readonly`。若某只读挂载相册中的文件曾被加入黑名单，随后管理员移除了该挂载相册登记（`pgs_albums` 行被删，但黑名单行保留），此时 `owner` 查询为空，`owner?.readonly` 为 `undefined`，再次在黑名单点「彻底删除」会直接物理删除挂载目录中的原文件。
  3. **SQLite 模式下 `unblock()` 与 `isUniqueViolation()` 仅判断 PostgreSQL 错误码 `23505`**：
     `src/server/blocklist.ts` 第 133–141 行与 `src/server/media/ingest.ts` 第 97–104 行均通过 `code === "23505"` 识别唯一约束冲突。但在 `DB_DRIVER=sqlite`（`node:sqlite`）下，唯一约束冲突抛出的异常 `code` 为 `"ERR_SQLITE_ERROR"`（`errcode` 为 `2067` 或 `1555`，`message` 含 `"UNIQUE constraint failed"`），不会等于 `"23505"`。这导致在 SQLite 模式下解除黑名单遇到 ID/路径冲突时不会换新 ID 或返回 409 Conflict，而是直接抛 500 `internal_error`。
- **是否特意如此**：否。属于权限校验遗漏与 SQLite 错误码适配遗漏。

---

## Issue #8：挂载目录扫描 (`scanOne`) 在父子相册本身无直接图片或二次扫描时，会跳过 7 天宽限期与熔断保护直接清空整棵子相册树

- **性质判定**：✅ **确实是缺陷（Actual Bug）**
- **代码定位**：`src/server/albums.ts` 第 1004–1021 行、第 1051–1052 行
- **预期功能（`project.md` §6.6）**：
  挂载目录扫描发现文件/目录消失时，应先打 `missing_at` 软删除标记（7 天 `MISSING_GRACE_MS` 宽限期）并受 `SCAN_PRUNE_MAX_RATIO` 熔断保护，防止外置硬盘掉线或目录短暂不可见时误删数据。
- **实际代码实现与问题分析**：
  在 `scanOne()` 处理本轮消失的子目录 `goneKids`（第 1004–1021 行）时：
  ```ts
  for (const g of goneKids) {
    if (claimed.has(g.id)) continue;
    const rows = await db.select({ id: media.id, missingAt: media.missingAt }).from(media).where(eq(media.albumId, g.id));
    const fresh = rows.filter((r) => !r.missingAt);
    if (fresh.length) {
      await db.update(media).set({ missingAt: new Date() }).where(inArray(media.id, fresh.map((r) => r.id)));
      s.missing += fresh.length;
    }
    // 空相册,或上一轮已全部标记缺失 → 目录确实没了,移除相册子树(记录一并清理,不进黑名单)
    if (!rows.length || fresh.length === 0) {
      const sub = descendants(t, g.id);
      const subMedia = await db.select({ id: media.id }).from(media).where(inArray(media.albumId, sub));
      if (subMedia.length) await deleteMediaByIds(subMedia.map((r) => r.id), false, { block: false });
      await db.delete(albums).where(inArray(albums.id, sub));
      s.albumsRemoved += sub.length;
      invalidateAlbums();
    }
  }
  ```
  1. **中间层级目录（自身无直接图片，图片全在孙目录）在第一次扫描就立即级联删除整棵子树**：
     第 1006 行仅查询了 `where(eq(media.albumId, g.id))`（只看 `g` 本层，未看 `descendants(t, g.id)`）。对于常见的按年份/月份分层目录（如 `/photos/2025` 下只有 `/photos/2025/01`、`/photos/2025/02` 子目录，`/photos/2025` 本层没有直接放图片），`rows.length` 为 `0`！一旦 `/photos/2025` 出现单次 `ENOENT`，第 1013 行 `!rows.length` 在**第一次扫描**就立即成立，当场将 `sub = descendants(t, g.id)` 所有子孙相册及其中全部媒体记录、派生缩略图和备注彻底删除，完全绕过了软删除标记与比例熔断。
  2. **有直接图片的子目录也在第二次扫描就被立即删除，未等待 7 天 `MISSING_GRACE_MS`**：
     本层单文件消失要等 `now - r.missingAt.getTime() > MISSING_GRACE_MS`（7 天，第 942 行）才清理；但子目录消失只要经过两轮扫描（例如间隔几分钟的定时扫描或连续点两次扫描），第二轮时 `fresh.length === 0` 即成立，立刻删除相册子树及全部媒体记录。
  3. **扫描锁 `scanLocks` 仅按单个相册 `code` 互斥（第 1051 行）**：
     当父相册 `dir_parent` 正在执行递归扫描（`recursive=true`）时，若同时对子相册 `dir_child` 发起 `POST /albums/dir_child/scan`，由于 `scanLocks.has("dir_child")` 为 `false`，两个扫描任务会并发扫描同一子目录树。
- **是否特意如此**：否。“空相册立即清理、非空相册二次确认”的注释表明作者希望避免幽灵空相册，但忽略了「父目录本层无文件而子孙目录有大量文件」的树形结构，以及与 7 天宽限期不一致的问题。

---

## Issue #9：挂载目录 (`storage='ext'`) 中的疑似损坏文件清理后未入黑名单，导致定时扫描无限重复入库与失败

- **性质判定**：✅ **确实是缺陷（Actual Bug，源于只读保护设计与扫描机制未闭环）**
- **代码定位**：`src/server/media/corrupt.ts` 第 103–126 行；配合 `src/server/albums.ts` 第 841–843 行
- **预期功能（`README.md` / `project.md` §6.13）**：
  疑似损坏文件可一键清理或停止上传满 5 小时后自动清理；对于挂载目录（`ext`），系统不删除服务器上的原文件，清理后该损坏文件不应再反复出现在疑似损坏列表中。
- **实际代码实现与问题分析**：
  在 `src/server/media/corrupt.ts` 的 `purgeCorrupt()`（第 109–124 行）中：
  ```ts
  const mounted = rows.filter((r) => r.storage === "ext").map((r) => r.id);
  ...
  // 挂载目录:只删登记,绝不物理删除用户自己的文件
  if (mounted.length) {
    const r = await deleteMediaByIds(mounted, false, { user: null, block: false });
    removed += r.removed;
    failed += r.failed.length;
  }
  ```
  - **特意设计部分**：对 `storage === "ext"` 传 `purge = false`（不物理删除用户挂载目录中的源文件）是**项目特意如此的安全设计**。
  - **实际缺陷部分**：同时传入了 `block: false`（不写入 `pgs_blocklist`）。由于源文件仍留在挂载目录中，且没有写入 `pgs_blocklist`，当下一次挂载目录扫描（`scanAllMounted` 定时扫描或手动扫描）执行时，`scanOne()` 发现该文件既不在 `pgs_media` 也不在 `blockedExtKeys()` 黑名单中，会**立即将其当作新文件重新入库并入队解码** → 解码再次失败变为 `status='failed'` → 再次进入「疑似损坏文件」 → 自动清理再次以 `block: false` 删除记录 → 下次扫描再次入库，形成无限循环。

---

## Issue #10：上传入库瞬间将管理员备注 `note` 写入了 `search_text`，在后台派生完成前违背了“备注不进 `search_text`”的隐私控制契约

- **性质判定**：✅ **确实是缺陷（Actual Bug / 与文档隐私契约冲突）**
- **代码定位**：`src/server/media/ingest.ts` 第 209 行
- **预期功能（`README.md` / `project.md` §4.4 & §5）**：
  - `README.md`：「管理员备注不参与公开搜索」
  - `project.md` §4.4：「**管理员备注不进 `search_text`**：登录用户搜索时额外匹配 `note` 列，游客无法通过搜索探测备注。」
  - `project.md` §5：「`note`(管理员备注,**不进 search_text**)」
- **实际代码实现与问题分析**：
  在 `src/server/media/ingest.ts` 的 `ingestOneInner()` 第 206–210 行插入初始 `pending` 记录时：
  ```ts
  await db.insert(media).values({
    id, albumId: target.album?.id ?? null, kind: kind.kind, filename: path.basename(key), mime: kind.mime, size: file.size,
    hash: file.hash, sortAt: new Date(), storage: target.storage, storageKey: key, status: "pending", note,
    searchText: `${path.basename(key)}\n${note}`.toLowerCase(), uploadedBy: opts.user.id,
  });
  ```
  此处直接将 `${note}` 拼接进了 `searchText` 列！
  虽然当后台队列执行 `processMedia()` 成功后（`src/server/media/derive.ts` 第 261 行），会用 `buildSearchText(row.filename, meta)`（不含 `note`）覆盖 `searchText`；但在以下场景下，游客可通过公开搜索 `GET /api/v1/media?q=` 直接搜出管理员备注内容：
  1. 批量上传或队列繁忙、文件尚处于 `status = 'pending'` 期间（`listMedia` 默认展示 `pending` 状态记录）；
  2. 文件在探测阶段因超出 `MEDIA_MAX_INPUT_MP` / `MEDIA_MAX_EST_MB` 被 `rejectMedia()` 拒绝或处理中断，未能执行到 `derive.ts` 第 261 行覆盖 `searchText`。
- **是否特意如此**：否。这是早期版本将 `note` 放入 `search_text` 时的残留代码，后来实现“备注不进 `search_text`（issue §11.3）”时只改了 `metadata.ts#buildSearchText` 和 `service.ts#listMedia`，漏改了 `ingest.ts` 第 209 行。
