# 测试说明(scripts/)

> 本目录是项目的**可重复全量测试套件**。不需要测试时无须阅读本文件(`project.md` 只给出入口)。
> 所有脚本零额外依赖(仅用 Node 内置模块 + 项目已有的 `sharp`/`exifr`),不会往 `package.json` 增加任何东西。

## 1. 脚本分工

| 文件 | 作用 | 备注 |
|---|---|---|
| `fetch-samples.mjs` | 准备素材:从 **NASA Image and Video Library** 下载真实图片/视频(含 IPTC/XMP 元数据),并合成边界素材(已知 EXIF 的 JPEG、带 SD 提示词的 PNG、webp/gif/tif/bmp/avif、EXIF 旋转图、损坏文件、中文空格文件名、去重对、2 秒测试视频) | 幂等;`--offline` 只生成合成素材;输出 `manifest.json` |
| `lib/harness.mjs` | 公共库:断言计数、HTTP 客户端(每请求随机来源 IP 避免互相限流)、服务进程启停(含残留检测、SIGBUS/意外退出提示)、PostgreSQL 重建库、轮询工具 | 被其它脚本 import |
| `test-e2e.mjs` | **REST API 端到端**(约 400 条断言,分 11 个章节,可用 `ONLY=` 单跑) | 对已运行的服务 |
| `test-cli.mjs` | **命令行 `cli/pgs.mjs`** 全部子命令 + 错误路径(约 85 条断言) | 对已运行的服务 |
| `test-hd.mjs` | 高清预览(HD):令牌/水印/缓存/限流/异常批量访问封禁(约 49 条断言) | 对已运行的服务,需要 `DATA_DIR` 与 `SESSION_SECRET` |
| `test-matrix.mjs` | **一键编排**:对 PostgreSQL 与 SQLite 各起一个全新服务,依次跑 e2e → cli → hd → 重启持久化检查,并扫描服务日志里的未处理异常 | 本机全链路入口 |
| `test-docker.sh` | **容器镜像测试**:用 docker 起真实镜像(Postgres/SQLite 各一轮),宿主机跑 e2e/cli/hd,再检查非 root、ffmpeg、jemalloc、HEALTHCHECK、重启持久化 | 需要 Docker(例如 InstaBox 测试机) |
| `instabox-test.sh` | 在 **InstaBox** 测试机上更新容器到新镜像并跑 `test-docker.sh` | 需要 `INSTABOX_API_KEY` |
| `check-config.mjs` | **静态一致性校验**(零依赖,秒级):代码读取的环境变量 ↔ compose 映射 ↔ `.env.example`、版本号 ↔ `PGS_TAG`、`schema.ts` ↔ `bootstrap.ts` 的 PG/SQLite DDL | 无需构建/数据库/Docker/root;CI 与提交前必跑 |
| `test-unit.mjs` + `unit/*.test.mjs` | **纯逻辑单元测试**(`node:test`):cgroup 解析、准入控制、内存估算、压力状态机等不依赖 sharp/DB 的模块 | Node ≥ 22.6;不需要构建 |
| `bench/` | **内存/耗时基准**(合成素材 + 真实素材),详见 `bench/README.md` | 不需要 root/联网/DB |
| `cleanup-image-versions.py` | 清理 GHCR 旧镜像(CI 用) | 与测试无关 |

### e2e 章节(`ONLY=` 取值)

`health`(健康/认证/页面冒烟)· `users`(四种角色权限、env 管理员保护、改密码令牌失效、禁用)· `albums`(嵌套、可见性、cascade、移动、环检测)·
`upload`(多格式、NASA 真实素材、EXIF/AI/视频元数据、去重/keep、损坏文件、路径穿越、未归类)· `files`(缩略图/预览/ETag、原图保护、下载密钥、视频 Range/播放令牌、游客元数据裁剪)·
`search`(文件名/相机/AI 提示词/中文/多词 AND/备注/注入字符、父子不重复、游标分页一致性、时间范围)· `media`(移动/批量/重处理、软删除=黑名单、恢复、purge、删相册 move/delete)·
`mount`(**ext 存储**:挂载拒绝项、符号链接逃逸、子相册自动生成、只读、扫描新增/改名/改内容/消失、父子搬迁不留副本、同名冲突、`dir=`、导入、黑名单恢复、解除登记)·
`url`(直链上传 + SSRF 10 种变体 + 真实 NASA 直链)· `site`(通知/设置/时区/游客开关/图标/SVG CSP)· `limits`(登录、匿名搜索、密钥校验限流)。

覆盖的存储:**local**(受管相册 `DATA_DIR/albums`)与 **ext**(挂载目录)。**s3** 需要对象存储,只测未配置时的拒绝路径(`s3_not_configured`)。

## 2. 建议的测试步骤

### 2.1 本机(无 Docker)

```bash
npm ci
npm run build                         # 测试用 next start,需要先构建
node scripts/fetch-samples.mjs        # 首次;默认输出 /tmp/pgs-samples(约 70MB,可加 --images 6 --videos 1 减小)
# 视频断言需要 ffmpeg/ffprobe;没有则相关断言自动跳过,或指定:
#   export FFMPEG_PATH=/path/ffmpeg FFPROBE_PATH=/path/ffprobe
node scripts/test-matrix.mjs          # PostgreSQL + SQLite 全链路(约 3~5 分钟)
```

常用变体:

```bash
node scripts/test-matrix.mjs --drivers sqlite                 # 只测 SQLite(不需要 PostgreSQL)
node scripts/test-matrix.mjs --only e2e --e2e-only mount      # 只跑挂载章节
node scripts/test-matrix.mjs --static                         # 先 typecheck + lint + build
node scripts/test-matrix.mjs --keep                           # 保留 /tmp/pgs-run-* (数据、服务日志)便于排查
```

PostgreSQL 需要一个**本机可连的超级用户**(默认 `postgresql://postgres:postgres@127.0.0.1:5432/postgres`,可用 `PG_ADMIN_URL` 覆盖);脚本会创建/删除 `pgs_test_postgres` 数据库。

### 2.2 单独对一个已运行的服务跑(含 Docker / 远程)

```bash
BASE=http://host:3000 ADMIN_PASSWORD=xxx SAMPLES_DIR=/tmp/pgs-samples node scripts/test-e2e.mjs
BASE=...             ADMIN_PASSWORD=xxx SAMPLES_DIR=/tmp/pgs-samples node scripts/test-cli.mjs
```

- 服务端数据目录本机可见时加 `DATA_DIR=...`,会额外校验磁盘上的原文件/派生图。
- 挂载/导入测试需要一个**测试进程可写、服务端也能看到**的目录:`MOUNT_HOST_DIR`(测试进程路径)与 `MOUNT_SERVER_DIR`(服务端看到的路径;Docker 里是挂载点,如 `/photos`)。服务端还需把该路径放进 `ALLOWED_MOUNT_ROOTS`(默认白名单含 `/photos /mnt /media /srv /home`)。不设则跳过这些章节。
- 服务端没有外网:加 `OFFLINE=1`;没有 ffmpeg:加 `HAS_VIDEO=0`。
- **测试会创建用户、相册、密钥并触发限流**,请对专用实例运行,不要对生产库运行。

### 2.3 Docker / InstaBox

```bash
scripts/test-docker.sh ghcr.io/dming623/picgalleryserver:latest   # 有 docker 的任意机器
DRIVERS=sqlite scripts/test-docker.sh                              # 只测 SQLite
```

InstaBox(把 `INSTABOX_API_URL`/`INSTABOX_API_KEY` 放进环境变量,**不要写入仓库**):

```bash
export INSTABOX_API_URL=https://api.instabox.sh INSTABOX_API_KEY=ibk_...
scripts/instabox-test.sh <机器名> [镜像标签]    # 更新容器到新镜像 + 跑 test-docker.sh,并保留原容器的恢复命令
```

### 2.4 PR 前最小检查

`npm run typecheck && npm run lint && npm run build && node scripts/test-matrix.mjs --drivers sqlite`
(仓库的 `.github/workflows/test.yml` 在 CI 里用 PostgreSQL 服务容器 + SQLite 跑同一套矩阵。)

### 2.5 不需要构建/数据库的快速检查(推荐每次提交前)

```bash
node scripts/check-config.mjs     # 配置/文档/数据库自举一致性
node scripts/test-unit.mjs        # 纯逻辑单测
```

## 3. 环境变量速查

| 变量 | 作用 | 默认 |
|---|---|---|
| `SAMPLES_DIR` | 素材目录 | `/tmp/pgs-samples` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 视频工具 | `ffmpeg` / `ffprobe` |
| `PG_ADMIN_URL` | PostgreSQL 超级用户连接串(矩阵建库用) | `postgresql://postgres:postgres@127.0.0.1:5432/postgres` |
| `PORT_BASE` | 矩阵起始端口(pg=+0, sqlite=+1) | 3100 |
| `TEST_TMP` | 临时目录根 | `/tmp` |
| `BASE` `ADMIN_USER` `ADMIN_PASSWORD` `DATA_DIR` `MOUNT_HOST_DIR` `MOUNT_SERVER_DIR` `HAS_VIDEO` `OFFLINE` `ONLY` | 单脚本参数,见各脚本头注释 | |

## 4. 退出码与排错

- 退出码 0 = 全部通过;1 = 有失败;2 = 环境不满足(缺素材、未构建、缺 docker)。
- 失败时先看 `--keep` 保留的 `/tmp/pgs-run-<驱动>/pgs-*.log`(服务日志)。`test-matrix` 会在末尾列出日志中的 `unhandled error / TypeError / Failed query`。
- 出现 `服务进程意外退出 signal=SIGBUS`:源文件在 libvips 读取期间被截断(见 §5 第 6 条的修复);出现在新版本里要重点排查。
- 端口被占用:`pkill -f "next start"` 清掉残留的测试服务后重试。

## 5. 本套测试首轮发现并修复的缺陷(v1.4.3)

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | **PostgreSQL 15 及以下**:创建相册即 500(`subquery in FROM must have an alias`) | 封面查询的 FROM 子查询没有别名;PG ≥ 16 才允许省略 | `albums.ts` 子查询加 `AS ranked` |
| 2 | **BMP 无法处理**(`unsupported image format`),但被列为支持类型 | sharp 预编译 libvips 不含 BMP 加载器 | 新增 `media/bmp.ts` 内置解码器(1/4/8/16/24/32 位),转 PNG 后交给 sharp |
| 3 | **`upload?dir=` 可写入只读挂载目录**(绕过只读保护) | `resolveTarget` 的 `dir` 分支没有检查 `readonly`;自动创建的子相册也默认只读 | `dir` 分支逐级检查只读;自动建的子相册继承父级只读状态;`dir`/挂载路径必须是绝对路径(相对路径返回 400 而非 403) |
| 4 | **挂载文件移到受管相册/未归类时只改库不搬文件**:库里归属受管相册,文件仍躺在挂载目录 | `relocateExtFile` 对非挂载目标直接返回 null | 明确拒绝(400),提示改用「导入」复制 |
| 5 | **CLI 幂等上传会漏传**:同一张图只要在*任意*相册存在,上传到另一个相册就被跳过 | `/media/exists` 全库比对;服务端去重本是按相册 | `/media/exists` 支持 `album`/`dir`,CLI 带上目标相册;`--dir` 不预检(避免副作用) |
| 6 | **服务进程被 SIGBUS 杀死**:挂载目录中的图片在处理期间被外部程序原地覆盖/截断 | libvips 对 webp/heif 等格式 mmap 源文件 | ext 图片先复制私有副本(reflink 优先)再处理 |
| 7 | **处理期间源文件变更被忽略**:扫描发现变更后重新入队,但该 id 正在处理时被去重丢弃,最终保存的是旧内容的结果 | `queue.enqueue` 对运行中的 id 直接 return | 新增 dirty 标记,运行结束后补跑一次 |
| 8 | **失败任务从不重试**,`/status` 的 `retrying` 计数永远卡住 | 退避定时器里用 `queued.has(id)` 判断,但此时 id 早已被移出 | 定时器直接重新入队 |
| 9 | CLI `upload` 不加 `-r` 也递归子目录 | `collect()` 没有使用 `recursive` 参数 | 非递归只取顶层文件 |
| 10 | `pgs version` 子命令要求先登录;`--version` 显示 1.4.0 与包版本不一致 | 凭据检查漏了 `version`;版本号硬编码 | 版本取自 `package.json`;`version` 免凭据 |
| 11 | 删除不存在的通知仍返回 200 | `deleteNotice` 不检查影响行数 | 返回 404 |
| 12 | 文档与实现不一致:`THUMB_WIDTH` 示例 480,代码默认 720 | — | `.env.example` / `project.md` 统一为 720 |

## 6. 已知局限(非缺陷,测试时请留意)

- s3 存储未覆盖正向链路(需要 MinIO/S3);挂载目录的软删除有宽限期(`MISSING_GRACE_MS`),因此「磁盘删除」后首次扫描只会 `missing=1`,不会立刻 `removed`。
- 限流类测试(登录/搜索/密钥)用固定来源 IP,依赖默认 `TRUST_PROXY=0` 且信任 `X-Real-IP`;若服务放在会覆盖该头的反代后,这一章节会失败,属环境差异。
- HEIC 未提供素材(需要真实 HEIC 文件),如需覆盖请自行放入 `SAMPLES_DIR/synth/` 并在 `test-e2e.mjs` 里追加。
