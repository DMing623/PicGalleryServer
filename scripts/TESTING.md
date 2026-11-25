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
| `test-hd.mjs` | 高清预览(HD):令牌/水印/缓存/限流/异常批量访问封禁、**游客水印成品缓存**(命中/权限重校验/Key 隔离/伪造 Host/登录用户不串用/替换与删除失效)、BMP 高清预览(约 75 条断言) | 对已运行的服务,需要 `DATA_DIR` 与 `SESSION_SECRET`;水印成品缓存要求服务配置 `ALLOWED_HOSTS` 或 `PUBLIC_BASE_URL`(matrix/docker 脚本已配置,未配置时相关断言降级为校验「不缓存」) |
| `test-media.mjs` | 媒体内存治理:`/status` 观测字段、超像素上限 → `[LIMIT]`、自动清理绝不删 `[LIMIT]` 原文件、重处理幂等、预算归零 | 服务须以 `MEDIA_MAX_INPUT_MP=10` 启动(matrix/docker 脚本自动处理) |
| `test-matrix.mjs` | **一键编排**:对 PostgreSQL 与 SQLite 各起一个全新服务,依次跑 e2e → cli → hd → 重启持久化检查,并扫描服务日志里的未处理异常 | 本机全链路入口 |
| `test-docker.sh` | **容器镜像测试**:用 docker 起真实镜像(Postgres/SQLite 各一轮),宿主机跑 e2e/cli/hd,再检查应用进程 uid、ffmpeg、jemalloc、数据目录可写、**无前缀环境变量真正进容器并生效**、cgroup 观测与预算推导、重启持久化、HEALTHCHECK;最后单起一个容器跑 `test-media`。`RUN_AS=1000`/任意 uid 可模拟「平台以非 root 直接启动镜像」,`MEM_LIMIT`/`CPUS` 带 cgroup 限制运行 | 需要 Docker;**宿主机用户也不必是 root**(`DOCKER="sudo docker"` 即可;容器写出的文件用一次性 root 容器清理) |
| `test-compose.sh` | **compose 变量传递校验**:`docker compose config` 展开不同 `.env`,验证无前缀名直接生效、`PGS_*` 旧名兼容且无前缀优先、不设置时传空串(默认值交还 `config.ts`)、必填项缺失即报错、镜像默认 tag = `package.json` 版本;并跑 `check-config` | 只需 `docker compose` CLI,**不启动容器、不需要守护进程、不需要 root** |
| `bench-docker.sh` | 在**真实镜像**里按 1G/2G/4G 档位(`--memory`/`--cpus`、jemalloc、非 root)跑 `bench/*` 基准并把结果落到宿主机目录 | 需要 Docker;结果用于校准估算系数、写进 `bench/README.md` |
| `instabox-test.sh` | 在 **InstaBox** 测试机上更新容器到新镜像并跑 `test-docker.sh`(`EXTRA_ENV="RUN_AS=1000 MEM_LIMIT=1g"` 可传入) | 需要 `INSTABOX_API_KEY` |
| `check-docs.mjs` | **文档 ↔ 代码一致性**(零依赖,秒级):`route()` 清单 ↔ `project.md` §8、`config.ts` 环境变量 ↔ 文档、文件清单 ↔ §3 目录树(双向)、版本号(`package.json` ↔ lock ↔ §0 版本表)、文档里的仓库路径引用是否存在 | 无需构建/数据库/Docker/root;CI 与提交前必跑 |
| `check-config.mjs` | **静态一致性校验**(零依赖,秒级):代码读取的环境变量 ↔ compose 映射 ↔ `.env.example`、版本号 ↔ `PGS_TAG`、`schema.ts` ↔ `bootstrap.ts` 的 PG/SQLite DDL | 无需构建/数据库/Docker/root;CI 与提交前必跑 |
| `test-unit.mjs` + `unit/*.test.mjs` | **纯逻辑单元测试**(`node:test`):cgroup 解析、准入控制、内存估算、压力状态机等不依赖 sharp/DB 的模块 | Node ≥ 22.6;不需要构建 |
| `bench/` | **内存/耗时基准**:`bench-memory`(sharp 解码本身)、`bench-hd`(HD 水印/成品缓存)、`bench-queue`(队列分池/大小图混合/HEIC 混合)、`bench-scan`(挂载目录扫描),详见 `bench/README.md` | 不需要 root/联网/DB;`bench-hd`/`bench-queue` 需先 `npm run build` |
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
scripts/test-docker.sh ghcr.io/dming623/picgalleryserver:latest   # 有 docker 的任意机器,默认按镜像默认方式启动
DRIVERS=sqlite scripts/test-docker.sh                              # 只测 SQLite
RUN_AS=1000 scripts/test-docker.sh                                 # docker run --user 1000:1000:容器从第一条指令起就是非 root(InstaBox 的方式)
RUN_AS=12345 MEM_LIMIT=1g CPUS=1 scripts/test-docker.sh            # 任意非 root uid + 1C1G 的 cgroup 限制
scripts/test-compose.sh                                            # compose 变量传递(不启动容器)
```

InstaBox(把 `INSTABOX_API_URL`/`INSTABOX_API_KEY` 放进环境变量,**不要写入仓库**):

```bash
export INSTABOX_API_URL=https://api.instabox.sh INSTABOX_API_KEY=ibk_...
scripts/instabox-test.sh <机器名> [镜像标签]                       # 更新容器到新镜像 + 跑 test-docker.sh,并保留原容器的恢复命令
EXTRA_ENV="RUN_AS=1000 MEM_LIMIT=1g" scripts/instabox-test.sh <机器名>
```

**非 root 运行要点(脚本已处理,排错时对照)**:

- 镜像默认以 root 启动 `pgs-entrypoint`,仅为修正旧数据目录属主,随后 `setpriv` 降权到 uid 1000,**应用进程始终非 root**。平台若直接用 `--user <uid>` 启动,入口脚本的 root 分支不会执行,此时数据卷必须**已经对该 uid 可写**(`test-docker.sh` 用 `chmod 777` 的宿主目录模拟)。
- 判断应用 uid 不能用 `docker exec id -u`(`RUN_AS=entry` 时恒为 0),脚本遍历 `/proc` 取 `next-server` 进程的 `Uid:`;检查 jemalloc 同样以应用 uid 读 `/proc/*/maps`。
- 容器写出的文件属主是 1000 或任意 uid,**宿主机普通用户删不掉**:脚本退出时用一次性 root 容器(`--entrypoint sh --user 0:0`)清理临时目录,不要手工 `sudo rm`。
- 宿主机用户不在 `docker` 组:`DOCKER="sudo docker" scripts/test-docker.sh`(脚本里所有 docker 调用都走 `$DOCKER`)。
- 日志里出现 `EACCES`:某个目录对运行 uid 不可写,`test-docker.sh` 会在末尾高亮打印相关日志行。

#### Docker 验证清单(维护者在有 Docker 的机器上执行;开发环境无 Docker,以下均**未在容器内实跑过**)

| # | 命令 | 期望 |
|---|---|---|
| 1 | `scripts/test-compose.sh` | 全部 ✓(compose 变量传递;无需守护进程) |
| 2 | `scripts/test-docker.sh <新镜像>` | 全部 ✓;关注「配置传递与观测」「HD(水印成品缓存)」「媒体内存治理」三段 |
| 3 | `RUN_AS=1000 scripts/test-docker.sh <新镜像>`(再试 `RUN_AS=12345`) | 同上;应用 uid = 指定值,无 `EACCES` |
| 4 | `MEM_LIMIT=1g CPUS=1 scripts/test-docker.sh <新镜像>` | `cgroup.max` 非空,预算推导 `limitMb≈1024`,媒体预算 ≈ 430MB |
| 5 | `TIERS="1g 2g 4g" scripts/bench-docker.sh <新镜像>` | 三档均完成;把表格里的 `peak` / `p95` 与 `README.md`「资源建议」对照,**用真实 HEIC 放进 `REAL_DIR` 再跑一轮 `queue`**,据此补测 `estimate.ts` 里 `low` 置信度的 HEIC/BMP/视频系数 |
| 6 | 手工:`docker compose exec app printenv \| grep -E 'HD_\|THUMB_\|MEDIA_\|COOKIE_SECURE'` 与 `GET /api/v1/status` 的 `config` | 与 `.env` 一致;不设置时回落到默认(2 核容器 `thumbConcurrency` 自适应为 2) |
| 7 | 手工:`docker stats` 下批量上传 + 打开大图,观察 `/status` 的 `queue.admission`、`memory.cgroup.anon`、`pressureState` | RSS 不越过 `mem_limit`;`pressureState` 偶尔 `elevated` 属正常 |

### 2.4 PR 前最小检查

`npm run typecheck && npm run lint && npm run build && node scripts/test-matrix.mjs --drivers sqlite`
(仓库的 `.github/workflows/test.yml` 在 CI 里用 PostgreSQL 服务容器 + SQLite 跑同一套矩阵。)

### 2.5 不需要构建/数据库的快速检查(推荐每次提交前;CI 的 `ci.yml` 也会跑)

```bash
node scripts/check-config.mjs     # 环境变量 ↔ compose 映射 ↔ .env.example ↔ 数据库自举 ↔ 版本号
node scripts/check-docs.mjs       # project.md 与代码是否漂移(路由 / 环境变量 / 文件清单 / 版本 / 路径引用)
node scripts/test-unit.mjs        # 纯逻辑单测
```

### 2.6 性能/内存回归

- **本机/CI 冒烟**:`.github/workflows/perf.yml`(手动或每周)跑 `bench-memory` / `bench-hd --assert` / `bench-queue --assert` 的 `--quick` 版本,断言很宽松,只防「明显坏了」。
- **精确对比**:固定环境(同机/同容器档位/同素材/同 `--quick`)用 `--save` + `--compare`,**内存与耗时一起看**,见 `bench/README.md`。
- 改了队列 / 闸门 / 准入 / 估算 / HD 流程后,必须重跑 `bench-hd` 与 `bench-queue` 并把结果同步到 `project.md` §17。

## 3. 环境变量速查

| 变量 | 作用 | 默认 |
|---|---|---|
| `SAMPLES_DIR` | 素材目录 | `/tmp/pgs-samples` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 视频工具 | `ffmpeg` / `ffprobe` |
| `PG_ADMIN_URL` | PostgreSQL 超级用户连接串(矩阵建库用) | `postgresql://postgres:postgres@127.0.0.1:5432/postgres` |
| `PORT_BASE` | 矩阵起始端口(pg=+0, sqlite=+1) | 3100 |
| `TEST_TMP` | 临时目录根 | `/tmp` |
| `BASE` `ADMIN_USER` `ADMIN_PASSWORD` `DATA_DIR` `MOUNT_HOST_DIR` `MOUNT_SERVER_DIR` `HAS_VIDEO` `OFFLINE` `ONLY` | 单脚本参数,见各脚本头注释 | |
| `DOCKER` | docker 命令(`test-docker.sh` / `test-compose.sh` / `bench-docker.sh`) | `docker` |
| `RUN_AS` | `test-docker.sh`:`entry`(镜像默认)或数字 uid[:gid](`--user`);`bench-docker.sh`:数字 uid[:gid] | `entry` / `1000` |
| `MEM_LIMIT` `CPUS` | `test-docker.sh`:容器 `--memory` / `--cpus` | 无 |
| `SKIP_MEDIA` | `test-docker.sh`:设 1 跳过 `test-media` 阶段 | 0 |
| `TIERS` `SUITES` `QUICK` `OUT` `REAL_DIR` | `bench-docker.sh`:内存档位、套件(memory hd queue scan)、是否缩小素材、结果目录、真实 HEIC 目录 | `1g 2g 4g` / `memory hd queue` / 1 / `./bench-out` / 无 |

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
- HEIC 未提供素材(需要真实 HEIC 文件),如需覆盖请自行放入 `SAMPLES_DIR/synth/` 并在 `test-e2e.mjs` 里追加;基准侧把真实 `.heic` 放进 `bench` 的 `--real` / `REAL_DIR` 目录即可纳入。
- 容器相关脚本(`test-docker.sh` / `bench-docker.sh` / `test-compose.sh`)开发环境无 Docker,**只做过 `bash -n` 语法检查与逻辑推演,未在容器内实跑**;首次实跑如有问题请把输出发回修正。
