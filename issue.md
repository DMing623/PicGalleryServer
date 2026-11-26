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
