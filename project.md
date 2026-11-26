# PicGalleryServer — 工程说明(面向维护者)

> 读者:第一次接触本项目的专业程序员。读完本文件应当能 **不遍历代码** 就定位到要改的文件、知道对外暴露了哪些接口、各模块的黑盒契约是什么。
> 约定:凡是"改 X 去哪个文件"的问题,先查 §3(目录职责)和 §12(常见改动速查)。
> **当前版本**:`v1.5.0`。每次版本变化或代码改动时,必须按 §0 同步跟进本文件,并执行 `node scripts/check-config.mjs` 与 `node scripts/check-docs.mjs` 校验;发现与代码不符时**以代码为准**并回改文档。
> 配套文件:`scripts/TESTING.md`(测试与基准套件说明)、`README.md`(面向使用者的功能与部署说明)。

---

## 0. 文档维护约定

> **维护提示**:每次版本变化或代码改动都必须同步跟进 `project.md`(不在此记录历史改动流水),提交前运行下方自动化脚本确保文档与代码一致。

**事实以谁为准**(文档与它们冲突时,改文档):

| 事实 | 唯一来源 |
|---|---|
| 环境变量及默认值、取值范围 | `src/server/config.ts`(`.env.example` 是模板,`docker-compose.yml` 显式映射并兼容旧 `PGS_*` 变量) |
| REST 路由、所需权限 | `src/server/api/*.ts` 里的 `route(method, path, access, handler)` |
| 表结构 | `src/db/schema.ts` + `src/db/bootstrap.ts`(PG 与 SQLite 两处 DDL 必须同步) |
| 版本号 | `package.json`(`config.version` 与 `cli/pgs.mjs` 运行时读取它;`package-lock.json`、`.env.example` 的 `PGS_TAG`、`docker-compose.yml` 默认 tag 必须一致) |
| 文件清单 | `find src cli scripts .github -type f` |
| 代码里的 `issue §x.y` 注释 | 指向一份已删除的早期审查清单,仅作历史标记,不要据此去找文档 |

**改了什么 → 同步哪一节**:

| 代码变更 | 必须同步 |
|---|---|
| 新增/删除源文件或脚本 | §3 目录树 |
| 新增/改动环境变量或硬编码阈值 | §10(含"硬编码常量"表)、`.env.example`、`docker-compose.yml`、必要时 README |
| 新增/改动路由、权限 | §8、§4.5、`cli/pgs.mjs`、`scripts/test-*.mjs` |
| 改表结构 | §5、`schema.ts` + `bootstrap.ts`(PG 与 SQLite 双分支) |
| 改队列 / 准入预算 / 内存相关逻辑 | §6.11、§7.2、§14、§16(并重跑 `scripts/bench/*` 验证) |
| 改 HD(高清预览)流程 | §6.14、§7.6、§8.11 |
| 版本号变更 | `package.json`、`package-lock.json`、`.env.example`、`docker-compose.yml` 及本文档头部版本号 |

**自动化核对命令**(在仓库根目录执行,CI 同样强制执行):

```bash
node scripts/check-config.mjs    # 环境变量 ↔ compose 映射 ↔ .env.example ↔ schema/bootstrap ↔ 版本号
node scripts/check-docs.mjs      # 路由清单 ↔ §8、环境变量 ↔ §10、文件清单 ↔ §3、版本号与文档路径引用
```

## 1. 项目概述

自托管图片 / 视频相册服务。核心能力:

- 相册分类(树形嵌套);两类相册:**受管相册**(文件存放在 `DATA_DIR` 或 S3)与**挂载相册**(把 VPS 上任意绝对路径目录就地索引,子目录自动成为嵌套子相册)。
- 缩略图 / 预览图自动生成(并发可控),详尽元数据提取(EXIF/XMP/IPTC/ICC、PNG 文本块、Stable Diffusion / NovelAI / ComfyUI / InvokeAI 生成参数、视频流信息),缺失字段展示 `N/A`。
- 原文件保护:游客只能看到管理员"公开"的相册;文件链接默认只返回预览图;原图/原视频必须带下载密钥(或具备 `original` 权限的登录用户)。
- 全局搜索 / 相册内搜索(范围严格限定在当前相册**自身**;子相册的文件只在子相册里出现,父相册不重复展示)。
- 删除可反悔:删除时默认只把文件"排除"出本项目(源文件保留,进入**删除黑名单**,扫描不再入库),只有显式勾选"同时删除源文件"才物理删除;黑名单可在设置页解除或彻底删除。
- **高清预览(HD)**:查看器放大时按需生成 1280~3840 宽的 WebP(默认上限 2560),**服务端把文字水印合成进像素**,短期令牌 + 独立限流 + 异常批量访问封禁,与原图下载完全分离(§7.6)。
- 管理员备注(只存数据库,不写入原文件)。
- 多用户、四级角色;完整 REST API + 零依赖 CLI;`.env` 配置端口、管理员、并发等私密/运行参数。
- 毛玻璃 UI,主题 / 启动页 / 站点图标均可在设置中调整(默认 Claude 经典配色)。

## 2. 技术栈与运行形态

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16 App Router(Node runtime),TypeScript,Tailwind CSS 4 |
| 数据库 | **PostgreSQL 或 SQLite 二选一**(Drizzle ORM;`pg` 驱动 / Node 内置 `node:sqlite` + `sqlite-proxy`) |
| 图像 | `sharp@0.35`(libvips 8.18,缩放/转码/统计/水印合成;预编译版**没有** BMP 与 HEVC 解码器)、`exifr`(EXIF/XMP/IPTC/ICC)、`heic-convert`(HEIC→JPEG,libheif 的 wasm 版 + 纯 JS JPEG 编码)、`media/bmp.ts`(自写 BMP 解码,输出 RGBA 交给 sharp raw 输入)、`media/png.ts`(PNG 文本块 + 隐写)、`dejavu-fonts-ttf`(水印字体) |
| 视频 | 外部 `ffmpeg` / `ffprobe`(可选,通过 `FFMPEG_PATH` / `FFPROBE_PATH`) |
| 对象存储 | `@aws-sdk/client-s3`(可选,懒加载) |
| 上传解析 | `busboy` 流式 multipart(边收边写临时文件并计算 SHA-256) |
| 认证 | 自实现:scrypt 密码哈希 + HMAC 无状态令牌(Cookie / Bearer / Basic 三种携带方式) |

运行形态:单进程 Next 服务(`npm run build && npm start`,端口由 `PORT` 决定;`engines.node >= 22`,官方镜像基于 Node 24)。后台任务(缩略图队列、定时器)、图片解码/转码(sharp)、HD 水印合成**全部与 Web/API 请求在同一个 Node 进程里**,状态挂在 `globalThis`。数据库表在启动时自动幂等创建(`src/db/bootstrap.ts`),**无需手动迁移**。

**双数据库驱动(v1.4.0)**:`src/db/index.ts` 按 `DB_DRIVER` 选择驱动,业务代码完全一致。

| 模式 | 驱动 | 适用 |
|---|---|---|
| `postgres` | `pg` 连接池 + `drizzle/node-postgres` | 正式部署、多实例、图片量大 |
| `sqlite` | Node 内置 `node:sqlite`(`DatabaseSync`)+ `drizzle/sqlite-proxy` | 手机本地测试、图片数量不多的个人图库;单文件、零外部服务 |

- 表定义仍写在 `schema.ts`(pg-core),SQLite 模式由 sqlite 方言生成 SQL;时间戳存 ISO-8601 文本、布尔存 0/1(读回时还原为 `true/false`)、`jsonb` 存 TEXT。
- 原始 SQL 一律走 `rawQuery()`(`src/db/index.ts`),pg 与 sqlite 都返回 `{rows}`;SQL 里禁止使用 pg 专有语法(`::int`、`DISTINCT ON`、`to_char`、`now()`),统一改用 `CAST(... AS INTEGER)`、窗口函数、`substr`、参数传时间。
- SQLite 模式启动时注册 `now()` / `gen_random_uuid()` 兼容函数(drizzle 的 `defaultNow()` 会生成 `now()`)。
- 未设置 `DB_DRIVER` 时:有 `DATABASE_URL` 用 postgres,否则自动回落 sqlite。

### 2.1 进程内状态清单(为什么只能单实例)

下表是全部"重启即丢/多实例会不一致"的内存状态。新增此类状态时必须登记在这里。

| 状态 | 位置 | 内容 | 重启/多实例后果 |
|---|---|---|---|
| `__pgsQueue` | `server/queue.ts` | 单点准入调度器 `Scheduler`(`admission.ts`:类别分池 + 软内存预算 + 老化 + HD 队列)、探测中集合、重试计数、`dirty` 集合、统计与已注册 `limiter` | 重启后 `ensureReady()` 先清 `tmp/`、识别崩溃中断记录(`processing_started_ms`),再把其余 `status='pending'`(最多 20000 条)重新入队;多实例会重复处理 |
| `__pgsMetrics` | `server/metrics.ts` | 1 秒采样器:最近 10 分钟峰值 RSS/anon 滑动窗口、事件循环延迟直方图、动态内存压力状态(`pressure.ts`) | 重启即清零 |
| `__pgsHd` | `server/hd/cache.ts` | HD 基图与游客水印成品缓存索引(含 LRU 时间)、失效代数 `gen`、统计 | 首次访问时重扫缓存目录重建;多实例会各自淘汰、容量记账不一致 |
| `__pgsGuard` | `server/hd/guard.ts` | HD 限流窗口、批量访问检测、封禁表、最近 300 条安全事件 | 重启即清零(封禁解除);`logs/security.log` 落盘保留 |
| `__pgsRate` | `server/rate.ts` | 匿名搜索 / 无效密钥限流计数 | 清零 |
| `__pgsScan` / `__pgsScanLocks` | `server/albums.ts` | 扫描状态、同目录并发扫描锁 | 状态丢失;多实例可同时扫同一目录 |
| `__pgsReady` | `server/ready.ts` | 初始化 Promise | — |
| `__pgsDb` / `__pgsPool` / `__pgsSqlite` | `db/index.ts`、`db/bootstrap.ts` | drizzle 实例、pg 连接池、SQLite 句柄 | — |
| 模块级 Map/Set | `albums.ts`(树缓存、统计缓存、`moveLocks`)、`blocklist.ts`(外部键缓存)、`auth.ts`(Basic/用户缓存、登录失败计数)、`media/ingest.ts`(`withHashLock`)、`media/derive.ts`(`localHints`、`heicGate`、`heicHdGate`、`videoGate`)、`hd/service.ts`(`inflight`、`gate`)、`hd/watermark.ts`(`layerCache`) | 见各节 | 全部随进程丢失 |

## 3. 目录与文件职责

```
.
├─ project.md / README.md             本文件(面向开发者) / 用户说明(功能与部署)
├─ LICENSE NOTICE                     PolyForm Noncommercial 1.0.0 与署名要求
├─ .env.example                       完整环境变量模板(含 PGS_* 兼容变量);运行时读 .env
├─ Dockerfile docker-compose.yml      容器化:node:24-bookworm-slim + ffmpeg/tini/jemalloc/tzdata;
│                                     ENV: UV_THREADPOOL_SIZE=12 MALLOC_ARENA_MAX=2 TZ=Asia/Shanghai;
│                                     入口脚本 pgs-entrypoint 加载 jemalloc、修正旧数据属主后降权到 uid 1000(亦兼容平台以 --user 非 root 直接启动)
├─ next.config.ts                     serverExternalPackages(sharp/exifr/heic-convert/busboy/aws-sdk) + 全局安全头 + HD 响应禁缓存头 + allowedDevOrigins
├─ drizzle.config.json                drizzle-kit 配置(仅开发期 push/export)
├─ eslint.config.mjs  tsconfig.json  postcss.config.mjs
├─ .github/workflows/
│    ci.yml                           check-config + check-docs + test-unit + typecheck + lint + build(Node 22)
│    test.yml                         PostgreSQL 15 服务容器 + SQLite 全链路(scripts/test-matrix.mjs,Node 24)
│    perf.yml                         手动/每周性能与内存回归基准(scripts/bench/* --quick --assert)
│    docker-publish.yml               多架构镜像构建推送 GHCR
│    cleanup-image-versions.yml       清理旧镜像版本(调用 scripts/cleanup-image-versions.py)
├─ public/                            robots.txt(Disallow: /)、sw.js(Service Worker,仅缓存静态外壳,绝不缓存 /api/ 与 /f/)、offline.html
├─ cli/pgs.mjs                        命令行管理工具(零依赖,util.parseArgs,调用 REST API)
├─ scripts/                           测试、一致性校验与基准套件(详见 scripts/TESTING.md 与 scripts/bench/README.md):
│    fetch-samples.mjs  lib/harness.mjs  test-e2e.mjs  test-cli.mjs  test-hd.mjs  test-media.mjs  test-matrix.mjs
│    test-unit.mjs  unit/admission.test.mjs  unit/cgroup.test.mjs  unit/estimate.test.mjs  unit/markdown.test.mjs
│    check-config.mjs  check-docs.mjs  test-docker.sh  test-compose.sh  bench-docker.sh  instabox-test.sh
│    bench/generate-images.mjs  bench/bench-memory.mjs  bench/bench-hd.mjs  bench/bench-queue.mjs  bench/bench-scan.mjs  bench/lib.mjs  bench/README.md
│    bench/baseline-synthetic-quick.json  bench/baseline-hd-synthetic-quick.json  bench/baseline-queue-synthetic-quick.json
│    cleanup-image-versions.py  TESTING.md
├─ data/                              运行时数据目录(DATA_DIR,默认 ./data,git 忽略)
│   ├─ albums/<albumCode>/            受管相册(local 存储)的原文件;albums/_inbox/ 为未归类收件箱
│   ├─ derived/<id前2位>/<id>.thumb.webp|.preview.webp   永久派生图
│   ├─ cache/hd/<id前2位>/<id>.<ver12>.<宽>.webp          HD 无水印基图缓存(LRU+TTL,可随时删除)
│   ├─ cache/hd/wm/<id前2位>/<id>.<ver12>.<宽>.<wmFp8>.webp  游客水印成品缓存(与基图共享容量上限与失效代数)
│   ├─ branding/icon                  自定义站点图标
│   ├─ logs/security.log(.1)          HD 安全事件(JSON Lines,>5MB 轮转一次)
│   ├─ tmp/                           上传/导入/私有副本/BMP 转换/视频抽帧临时文件(启动时全清,之后每小时清 6h 前遗留)
│   ├─ secret.key                     自动生成的会话签名密钥(0600)
│   └─ pgs.sqlite                     SQLite 模式的数据文件(DB_DRIVER=sqlite)
└─ src/
   ├─ instrumentation.ts              服务启动钩子:nodejs 运行时触发 ensureReady()
   ├─ db/
   │   ├─ index.ts                    双驱动:pg Pool + drizzle/node-postgres,或 node:sqlite + drizzle/sqlite-proxy;导出 db、pool、dbKind、rawQuery、nullSafeEq、pingDb、closeDb(本文件直接读 DATABASE_URL,是 config.ts 之外唯一读 env 的业务文件)
   │   ├─ schema.ts                   表结构定义(8 张表,见 §5)
   │   └─ bootstrap.ts                幂等建表与老库升级 DDL(pg 带 advisory lock 7351001;sqlite/pg 两套)。改 schema 必须同步改这里
   ├─ lib/                            前后端共用的纯函数(无 IO)
   │   ├─ theme.ts                    主题预设 PRESETS、themeCss()、DEFAULT_THEME
   │   ├─ api.ts                      浏览器 fetch 封装:api<T>() 自动解包信封,错误抛 ApiErr
   │   ├─ format.ts                   bytes/duration/dateTime/dayLabel 格式化
   │   ├─ markdown.ts                 零依赖 Markdown 渲染(先整体 HTML 转义再替换,链接协议白名单;生成的 <a>/<img> 用占位符保护,避免 URL 中的 _ * 被强调规则改写)
   │   └─ meta-labels.ts              元数据字段中文标签表(决定 UI 显示哪些字段)
   ├─ server/                         **全部服务端逻辑**(详见 §6)
   │   ├─ config.ts                   环境变量解析入口,导出 config 与 dirs(含 config.media.*、config.hd.*)
   │   ├─ cgroup.ts                   容器 cgroup v2/v1 内存读取(current/max/anon/inactiveFile)与工作集计算
   │   ├─ admission.ts                单点准入控制 Scheduler:类别并发池(image/heic/video)+ 软内存预算 + 老化防饥饿 + 交互式 HD 优先 + 嵌套检测
   │   ├─ pressure.ts                 动态内存压力状态机(normal/elevated/high/critical,基于 anon/limit,带迟滞与永不死锁保证)
   │   ├─ metrics.ts                  1 秒采样器(10 分钟峰值 RSS/anon、eventLoopDelay 直方图、压力状态更新)与 collectMetrics()
   │   ├─ secret.ts                   SESSION_SECRET 解析:env → DATA_DIR/secret.key → 生产自动生成 → 开发期由管理员密码派生
   │   ├─ rate.ts                     通用内存限流(匿名搜索、无效密钥校验):hit / count / overLimit
   │   ├─ http.ts                     ApiError / E 工厂 / json / ok / fail / readJson(带体积上限) / str / intParam / boolParam
   │   ├─ router.ts                   迷你路由器:route(method, pattern, access, handler)、dispatch()、clientIp()
   │   ├─ auth.ts                     角色权限矩阵、密码哈希、令牌(会话/播放/HD 共用 signToken)、请求鉴权、env 管理员同步、登录限流
   │   ├─ settings.ts                 站点设置(单 JSON,key="site")读写与校验、publicSite()、isValidTimezone()
   │   ├─ ready.ts                    ensureReady():建表→建目录→同步管理员→清理 tmp/→崩溃回路识别与恢复队列→采样器与定时器
   │   ├─ albums.ts                   相册树缓存、可见性、统计、创建/挂载/改/删、目录扫描、文件搬迁(1100+ 行,最大的单文件)
   │   ├─ blocklist.ts                删除黑名单:写入/列出/解除(恢复记录+重生成派生图)/彻底删除
   │   ├─ keys.ts                     下载密钥:创建(upsert)/列表/删除/验证/过期清理
   │   ├─ notices.ts                  站点通知:列表/未读/发布/编辑/删除/已读
   │   ├─ files.ts                    serveMedia():thumb/preview/file/stream 的授权与输出(Range/ETag;无效密钥限流走 clientIp)
   │   ├─ queue.ts                    进程内任务队列:解码前轻量探测(probeLimiter)→ Scheduler 准入 → 重试 3 次指数退避 + limiter()
   │   ├─ storage/index.ts            存储驱动抽象:local / ext / s3,materialize()
   │   ├─ hd/                         高清预览(HD)子系统(§6.14)
   │   │   ├─ service.ts              令牌签发/校验 → 权限 → 游客水印成品缓存/基图缓存/按需转换(三路预算分流)→ 水印 → 输出
   │   │   ├─ cache.ts                无水印基图 + 游客水印成品磁盘缓存(LRU+TTL+版本号)、失效代数、统计
   │   │   ├─ watermark.ts            水印层生成(平铺旋转文字,raw 画布直裁 PNG)、合成、水印指纹、用户动态标识 U-XXXXXX
   │   │   └─ guard.ts                HD 专用限流 / 批量访问检测 / 封禁 / 安全日志
   │   ├─ media/
   │   │   ├─ types.ts                扩展名→kind/mime、isHeic、safeName、randomId
   │   │   ├─ upload.ts               parseUpload():busboy 流式 multipart → 临时文件 + sha256
   │   │   ├─ fetch-url.ts            直链上传:SSRF 校验、重定向、体积/超时限制
   │   │   ├─ ingest.ts               resolveTarget()、ingestOne()(含 withHashLock)、collectFiles()/copyToTmp()
   │   │   ├─ probe.ts                解码前轻量文件头探测 probeMedia()/metaForRow()(256KB 头/BMP 26B 头/HEIC ispe box,不下载远程文件)
   │   │   ├─ estimate.ts             像素×格式布局加权内存估算 estimateMemory()、[LIMIT]/[INTERRUPTED] 非损坏错误前缀
   │   │   ├─ derive.ts               processMedia():派生图(.toFile 原子写)+ 元数据入库;derivedPath/removeDerived/heicToJpeg/bmpInput
   │   │   ├─ bmp.ts                  BMP 内置解码器(无 ffmpeg 时作为 bmpInput 回退)
   │   │   ├─ metadata.ts             extractImageMeta()、probeVideo()、grabVideoFrame()、buildSearchText()
   │   │   ├─ png.ts                  PNG 文本块读取、隐写(alpha LSB,≤16MP)提取
   │   │   ├─ ai.ts                   AI 生成参数解析(A1111/NovelAI/ComfyUI/InvokeAI)
   │   │   ├─ corrupt.ts              疑似损坏文件汇总与自动清理(硬性排除 [LIMIT]/[INTERRUPTED],绝不误删超限或中断原图)
   │   │   └─ service.ts              listMedia()、mediaDetail()、updateMedia()、batchAction()、可见性判断、baseUrl/hostTrusted
   │   └─ api/                        路由注册模块(导入即注册)
   │       ├─ index.ts                汇总导入并导出 dispatch
   │       ├─ auth.ts                 /auth/*  /site  /branding/icon  /settings*
   │       ├─ albums.ts               /albums*  /fs/browse
   │       ├─ media.ts                /media*  /media/:id/(thumb|preview|file|stream)  /system/reprocess  /system/regenerate-derived  /media-timeline
   │       ├─ hd.ts                   /media/:id/hd-token  /media/:id/hd  /security/events  /security/watermark
   │       ├─ blocklist.ts            /blocklist*  (删除黑名单)
   │       ├─ notices.ts              /notices*
   │       └─ admin.ts                /keys*  /users*  /health*  /status*
   ├─ app/
   │   ├─ layout.tsx                  根布局:注入主题 <style id="pgs-theme">、站点图标 metadata、免责声明启动脚本、Splash、AppProvider、Pwa
   │   ├─ globals.css                 CSS 变量兜底、毛玻璃(.glass)、按钮/输入样式、瀑布流(.masonry)、启动页多轴 3D 星环与逐字流光动画、通知面板
   │   ├─ manifest.ts                 PWA 清单(站点名/图标跟随设置)
   │   ├─ pwa-icon/[name]/route.ts    PWA 图标 PNG(192/512/512-maskable/180,由站点图标按需渲染)
   │   ├─ (app)/layout.tsx            带 Shell 的页面分组
   │   ├─ (app)/page.tsx              首页:全局图库 + 全局搜索(?q=)
   │   ├─ (app)/albums/page.tsx       顶层相册列表
   │   ├─ (app)/albums/[code]/page.tsx  相册详情(子相册 + 图库 + 相册内搜索);code=_unsorted 为未归类
   │   ├─ (app)/settings/page.tsx     设置页
   │   ├─ login/page.tsx              登录页
   │   ├─ f/[id]/route.ts             公开文件链接 /f/<id>[.ext][?key=][&dl=1]
   │   ├─ api/health/route.ts         平台健康检查(DB select 1)
   │   └─ api/v1/[[...path]]/route.ts REST 入口:GET/POST/PUT/PATCH/DELETE 全部转交 server/router.dispatch(HEAD 当 GET 处理)
   └─ components/                     前端组件(全部 "use client",除特别说明)
       ├─ AppProvider.tsx             上下文:me(user/perms/site/features)、can(perm)、reload() + 零延迟客户端路由与滚动记忆(navigateApp/replaceAppUrl/useAppLocation)
       ├─ Splash.tsx                  启动页(重构):深空极光星轨粒子 canvas + 光学星盘刻线 + 多轴 3D 陀螺星环 + 可替换自适应逐字快门翻转 3D 挤出文字/副标题与镜面倒影;url 模式支持图片/视频/iframe
       ├─ Shell.tsx                   毛玻璃顶栏、搜索框、底部工具栏(pointerdown 即时高亮反馈)与图库/相册/设置三大主视图常驻保活(Keep-Alive)
       ├─ Gallery.tsx                 固定列等宽瀑布流 + 二分视口窗口化(仅渲染视口±1.5 屏瓦片,Memo 瓦片)+ 游标无限滚动(每页 80)+ 处理中按需轮询;导出 MediaItem
       ├─ Viewer.tsx                  全屏查看器:HD 图(加载中转圈→带水印大图,手势缩放直接写 DOM transform)、会话详情 LRU 缓存、文件链接、备注编辑、元数据侧栏、删除/重处理
       ├─ useHd.ts                    HD 加载 hook:申请令牌→取图→Blob URL→异步预解码(img.decode);只保留当前±1 张,预加载相邻 2 张
       ├─ DialogProvider.tsx          内置对话框:choose/confirm/prompt/alert/confirmCheck
       ├─ MetaPanel.tsx               元数据渲染(固定字段缺失显示 N/A、AI 区块、原始段折叠)
       ├─ UploadDialog.tsx            上传对话框:相册下拉、存储选择、并发、进度、结果去向提示、只读挂载禁用
       ├─ AlbumsView.tsx              相册列表/详情页的客户端主体(含会话级相册缓存)、相册卡片
       ├─ AlbumActions.tsx            相册操作按钮组(新建/重命名/公开私有/只读切换/重扫/删除),导出 AlbumDto
       ├─ NoticeBell.tsx              顶栏通知铃铛 + 覆盖式面板(必须 Portal 到 body)
       ├─ Markdown.tsx                dangerouslySetInnerHTML 承载 lib/markdown.ts 的输出
       ├─ Disclaimer.tsx              免责声明弹窗(需滚动到底并等待 6 秒;localStorage 记 30 天;layout 内联脚本先行判断)
       ├─ Pwa.tsx                     注册 Service Worker(仅生产)与"安装到主屏幕"事件
       ├─ DevI18n.tsx                 仅 `next dev` 生效:Next 开发悬浮球汉化(生产不渲染)
       ├─ LoginForm.tsx               登录表单
       └─ settings/
           ├─ SettingsView.tsx        设置页标签容器(按权限显示标签,已访问子面板常驻保活)
           ├─ AppearanceTab.tsx       站点名/图标上传/主题/明暗/启动页(含可替换主标题、副标题与快捷文案预设)/游客开关,主题实时预览
           ├─ NoticeTab.tsx           通知发布(Markdown 编辑 + 预览)
           ├─ AdminTabs.tsx           导出 AlbumManager(文件夹式导航 + 目录挂载对话框)/BlocklistTab/KeysTab/UsersTab
           └─ SystemTab.tsx           系统状态面板(3 秒轮询)+ 时区 + 疑似损坏文件 + 重处理按钮
```

## 4. 核心概念

### 4.1 存储代码(storage code)与相册代码(album code)

二者都只是**用于标识的特征字符串**,不携带逻辑。

| 种类 | 取值 | 含义 |
|---|---|---|
| 存储代码 | `local` | 字节在 `DATA_DIR` 内,`storageKey` 为相对路径(如 `albums/alb_x1y2z3/IMG_1.jpg`) |
| | `s3` | 字节在对象存储,`storageKey` 为对象键(受 `S3_PREFIX` 前缀) |
| | `ext` | 字节在服务器某绝对路径(挂载相册),`storageKey` 为文件绝对路径 |
| 相册代码 | `alb_<8位>` | 受管相册(在默认 data 目录或 S3 下创建) |
| | `dir_<8位>` | 挂载相册(绝对路径目录,含自动生成的子目录相册) |
| 特殊 | `_unsorted` | 仅在列表/URL 中使用:未归类媒体(收件箱),仅登录用户可见 |

接口里的 `album` / `dir` / `storage` 参数使用这些字符串。

### 4.2 可见性模型

- 相册 `visibility` ∈ `public | private`。**有效公开 = 自身及全部祖先都是 public**。
- 游客(未登录)只能看到有效公开相册及其媒体;未归类媒体对游客不可见;`guestBrowse=false` 时游客什么都看不到。
- 任何登录用户(任意角色)可以看到全部相册(含私有、未归类)的缩略图/预览图/元数据。
- 不可见资源一律返回 404(不泄露存在性)。
- 例外:携带**有效下载密钥**访问 `/f/:id` 或 `/media/:id/file|thumb|preview` 时跳过相册可见性(密钥即授权)。

### 4.3 原文件保护

| 访问 | 无密钥游客 | 有效 `?key=` | 登录且具备 `original`(admin/manager) | 其它登录角色 |
|---|---|---|---|---|
| `/f/:id`(图片) | 预览图(webp) | 原文件 | 原文件 | 预览图 |
| `/f/:id`(视频) | 封面图 | 原视频(支持 Range) | 原视频 | 封面图 |
| `/media/:id/stream`(视频播放) | 需「可见 + 播放令牌 + 浏览器 `<video>` 请求特征」 | 原视频 | 原视频 | 同游客规则 |
| `/media/:id/thumb`、`/preview` | 按可见性放行 | 放行 | 放行 | 放行 |

- 无效/过期的 `?key=` 直接 403 `invalid_key`(不静默降级)。
- 播放令牌:`GET /media/:id` 返回的 `streamUrl` 内含 `t=<HMAC令牌,6h>`;`/stream` 额外要求 `Sec-Fetch-Dest: video|audio`(缺失时要求同源 `Referer`)。**这是遏制直接下载的手段,不是 DRM**。
- 网页展示用的是预览图(默认 1600px webp),因此"右键另存图片"得到的只是预览图。

### 4.4 搜索范围

- `GET /media?q=` 无 `album` → **全局搜索**(范围 = 访问者可见的全部媒体)。
- `GET /media?q=&album=<code>` → **只在该相册内**(默认 `recursive=0` 仅限该相册自身;显式 `recursive=1` 才把子相册一并纳入)。
- 相册浏览同样默认只看本相册文件:父相册不会重复显示子相册里的图片/视频。
- 前端:`Shell.tsx` 依据路径 `/albums/<code>` 自动把搜索限定为当前相册,并显示"当前相册/全局"标签。
- 匹配:空格分词,每个词都必须出现(AND),对 `search_text`(小写的 文件名 + 相机/镜头/软件 + 标题/描述/作者/关键词 + AI 提示词/模型)做 `LIKE %词%`。**管理员备注不进 `search_text`**:登录用户搜索时额外匹配 `note` 列,游客无法通过搜索探测备注。

### 4.5 角色与权限矩阵

权限字符串(`Perm`)定义在 `server/auth.ts`,路由注册时指定所需权限。

| 权限 | admin | manager | uploader | viewer | 游客 |
|---|:-:|:-:|:-:|:-:|:-:|
| `browse.private` 浏览私有相册 | ✓ | ✓ | ✓ | ✓ | ✗ |
| `upload` 上传 | ✓ | ✓ | ✓ | ✗ | ✗ |
| `media.edit` 备注/移动/重处理 | ✓ | ✓ | ✗ | ✗ | ✗ |
| `media.delete` 删除文件(默认只排除,进黑名单) | ✓ | ✓ | ✗ | ✗ | ✗ |
| `media.purge` 物理删除源文件 | ✓ | ✗ | ✗ | ✗ | ✗ |
| `album.manage` 创建/改/删受管相册、改可见性 | ✓ | ✓ | ✗ | ✗ | ✗ |
| `album.mount` 挂载绝对路径、目录浏览、扫描、服务器路径导入 | ✓ | ✗ | ✗ | ✗ | ✗ |
| `original` 免密钥取原文件 | ✓ | ✓ | ✗ | ✗ | ✗ |
| `status` 查看系统状态 | ✓ | ✓ | ✗ | ✗ | ✗ |
| `keys` 下载密钥管理 | ✓ | ✗ | ✗ | ✗ | ✗ |
| `users` 用户管理 | ✓ | ✗ | ✗ | ✗ | ✗ |
| `settings` 站点设置 | ✓ | ✗ | ✗ | ✗ | ✗ |

`admin` 角色 = 最高权限,与环境变量管理员等价。环境变量管理员(`source=env`)不可被删除/禁用/降权,其密码仅能通过 `ADMIN_PASSWORD` 修改。

## 5. 数据模型(`src/db/schema.ts`)

所有表以 `pgs_` 为前缀。

**pgs_users**:`id`(uuid 文本,PK) `username`(唯一) `password_hash`(`scrypt$salt$hash`) `role` `disabled` `source`(`env|api`) `token_version`(令牌版本,改密码/重置时自增) `created_at` `last_login_at`

**pgs_albums**:`id`(PK) `code`(唯一,对外使用) `name` `description` `parent_id` `kind`(`managed|mounted`) `storage`(`local|s3|ext`) `root_path`(挂载目录,唯一) `visibility` `readonly`(挂载相册默认 true) `cover_media_id` `sort_order` `last_scan_at` `created_at` `updated_at`;索引:`parent_id`、`root_path` 唯一。

**pgs_media**:`id`(12 位随机,PK) `album_id`(null=未归类) `kind`(`image|video`) `filename` `mime` `size` `mtime_ms`(源文件修改时间,变更检测/重命名配对) `width` `height` `duration`(秒) `taken_at` `sort_at`(= taken_at ?? 文件时间/上传时间,排序与游标依据) `storage` `storage_key` `hash`(SHA-256,上传才有) `color`(平均色,占位用) `status`(`pending|ready|failed`) `error` `attempts`(处理中断计数,默认 0) `processing_started_ms`(任务开始处理毫秒时间戳,用于启动时识别崩溃中断并防止无限崩溃回路) `note`(管理员备注,**不进 search_text**) `meta`(jsonb,见 §7.3) `search_text` `missing_at`(软删除标记) `uploaded_by` `created_at`;索引:`(sort_at,id)`、`(album_id,sort_at,id)`、`(storage,storage_key)` 唯一、`hash`、`status`、`missing_at`、`search_text` 的 GIN(trigram)、`status <> 'ready'` 部分索引。

**pgs_blocklist**(删除黑名单):`id`(PK) `media_id`(原记录 id,仅追溯) `album_id` `album_code` `kind` `filename` `mime` `size` `storage` `storage_key` `hash` `taken_at` `sort_at` `meta` `note` `created_by` `created_at`;唯一索引 `(storage,storage_key)`、普通索引 `album_id`。记录"被排除但源文件仍在"的文件;扫描时按 `(ext, 绝对路径)` 跳过。

**pgs_download_keys**:`id` `key_hash`(SHA-256,唯一) `hint`(前 2 位 + `*`) `label` `expires_at`(null=永不) `created_by` `created_at` `last_used_at` `use_count`。

**pgs_settings**:`key`(PK) `value`(jsonb) `updated_at`。目前只有 `key="site"`,内容为 `SiteSettings`(见 `server/settings.ts`):`siteName, theme{preset,mode,accent,background}, splash{enabled,mode,url,durationMs,title,subtitle}, iconVersion, iconMime, guestBrowse, timezone`。

**pgs_notices**(站点通知):`id`(PK) `title` `body`(Markdown 原文) `pinned` `created_by` `created_by_name`(用户名快照) `created_at` `updated_at`;索引 `created_at`。发布需要 `notice.publish`(admin / manager)。

**pgs_notice_reads**(通知已读):`user_id` + `notice_id` 复合主键 `read_at`;索引 `user_id`。存在即已读,「一键已读」= 批量插入缺失行。游客没有账户,其已读状态保存在浏览器 localStorage。

> 修改表结构:① 改 `schema.ts` ② 同步改 `bootstrap.ts` 的 `PG_DDL`(含 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`)与 `LITE_DDL`(含 `LITE_UPGRADE` 数组)③ 运行 `node scripts/check-config.mjs` 校验双驱动列定义一致。

## 6. 服务端模块黑盒契约

> 只列"暴露的接口 + 契约",实现细节请直接读对应文件。

### 6.1 `config.ts`
导出 `config`(只读,见 §10 全部环境变量)与 `dirs`(`albums/derived/tmp/branding/hdCache/logs` 绝对路径)。**其它业务文件不得直接读 `process.env`**(现状仅有 `db/index.ts` 直接读 `DATABASE_URL`,另有 `NODE_ENV` / `NEXT_PHASE` / `NEXT_RUNTIME` 的运行环境判断)。`dirs.hdCache` 默认 `DATA_DIR/cache/hd`(可用 `HD_CACHE_DIR` 改);`dirs.logs` = `DATA_DIR/logs`。部分阈值**没有**环境变量而是硬编码常量,清单见 §10.2。`SESSION_SECRET` 的解析在 `secret.ts`(env → `DATA_DIR/secret.key` → 生产环境自动生成),`config.sessionSecretSource` 会告诉你是哪一种。

### 6.2 `http.ts`
- `ApiError(status, code, message, headers?)`,工厂 `E.badRequest/unauthorized/forbidden/notFound/conflict/payloadTooLarge/tooMany`。
- `ok(data, init?)` → `{ok:true,data}`;`fail(err, requestId?)` → `{ok:false,error:{code,message,requestId}}`(非 ApiError 记录日志并返回 500 `internal_error`)。
- 入参助手:`readJson(req)`(流式读取 + `JSON_BODY_MAX_KB` 上限 + 校验 `application/json`)、`str(v,name,{max,optional})`、`intParam(v,def,min,max)`、`boolParam(v,def)`。

### 6.3 `router.ts`
- `route(method, "/path/:param", access, handler)`;`access` ∈ `"public" | "user" | Perm`。
- `handler(ctx)`,`ctx = {req, url, q(URLSearchParams), params, user|null, ip, requestId}`;返回 `Response` 原样输出,否则自动包装为 `ok(返回值)`。
- `dispatch(req, pathParts)`:`await ensureReady()` → 匹配 → 鉴权 → 调用 → 统一错误处理;路径存在但方法不符返回 405;`decodeURIComponent` 失败返回 400;每个请求生成 `X-Request-Id` 并写入响应头与错误体。
- `clientIp(req)`:默认只信任反代覆盖写入的 `X-Real-IP`;`TRUST_PROXY=n` 时取 `X-Forwarded-For` 倒数第 n 段。
- **新增接口只需在 `server/api/*.ts` 里 `route(...)`**,新文件要在 `api/index.ts` 里 import。

### 6.4 `auth.ts`
- `can(user, perm)`、`permsOf(user)`、`ROLES`、`isRole`。权限新增 `media.purge`(物理删除源文件,仅 admin)。
- `hashPassword / verifyPassword`(scrypt)、`validatePasswordStrength`(≥8 位)。
- `signToken/verifyToken`(`base64url(payload).hmac`)、`issueSession(userId, tokenVersion)`、`sessionCookie/clearCookie`、`issueStreamToken/verifyStreamToken`。
- `authenticate(req, ip)`:依次尝试 `Authorization: Bearer <token>` → `Authorization: Basic base64(user:pass)` → Cookie `pgs_session`;返回 `AuthUser|null`。令牌带 `v`(token_version),与数据库不一致即视为失效。Basic 成功结果缓存 60 秒(上限 1000 条 LRU),用户对象缓存 15 秒(上限 2000 条)。
- `verifyCredentials(username, password, ip)`:先查 IP 与用户名两个维度的失败限流,再校验;失败路径只跑 1 次 scrypt(时序均衡复用固定哈希);失败同时计入 IP 与用户名。
- `bumpTokenVersion(userId)`:改密码/管理员重置时调用,使该用户所有旧令牌立即失效。
- `syncEnvAdmin()`:启动时把 `ADMIN_USER/ADMIN_PASSWORD` 同步到 `source=env` 的账户(改 .env 重启即生效);**改名撞到已有用户名时抛错拒绝启动**,不会删除任何账户。
- `checkLoginRate / checkUserRate / recordLoginFailure / clearLoginFailures`:IP 维度 10 次/10 分钟、用户名维度 20 次/10 分钟,超限 429。

### 6.5 `settings.ts`
`getSite()`(5 秒内存缓存)、`patchSite(patch)`(校验:主题预设白名单、`#RRGGBB`、启动页 URL 必须 `https://`、时长 800~20000ms)、`setIcon(version,mime)`、`publicSite(s)`(面向游客的子集,含 `iconUrl`)。

### 6.6 `albums.ts`
- 树缓存:`loadTree()`(10 秒 TTL,写操作后调用 `invalidateAlbums()`;有 in-flight 合并,并随树一起缓存游客可见集合 `publicIds`),`descendants / breadcrumbs / effectivelyPublic`。媒体数量变化用 `invalidateMediaCaches()`(2 秒防抖),不要用 `invalidateAlbums()`。
  - **缓存代数(v1.3.5)**:`invalidateAlbums()` 会自增 `treeGen`;`loadTree()` 在查询开始时记录代数,写回缓存前比对,不一致则丢弃结果(避免"插入前启动的旧查询"把过期树盖回缓存,导致新相册在 TTL 内查不到)。同时 in-flight 查询带代数,代数已过期的查询不再被新请求复用。
- 可见性:`visibleIds(user)` → `{t, allowed: Set|null}`(`null`=不受限);`resolveAlbum(code,user)`(不可见抛 404);`scopeIds(t, album, recursive, allowed)`。
- 展示:`listAlbums(user, parent?)`、`albumDetail(code,user)`、`albumStatus(code,user)`、`albumDtos`(含 5 秒统计缓存:每相册计数/体积/处理中/失败、封面)、`unsortedCount()`。`rootPath` 仅对具备 `album.mount` 的用户返回。
- 变更:`createManaged`、`mountDir`、`updateAlbum`(`cascade:true` 时可见性级联到子孙;`readonly` 可改)、`deleteAlbum({media:'move'|'delete', purge, user})`、`deleteMediaByIds(ids, purge, {user, block})`、`relocateExtFile(row, targetAlbumId)`、`realPath`。
  - `deleteMediaByIds`:`purge=true` 才物理删除源文件;`block` 默认 `= !purge`,即未勾选删除源文件时把记录写入 `pgs_blocklist`(源文件保留)。「写黑名单 + 删记录」在同一事务里,物理删除在提交后执行,失败以 `{removed, failed[]}` 返回。扫描发现的"磁盘上已消失"的文件以 `block:false` 清理,不进黑名单。
  - `relocateExtFile`:把挂载相册(ext)里的文件真正移动到目标相册目录并返回新的 `{storageKey, filename}`,**由调用方在移动成功后再更新数据库**;用 `fs.link`+`unlink`(跨盘回落 `COPYFILE_EXCL`)保证不覆盖已有文件,失败直接抛错;目标或源相册为只读时抛 403。
  - **搬移串行化(v1.3.5)**:`relocateLocalFile` / `relocateExtFile` 外层包 `withMoveLock(row.id, ...)`,同一媒体 id 的搬移互斥;`moveNoOverwrite` 容忍 `unlink` 的 `ENOENT`(并发下另一请求已删源时,目标文件仍有效)。修复并发搬同一文件残留 nlink=2 孤儿硬链接。
  - **建目录回滚(v1.3.5)**:`createManaged` 先 `mkdir` 后 `insert`,insert 失败时 `rm -rf` 已建目录;`cleanName` 过滤 `\u0000-\u001f` 与 `\u007f`(NUL 曾触发 PostgreSQL 22021 → 500 并留孤儿目录)。
  - 删除挂载相册:只删登记与记录,不动磁盘文件(`purge=true` 才物理删除)。
  - 删除受管相册:`media=move` 把文件真正搬到父相册目录(根级则 `_inbox`)并更新 `storage_key`;`media=delete` 连文件删除;子相册上移。
- 扫描:`scanAlbum(code, recursive)`:读取目录(文件 `stat` 8 路受限并发)→ 子目录自动建嵌套相册(跳过 `.`/`@eaDir`/`#recycle`/`node_modules` 等)→ **跳过删除黑名单中的路径** → 新文件批量插入 `pending` 并入队 → `(size, mtime)` 变化的文件重新入队 → 消失/新增按 `(size, mtime)` 配对识别重命名(只改 `storage_key`,保留 id 与备注)→ 其余消失文件先打 `missing_at` 软删除标记(超过 7 天宽限期才真正清理)→ **熔断**:消失比例超过 `SCAN_PRUNE_MAX_RATIO` 且记录数 ≥ `SCAN_PRUNE_MIN_COUNT` 时中止清理并报错(若根目录不可访问同样中止并保留记录)。状态在 `scanStates`(含 `added/removed/updated/renamed/missing/albumsCreated/error`)。
- `browseDirs(path)`、`assertMountAllowed(abs)`(async,先 `realpath`;受 `ALLOWED_MOUNT_ROOTS` 约束,留空时只允许数据目录与 `/photos /mnt /media /srv /home /volume1`)、`scanAllMounted()`(`SCAN_INTERVAL_MIN` 定时器调用)。

### 6.7 `storage/index.ts`
`driverFor(code)` 返回 `StorageDriver{put,open(range),stat,remove,localPath}`;`materialize(code,key)` 返回可读的本地路径(S3 会下载到 tmp,调用方负责 `cleanup()`);`moveFile` 处理跨设备 rename;`isStorageCode`、`s3Available`。
- `local` key 解析后必须仍在 `DATA_DIR` 内(防穿越)。`ext` 要求绝对路径。
- S3 驱动 `put` 不删除源临时文件(便于复用本地副本生成派生图)。

### 6.8 `media/*`
- `types.ts`:`detectKind(filename)`(扩展名白名单,见 §9)、`safeName`、`randomId`。
- `upload.ts`:`parseUpload(req)` → `{files:[{name,mime,tmp,size,hash,truncated}], fields}`;受 `MAX_UPLOAD_MB` 限制。
- `ingest.ts`:
  - `resolveTarget({album,dir,storage})` → `{album,storage,dirKey}`:`dir` 必须落在已挂载相册根目录内(不存在的子目录自动创建并生成嵌套相册);`album` 为挂载相册则写入该目录;受管相册沿用相册自身存储代码(与显式 `storage` 冲突时 400);都不给则写入 `albums/_inbox`(`storage` 默认 `local`)。
  - `ingestOne(file, target, {user,note,duplicate})`:去重(同相册同 hash,`duplicate=skip` 默认)→ 唯一文件名 → 放入存储 → 插入 `pending` → `enqueue(id, priority)`。返回 `{status: created|duplicate|error, id, link, ...}`。
    - **入库串行化(v1.3.5)**:外层包 `withHashLock(hash:albumId, ...)`,同一 `(hash, 相册)` 的入库互斥,消除"先查后插"的并发竞态(20 路并发同一文件曾入库 2 条)。未加数据库唯一约束,因为 `album_id` 可为 NULL 且历史数据可能已有重复。
  - `collectFiles / copyToTmp`:服务器路径导入使用。
- `probe.ts`:解码前轻量探测 `probeMedia(id)` 与 `metaForRow(row)`——只读文件头(常规图片 256KB Buffer 交给 `sharp().metadata()`、BMP 读前 26B 头、HEIC 扫描 `ispe` box),**绝不解码整图,也不为探测下载 S3 远程文件**(无本地副本的 S3 文件按 `size + mime` 低置信度估算)。超出 `MEDIA_MAX_INPUT_MP` 或 `MEDIA_MAX_EST_MB` 时直接返回 `reject`(`[LIMIT]` 前缀)。
- `estimate.ts`:纯函数 `estimateMemory(meta, stage)` 按「格式布局(流式 / 渐进隔行 / CMYK)× 百万像素 × 位深」估算工作集 MB,低置信度(`low`)自动 ×1.5;导出 `NON_CORRUPT_ERROR_PREFIXES = ["[LIMIT]", "[INTERRUPTED]"]`。
- `derive.ts`:导出 `processMedia(id)`(队列 runner,流程见 §7.2)、`rejectMedia(id, reason)`、`derivedPath(id, 'thumb'|'preview')`、`removeDerived(id)`(同时 `invalidateHd`)、`hintLocalCopy(id, file)` / `localHintFor(id)` / `dropLocalHint(id)`、`heicToJpeg(file, interactive?)`、`bmpInput(file)`(优先调 `ffmpeg` 文件进文件出转临时 PNG,回退 `bmpToPng`)。模块加载时设置 `sharp.cache(false)` 与 `sharp.concurrency(config.media.sharpConcurrency)`(`SHARP_CONCURRENCY`);内部有 `heicGate`、`heicHdGate`(交互式 HD 独立容量)与 `videoGate`。
- `bmp.ts`:`isBmp(filename)`、`decodeBmp(buf)` → `{data: RGBA Buffer, width, height}`;支持 BI_RGB 1/4/8/16/24/32 位与 BI_BITFIELDS 16/32 位,不支持 RLE(抛错 → 记录 `failed`),作为无 `ffmpeg` 时 `bmpInput` 的回退。
- `corrupt.ts`:见 §6.13。`fetch-url.ts`:见 §8.4 的 `/media/upload-url`。
- `metadata.ts`、`png.ts`、`ai.ts`:见 §7.3。
- `service.ts`:`listMedia`(游标分页、可见性、范围、搜索)、`getVisible`、`canSee`、`mediaDetail`、`updateMedia`、`batchAction`、`reprocessFailed`、`baseUrl`、`hostTrusted`。

### 6.9 `keys.ts`
`createKey({key?,label?,expires:'never'|'24h'|'custom',ttlHours?,createdBy})`(相同密钥重复提交 = 更新标签与有效期)、`listKeys`、`deleteKeyById`、`deleteKeyByValue`、`verifyKey(key, countUse)`(过期即惰性删除)、`purgeExpiredKeys()`(每小时定时)。明文密钥只在创建响应里出现一次。

### 6.10 `files.ts`
`serveMedia(req, id, variant, user)`,`variant ∈ thumb|preview|file|stream`,实现 §4.3 的授权表;无效密钥限流通过 `router.ts#clientIp(req)` 取客户端 IP(遵守 `TRUST_PROXY`);派生图带 `ETag` 与 `Cache-Control`(游客可公共缓存,登录态 private);派生图未生成时返回占位 SVG(`x-pgs-state: processing`,不缓存);原文件支持 `Range`(206/416)与 `Content-Disposition`(`dl=1` 为 attachment)。

### 6.11 `queue.ts`、`admission.ts`、`pressure.ts` 与 `ready.ts`

**单点准入调度(`admission.ts` + `queue.ts`,状态在 `globalThis.__pgsQueue`)**
- `enqueue(id, priorityOrOpts?)`:支持传入 `{priority, cls}`(`cls ∈ image|heic|video`,缺省由文件名后缀或探测补全);同 id 去重;若该 id 正在运行,登记进 `dirty`,运行结束后自动补跑一次。
- **解码前轻量探测**:`pump()` 对队首窗口未探测的任务调用 `probeMedia(id)`(`probeLimiter(4)` 并发,不占解码内存预算);若探测返回 `reject`(超过 `MEDIA_MAX_INPUT_MP` 或 `MEDIA_MAX_EST_MB`),直接调 `rejectMedia(id, reason)` 写 `[LIMIT]` 失败并摘除,不进入解码。
- **单点准入(`Scheduler`)**:所有等待只发生在 `admission.ts` 一处,判定顺序固定为:
  1. **总并发与类别并发池**:`totalConcurrency`(`THUMB_CONCURRENCY`)且类别池未满(`image = THUMB_CONCURRENCY`、`heic = HEIC_CONCURRENCY`、`video = VIDEO_CONCURRENCY`),某类别满额时跳过队首继续挑选后面可运行的其它类别任务(消除 HEIC 阻塞 JPEG 的队首阻塞);
  2. **软内存预算(`MEDIA_BUDGET_MB`)与压力折扣**:并发任务估算内存总和 ≤ 有效预算;单个超软预算的大任务仅在当前无任何媒体任务运行时允许**独占启动**(`exclusive`);`MEDIA_BUDGET_MB=0` 时关闭预算约束;
  3. **老化防饥饿(aging)与交互式优先**:被预算阻塞超过 10 秒的队首大任务成为栅栏,阻止后来的小任务继续插队;交互式 HD 请求(`withHd`)优先于后台派生任务,支持 `AbortSignal` 断开取消与 15 秒超时(`503 hd_busy` + `Retry-After`),并用 `AsyncLocalStorage` 禁止同一调用链嵌套申请预算。
- **动态内存压力状态机(`pressure.ts` + `metrics.ts`)**:每秒读取 cgroup 工作集 `anon / limit`(无 cgroup 限制时取 `RSS / totalmem`):`<70% normal`、`70%~85% elevated`(有效预算 ×0.7)、`85%~93% high`(暂停 HEIC/视频/大图重任务,轻任务继续)、`>93% critical`(有任务运行时暂停新准入,空闲时仍放行最小任务以保证永不死锁);升级立即生效,降级需回落 5 个百分点并连续 3 次采样。
- **失败重试**:非 `[LIMIT]` 异常最多重试 3 次,间隔 1s / 4s / 16s;手动点击"重新处理"时重置 `attempts = 0`。

**初始化与崩溃回路保护(`ready.ts`)**
- `ensureReady()` 进程内只执行一次:`assertSecureConfig` → `runBootstrap` → 创建 `dirs` 全部目录 → `syncEnvAdmin` → **先执行 `await cleanTmp(0)` 清空遗留临时文件**(防止误删随后刚启动任务的临时文件)→ 扫描 `status='pending'` 记录:若 `processing_started_ms` 非空(说明上次进程在处理该文件时因 OOM/`SIGBUS` 崩溃中断),将 `attempts + 1`,达到 3 次则直接标记 `status='failed'` 且 `error='[INTERRUPTED] ...'` 不再入队(阻断无限崩溃回路),其余按 `created_at` 倒序最多 20000 条重新入队 → 启动 `startMetricsSampler()` 与定时任务。

### 6.12 `blocklist.ts`
- `blockedExtKeys()`:黑名单中 `storage='ext'` 的绝对路径集合(5 秒内存缓存,`invalidateBlocklist()` 失效),扫描时用于跳过。
- `addToBlocklist(rows, user)`:把即将删除的 `pgs_media` 行写入黑名单(同 `(storage,key)` 已存在则忽略),并冗余保存相册代码。
- `listBlocklist()`:按创建时间倒序返回,`leftJoin pgs_albums` 带出当前相册名。
- `unblock(id)`:校验源文件仍存在 → 重新插入 `pgs_media`(`status=pending`,沿用原相册/备注/元数据)→ 删除黑名单行 → `enqueue(id, true)` 重新生成缩略图;源文件缺失抛 `source_missing`,已存在同路径记录抛 409。
- `purgeBlocked(id)`:物理删除源文件并移除黑名单行。
- 刻意不 import `albums.ts`(避免与 `albums.ts → blocklist.ts` 形成循环依赖)。

### 6.13 `media/corrupt.ts`(疑似损坏文件)
- `noteUploadActivity()`:每次入库(含失败)调用,重置自动清理倒计时。
- **非损坏错误硬性排除**:凡是 `error` 以 `[LIMIT]`(像素或内存估算超限)或 `[INTERRUPTED]`(处理多次中断)开头的记录,属于资源限制或运行中断而非文件损坏,`corruptSummary()`、未指定 `ids` 的 `purgeCorrupt()` 与定时 `sweep()` 均将其排除,**绝不自动物理删除用户原文件**。
- `corruptSummary(limit)`:返回 `{count, items[≤limit], autoPurgeHours, purgeInSec}`。
- `purgeCorrupt(ids?)`:受管存储(local/s3)连源文件删除;挂载目录(ext)只删登记,不动用户文件。
- `startCorruptSweeper()`:每 10 分钟检查,若「距上次上传 ≥ `CORRUPT_AUTO_PURGE_HOURS`」则自动清理真正的损坏文件;`0` 关闭。

### 6.14 `hd/*`(高清预览)

对外入口(`server/api/hd.ts` 调用):`requestHdToken(req,id,user,ip,w)`、`serveHd(req,id,user,ip)`、`recentSecurityEvents(limit)`、`userMarkCode(userId)`;`hdCacheInfo()` 由 `/status` 使用。

- `service.ts`
  - **宽度档位**:`hdWidths()` = `[1280,1600,1920,2560,3840]` 中小于 `HD_WIDTH` 的项加上 `HD_WIDTH`;`snapWidth(raw)` 吸附到不小于请求值的最小档(缺省取最大档)。
  - **令牌**:payload `{m:媒体id, s:"hd", u:用户id|null, w:宽度, exp}`,TTL `HD_TOKEN_TTL_SEC`(默认 90s);`checkHdToken` 校验 scope / 媒体 / 用户绑定。
  - **`serveHd` 流程与三路预算分流**:
    1. 验令牌(失败 → `hdStrike` + 403 `hd_token_invalid`)→ `guardHd(...,'serve')` → `loadVisibleImage`(`HD_COLS` 列投影,排除大字段,并检查 `row.missingAt` 与相册可见性)→ `versionOf(row)`(原文件不存在 → `invalidateHd` + 404);
    2. **游客水印成品磁盘缓存(`cache/hd/wm/`)**:当水印开启、请求者为未登录游客(`uid === null`)且域名可信(`!wmDependsOnHost() || hostTrusted(req)`)时,以 `id + ver + width + wmFingerprint(host)` 查找成品缓存,命中直接返回(零 sharp 解码/合成开销);
    3. **未命中成品缓存时按三路申请 `Scheduler` 预算**:
       - `hit`(无水印基图缓存命中):仅申请轻量水印阶段预算 `wmEst`,执行 `applyWatermark`;
       - `coalesced`(同图同尺寸已有请求正在 `convert`):先等待 `inflight` Promise 拿到基图(期间不重复扣减解码预算),再申请 `wmEst` 执行 `applyWatermark`;
       - `miss`(基图未命中):用 `metaForRow(row)` 估算解码内存(超 `MEDIA_MAX_EST_MB` 返回 413 `hd_too_large`),申请覆盖 `convert + applyWatermark` 的预算,`convert` 产生产物并写入缓存后调用 `res.adjust(wmEst)` 立即释放解码差额,再完成水印合成;游客可缓存请求异步写入 `putCachedWm`;
    4. 响应头含 `cache-control: private, no-store, max-age=0`、`x-pgs-cache: hit|miss|coalesced`、`x-pgs-wm-cache: hit|miss|off|skip-user|untrusted-host`、`x-pgs-wm`、`x-pgs-hd-width`。
  - **`convert`**:`materialize` 原文件 → `storage==='ext'` 的常规图片先 `COPYFILE_FICLONE` 复制私有副本防 `SIGBUS` → HEIC 走 `heicToJpeg(file, true)`(`heicHdGate`),BMP 走 `bmpInput(file)` → `sharp().rotate().resize().webp().toBuffer()`。
- `cache.ts`:管理基图(`cache/hd/<id前2位>/`)与游客水印成品(`cache/hd/wm/<id前2位>/`),共享 `HD_CACHE_MAX_MB` 容量上限、`HD_CACHE_TTL_DAYS` 过期时间与失效代数 `gen`(`invalidateHd(id)` 同步清理两类缓存)。
- `watermark.ts`:`buildLayer` 将旋转文字瓦片合成到 `(W+2·pad)×(H+2·pad)` raw 画布后直接 `extract` 裁回 `W×H` 并单次编码 PNG(消除双重 PNG 编解码);`layerFor` 缓存 ≤24 个水印层(FIFO);登录用户奇数行叠加 `userMarkCode(userId)`(`U-XXXXXX`)。
- `guard.ts`:1 分钟滑动窗口限流 + 批量访问检测 + 封禁 + `logs/security.log`。

### 6.15 其余服务端文件速览

- `cgroup.ts` / `metrics.ts`:`readCgroup()` 解析容器 cgroup v2(`/sys/fs/cgroup/memory.current`、`memory.max`、`memory.stat` 的 `anon`/`inactive_file`)与 v1 回落;`startMetricsSampler()` 每秒采样更新 10 分钟峰值 RSS/anon、事件循环延迟(`perf_hooks.monitorEventLoopDelay`)与 `pressure.ts` 压力状态;`collectMetrics()` 供 `/status` 读取。
- `db/index.ts`:`DB_DRIVER` 选驱动;导出 `db`、`pool`、`dbKind`、`rawQuery(sql)`、`nullSafeEq(col,val)`、`pingDb()`、`closeDb()`。
- `db/bootstrap.ts`:`runBootstrap()` 幂等建表/索引与老库列升级(`PG_DDL` + `LITE_DDL` + `LITE_UPGRADE`)。
- `secret.ts`:`resolveSessionSecret()`、`isPlaceholderSecret()`。
- `rate.ts`:`hit(key, perMinute, message?)`、`count(key)`、`overLimit(key, perMinute)`;1 分钟滑动窗口,最多 20000 个键。
- `notices.ts`:`listNotices(user)`、`unreadCount`、`createNotice`、`updateNotice`、`deleteNotice`、`markAllRead`、`markRead`;表见 §5。

## 7. 关键流程

### 7.1 上传 / 入库
```
POST /media/upload  (multipart)
  parseUpload → 临时文件+sha256(体积上限 MAX_UPLOAD_MB,先查剩余磁盘)
  resolveTarget(album|dir|storage)   ← 目标为只读挂载相册时直接 403
  对每个文件(limiter(concurrency)): ingestOne
     去重 → uniqueKey → driver.put → INSERT pending → enqueue(priority)
  返回 {target:{album,albumName,storage}, summary, results[]}
  (wait=1 时用 idleIds 只等本次上传的文件处理完)
后台: probeMedia(id) 轻量探测 → Scheduler 准入 → processMedia(id) → status=ready
```
上传的文件落在哪:响应 `target` 明确给出相册与存储;前端上传对话框在选择相册时显示"将保存到"的路径,完成后提示"已上传到「相册名」"并提供跳转。未选择相册 → "未归类(收件箱)",登录用户在「全部」与「相册 → 未归类」中可见。全部文件失败时响应为 `ok:false` + HTTP 422。

### 7.2 派生图(`media/derive.ts#processMedia`)

任务在进入 `processMedia` 前已由 `probe.ts#probeMedia` 完成文件头探测与上限检查,并由 `Scheduler` 分配类别槽位与内存预算。

1. **列投影与启动标记**:按 `PROCESS_COLS` 查询必要列(不拉 `meta`/`search_text`),调 `invalidateHd(id)`,写入 `processing_started_ms = Date.now()`。
2. **取得本地路径**:优先复用 `localHints`(上传到 S3 时保留的本地副本),否则 `materialize()`。`finally` 中必定清理临时文件。
3. **图片**:
   - `storage === 'ext'` 的常规图片先 `copyFile(..., COPYFILE_FICLONE)` 复制到 `tmp/src-*` 私有副本,防止外部截断引发 `SIGBUS`。
   - HEIC 调 `heicToJpeg(file)` 转 JPEG Buffer;BMP 调 `bmpInput(file)`(优先 `ffmpeg` 文件进文件出转 `tmp/bmp-*.png`,失败回退内置 `decodeBmp`)。
   - `makeDerived(id, input)`:`sharp(input, INPUT_OPTS).rotate().resize(PREVIEW_WIDTH).webp({quality:84}).toFile(previewTmp)`,再以 `previewTmp` 为输入缩到 `THUMB_WIDTH` 写 `thumbTmp`,取 1×1 平均色后原子 `rename` 到 `derived/`。
   - `extractImageMeta(file, facts, tz)` 读取原文件头部(`EXIF_READ_BYTES`,TIFF 逐级放大到 64MB)提取 EXIF/XMP/IPTC/ICC/PNG 文本块与 AI 参数。
4. **视频**:`videoGate(probeVideo)` → 多候选时间点 `videoGate(grabVideoFrame)` 抽帧并用 `isBlankFrame()` 跳过纯黑片头 → `makeDerived`。
5. **写回**:更新宽高/时长/拍摄时间/`color`/`meta`/`search_text`,置 `status='ready'`、`attempts=0`、`processing_started_ms=null`。触发像素上限时写 `[LIMIT]` 前缀并不再重试。

> 内存估算系数与实测基准见 §16。

### 7.3 元数据结构(`pgs_media.meta`)
```ts
MediaMeta {
  summary: {                         // 固定字段,前端缺失显示 N/A
    file:      { format,width,height,megapixels,colorSpace,iccProfile,bitDepth,hasAlpha,density,orientation }
    camera:    { make,model,lens,lensMake,software,serial }
    exposure:  { exposureTime,fNumber,iso,focalLength,focalLength35,exposureProgram,exposureBias,meteringMode,flash,whiteBalance,sceneType }
    time:      { taken,created,modified,timezone }
    gps:       { latitude,longitude,altitude,direction }
    authoring: { title,description,artist,copyright,keywords,rating,userComment }
  }
  ai:    { tool,prompt,negativePrompt,model,seed,steps,sampler,cfgScale,size,params{},raw } | null
  video: { container,duration,resolution,videoCodec,frameRate,pixelFormat,videoBitrate,totalBitrate,audioCodec,audioChannels,sampleRate,createdAt,title,encoder,make,model,software,latitude,longitude } | null
  text:  { PNG 文本块 / 隐写解出的键值 }
  raw:   { "IFD0"|"EXIF"|"GPS"|"XMP"|"IPTC"|"ICC"|"JFIF"|"Interop"|"PNG-IHDR"|"FFprobe-Tags": {原始字段} }
}
```
AI 参数来源:PNG `parameters`(Stable Diffusion WebUI)、`Comment`+`Software`(NovelAI,含 alpha 通道 LSB 隐写 `stealth_pngcomp/pnginfo`)、`prompt`(ComfyUI API 图)、`invokeai_metadata`、JPEG/WebP 的 EXIF `UserComment`。无则 `ai=null`,前端显示 N/A。
增删展示字段:改 `metadata.ts`(提取)+ `lib/meta-labels.ts`(标签)。

### 7.4 删除与删除黑名单
```
DELETE /media/:id?purge=0|1     (purge=1 需要 media.purge,即仅 admin)
  purge=1 → 事务删记录 → 提交后物理删除源文件 → 删派生图(源文件删失败会返回 409 并说明)
  purge=0 → 事务内:记录移入 pgs_blocklist + 删除记录 → 删派生图;源文件保留
             (挂载目录重新扫描时按路径跳过,不会再入库)
POST /blocklist/:id/restore → 复用原 media_id 重新插入记录(status=pending) + enqueue → 缩略图/预览图重新生成
DELETE /blocklist/:id       → 彻底删除源文件并移除黑名单行(源文件删失败返回 409)
```
前端 `Viewer.tsx` 用 `dlg.confirmCheck()` 弹出带勾选框的确认框:勾选"同时删除服务器上的原文件"才 `purge=1`,否则 `purge=0`。批量删除走 `POST /media/batch {action:"delete"}`。

### 7.5 父子相册不产生重复文件
- 列表:`GET /media?album=` 默认 `recursive=0`,父相册只显示自身文件;子相册文件只在子相册内出现。
- 上传:`resolveTarget` 按所选相册决定落盘位置(父相册 → 父目录;子相册 → 子目录),一次上传只写一份;目标为只读挂载相册时拒绝。
- 移动:`batchAction('move')` / `PATCH /media/:id {album}` 对 `storage='ext'` 的文件调用 `relocateExtFile` **先搬文件、成功后再改库**,避免父/子目录各留一份;搬失败时记录保持原归属并在逐项结果里返回原因。
- 扫描:每个目录只索引**本层**文件,子目录交给对应子相册;`(storage,storage_key)` 唯一索引兜底防重复记录;消失/新增按 `(size,mtime)` 配对识别重命名,不产生"删一条+建一条"。

### 7.6 高清预览(HD)

```
前端 Viewer(useHd.ts)
  GET /media/:id/hd-token?w=<屏宽×DPR>   → guardHd('token') → loadVisibleImage → {token, width, expiresIn}
  GET /media/:id/hd?t=<token>&w=<档位>    → serveHd()  (见 §6.14)
        1) 每次请求先校验: 令牌 + 限流 + 可见性 + missingAt + versionOf
        2) 游客且域名可信: 先查 cache/hd/wm/ 成品缓存 → 命中直接返回(零 sharp 合成)
        3) 未命中成品缓存: 按 hit / coalesced / miss 三路向 Scheduler 申请内存预算:
             hit / coalesced → 仅申请水印阶段预算 wmEst → applyWatermark
             miss            → 申请全流水线预算 → convert → putCached → adjust(wmEst) → applyWatermark
                               (游客可缓存时异步 putCachedWm) → Response(no-store)
  浏览器: res.blob() → URL.createObjectURL;只保留当前 ±1 张,切换即 revoke;当前图就绪 250ms 后预加载相邻 2 张
```
- **缓存的是处理结果,不是访问权限**:无论命中基图还是游客水印成品缓存,每次请求都先完整执行令牌、限流、可见性与 `missingAt` 校验;登录用户因含动态标识 `U-XXXXXX` 不读写游客成品缓存。
- 失效:`processMedia` 开头、`removeDerived`、文件被删/不存在、`versionOf` 变化(大小/mtime/hash 任一改变)、水印配置或 `host` 变化(`wmFingerprint` 改变自动 miss)。
- 运维接口:`GET /security/events`(最近事件)、`GET /security/watermark?code=U-XXXXXX`(由水印反查用户,需 `users` 权限)、`/status` 里的 `hd` 块(命中/未命中/合并/淘汰/过期/失效/转换次数 + 缓存文件数与字节)。

## 8. REST API(`/api/v1`)

### 8.1 约定
- 基址 `http(s)://host:PORT/api/v1`。除文件输出类接口外均为 JSON。
- 成功:`{"ok":true,"data":...}`;失败:`{"ok":false,"error":{"code":"...","message":"..."}}`,HTTP 状态码与 `code` 对应:`400 bad_request|parent_not_found|album_not_found|dir_not_mounted|s3_not_configured|scan_failed`、`401 unauthorized`、`403 forbidden|invalid_key|stream_forbidden`、`404 not_found`、`405 method_not_allowed`、`409 conflict`、`429 too_many_requests`、`500 internal_error`。
- **认证方式(任选其一)**:
  1. `Authorization: Basic base64(管理员名:密码)` —— 命令行/脚本推荐,`curl -u admin:密码`。
  2. `Authorization: Bearer <token>` —— `POST /auth/login` 返回的 `token`(有效期 `SESSION_DAYS`)。
  3. Cookie `pgs_session` —— 浏览器登录后自动携带(HttpOnly, SameSite=Lax)。
- 下表"权限"列:`public` 不需登录(游客可访问,结果受可见性过滤);`user` 任意登录用户;其余为 §4.5 的权限字符串。

### 8.2 认证与站点

| 方法 路径 | 权限 | 参数 | 返回 / 说明 |
|---|---|---|---|
| POST `/auth/login` | public | body `{username,password}` | `{user,perms,token,expiresInSec}`,并 Set-Cookie;失败 401,按 IP 限流 |
| POST `/auth/logout` | public | — | 清除 Cookie |
| GET `/auth/me` | public | — | `{user\|null, perms[], site, features:{s3,thumbConcurrency}}` |
| POST `/auth/password` | user | `{oldPassword,newPassword}` | 修改自己的密码(env 管理员不可) |
| GET `/site` | public | — | 公开站点配置 `{siteName,theme,splash,iconUrl,guestBrowse}` |
| GET `/branding/icon` | public | — | 站点图标(自定义或内置 SVG) |
| GET `/settings` | settings | — | 完整 `SiteSettings` |
| PUT `/settings` | settings | body 补丁:`siteName`、`guestBrowse`、`theme{preset,mode(light\|dark\|auto),accent,background}`、`splash{enabled,mode(builtin\|url),url(https),durationMs,title,subtitle}`、`timezone`(IANA,经 `Intl` 校验) | 返回合并后的设置(附 `can`)。预设:`claude ocean forest rose violet mono` |
| POST `/settings/icon` | settings | multipart,任意字段名的一个文件(PNG/JPG/WebP/SVG,≤2MB) | 光栅图统一转 256×256 PNG;SVG 原样保存并以严格 CSP 输出。返回 `{iconUrl}` |
| DELETE `/settings/icon` | settings | — | 恢复默认图标 |

### 8.3 相册

| 方法 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|
| GET `/albums` | public | `parent=<code\|root>` 限定层级;`tree=1` 返回嵌套树(`children`) | `{albums[], unsorted}`(`unsorted` 仅登录用户为数字);只含可见相册 |
| POST `/albums` | album.manage | `{name, parent?, visibility?(public\|private,默认private), description?, storage?(local\|s3), sortOrder?}` | **创建受管相册**(local 会在 `DATA_DIR/albums/<code>/` 建目录)。201,返回相册详情;代码 `alb_xxxxxxxx` |
| POST `/albums/mount` | album.mount | `{path(绝对路径), name?, parent?, recursive?=true, visibility?, scan?=true}` | **挂载服务器目录**为相册,默认立即异步扫描,子目录自动生成嵌套子相册;受 `ALLOWED_MOUNT_ROOTS` 约束。201 |
| GET `/fs/browse` | album.mount | `path` | `{path,parent,dirs[]}`,挂载对话框使用 |
| GET `/albums/:code` | public | — | 详情:`breadcrumbs[]`、`children[]`、`counts`、`rootPath`(仅特权) |
| GET `/albums/:code/status` | public | — | 相册状态:计数(`media/images/videos/size/mediaTotal/sizeTotal/pending/failed/children`)、`scan` 状态、`descendants` 数 |
| PATCH `/albums/:code` | album.manage | `{name?, description?, visibility?, sortOrder?, cover?(mediaId), parent?(code\|null), cascade?(bool, 与 visibility 同用→子孙同步), readonly?(bool)}` | 修改;移动到自己子孙下会 400 |
| DELETE `/albums/:code` | album.manage | `media=move\|delete`(默认 move)、`purge=0\|1` | 挂载相册仅管理员可删,只解除登记(`purge=1` 才删磁盘文件) |
| POST `/albums/:code/scan` | album.mount | `recursive=1`、`wait=0\|1` | 重新扫描挂载相册;`wait=1` 同步返回 `{added,removed,updated,albumsCreated}` |

相册 DTO:`{code,name,description,parent,kind,storage,rootPath,visibility,effectivePublic,coverId,sortOrder,counts{...},lastScanAt,createdAt}`。

### 8.4 媒体

| 方法 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|
| GET `/media` | public | `album`(相册代码或 `_unsorted`)、`q`(搜索)、`kind=image\|video`、`recursive=1\|0`(是否含子相册,默认 0)、`cursor`、`limit`(1-200,默认 60)、`order=desc\|asc`、`from`/`to`(ISO 时间) | **列表 + 搜索**。无 `album` = 全局;有 `album` = 限定该相册。返回 `{items[], nextCursor}`(游标 = `(sort_at,id)` 键集分页) |
| GET `/media/:id` | public | — | 详情:列表字段 + `note, error, meta, storage, createdAt, breadcrumbs, canEdit, canOriginal, links{file,thumb,preview,originalTemplate,html,markdown}, streamUrl`;`storageKey/hash` 仅特权可见。游客按 `GUEST_META` 裁剪 `meta`(去 GPS/序列号/作者邮箱/raw),`note` 默认置空、`error` 置空 |
| PATCH `/media/:id` | media.edit | `{note?(≤5000), album?(code\|null)}` | 改备注(只存库,不写原文件)/ 移动相册(ext 文件会真正搬移) |
| DELETE `/media/:id` | media.delete(物理删除另需 media.purge) | `purge=0\|1` | `purge=1` 物理删除源文件(仅 admin);`purge=0`(默认)保留源文件并把记录移入删除黑名单。返回 `{deleted,purge,blocked}` |
| POST `/media/batch` | media.edit(delete 需 media.delete;路由 access 为 `user`,权限在 handler 内按 `action` 校验) | `{action: delete\|move\|reprocess, ids[1..2000], album?, purge?}` | 批量;`move` 返回逐项结果 `{affected, results:[{id,ok,error?}]}` |
| POST `/media/:id/reprocess` | media.edit | — | 重新生成派生图与元数据 |
| POST `/system/reprocess` | media.edit | — | 重新入队所有 `failed/pending` |
| POST `/system/regenerate-derived` | media.edit | — | 把全部 `status=ready` 的记录重新入队,重新生成派生图与元数据(不改状态,生成完成前仍显示旧图);大库会长时间占满队列,慎用(CLI:`pgs regenerate-derived`) |
| POST `/media/upload` | upload | multipart(多文件,字段名任意)。参数可放 query 或表单字段:`album`、`dir`、`storage`(`local` 或 `s3`)、`concurrency`(1..THUMB_CONCURRENCY,默认 4)、`duplicate`(`skip` 或 `keep`,默认 `skip`)、`note`(需 media.edit)、`wait`/`waitMs`(等本次上传处理完) | 见 §7.1。全部失败返回 `ok:false` + 422;`dir` 须位于已挂载且非只读的目录内 |
| POST `/media/upload-url` | upload | `{urls[]\|url, album?\|dir?\|storage?, duplicate?, note?}`(≤50 条) | **直链上传**:服务器下载远端图片/视频后入库。支持裸域名(自动补 `https://`)与含空格的文件名;每一跳都做 SSRF 校验(全部解析为内网地址才拒绝),限制重定向 5 次、总时长 120s、体积 `MAX_UPLOAD_MB`。返回结构同 `/media/upload` |
| POST `/media/exists` | upload | `{hashes[]}`(≤5000) | 批量查询 hash 是否已存在,供客户端做幂等同步(先查后传) |
| POST `/media/import` | album.mount | `{paths[]\|path, album\|dir\|storage, recursive?=true, concurrency?, duplicate?, note?}` | 把**服务器本地**文件/目录**复制**导入目标;返回统计与前 200 条失败项 |
| GET `/media-timeline` | public | — | 按月统计 `{months:[{m:"YYYY-MM",n}]}` |

文件输出(见 §4.3):

| 路径 | 说明 |
|---|---|
| GET `/media/:id/thumb` | 缩略图 webp(`THUMB_WIDTH`) |
| GET `/media/:id/preview` | 预览图 webp(`PREVIEW_WIDTH`) |
| GET `/media/:id/file` 与 **`/f/:id[.ext]`** | 无密钥→预览图/封面;`?key=<密钥>`→原文件;`&dl=1`→attachment |
| GET `/media/:id/stream` | 视频播放(Range) |

### 8.5 下载密钥

| 方法 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|
| GET `/keys` | keys | — | `{keys:[{id,hint,label,expiresAt,createdAt,lastUsedAt,useCount,expired}]}`(不含明文) |
| POST `/keys` | keys | `{key?(16-128位 [A-Za-z0-9_-],省略则自动生成), label?, expires: never\|24h\|custom, ttlHours?}` | **设置密钥**;明文仅在此响应返回一次;相同密钥重复提交 = 更新有效期。24h/custom 到期自动删除 |
| DELETE `/keys/:id` | keys | — | 按 id 删除 |
| DELETE `/keys?key=<明文>` | keys | — | 按明文删除(兼容旧写法,明文会进访问日志) |
| POST `/keys/revoke` | keys | `{key}` | 按明文删除(推荐:密钥放 body,不进日志) |
| GET `/keys/verify?key=` / POST `/keys/verify` | keys | `key` | `{valid}`(不计数) |

### 8.6 用户

| 方法 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|
| GET `/users` | users | — | `{users[], roles[]}` |
| POST `/users` | users | `{username(3-32 位 [A-Za-z0-9_.-]), password(≥8), role: admin\|manager\|uploader\|viewer}` | 创建,201 |
| PATCH `/users/:id` | users | `{role?, disabled?, password?}` | env 管理员不可改角色/禁用/密码;不能禁用自己 |
| DELETE `/users/:id` | users | — | env 管理员与自己不可删 |

### 8.7 系统

| 方法 路径 | 权限 | 说明 |
|---|---|---|
| GET `/health` | public | liveness:`{status:"ok",version}`,不查数据库(容器 HEALTHCHECK 用;平台用 `/api/health` 同为 liveness) |
| GET `/health/ready` | public | readiness:数据库连通 + `DATA_DIR` 可写 + 磁盘剩余;不满足返回 503 |
| GET `/status` | status | 版本、运行时长、计数、队列(含类别池 `byClass`、各闸门 `gates`、预算准入 `admission` 与压力状态 `pressure`)、`hd` 缓存统计、工具可用性、`memory` (`{rss,heapUsed,heapTotal,external,arrayBuffers,maxRss,peak10m,cgroup}`)、`sharp` (`{cache,counters,concurrency}`)、`eventLoop` (`{p99Ms,maxMs}`)、磁盘、关键配置与预算推导(结果缓存 5 秒) |
| GET `/status/queue` | status | `{concurrency,running,waiting,probing,done,failed,rejected,retrying,byClass,gates,admission,pressure}` |
| GET `/status/corrupt` | status | 疑似损坏文件(已排除 `[LIMIT]`/`[INTERRUPTED]`):`{count, items[≤20], autoPurgeHours, purgeInSec}` |
| POST `/status/corrupt/purge` | media.delete | 清理疑似损坏文件,body `{ids?}`(空 = 全部损坏项);受管存储连源文件删除,挂载目录只删登记 |

### 8.8 删除黑名单(仅 `media.delete`,即管理者及以上)

| 方法 路径 | 权限 | 说明 |
|---|---|---|
| GET `/blocklist` | media.delete | `{items:[{id,mediaId,albumId,albumCode,albumName,kind,filename,mime,size,storage,storageKey,note,createdBy,createdAt}]}` |
| POST `/blocklist/:id/restore` | media.delete | 解除黑名单:恢复记录并重新生成缩略图,返回 `{id,albumId}`;源文件不存在 → 400 `source_missing` |
| DELETE `/blocklist/:id` | media.delete | 彻底删除:移除服务器源文件并删除黑名单行 |

### 8.9 站点通知(读取 public,发布需 `notice.publish`)

| 方法 路径 | 权限 | 说明 |
|---|---|---|
| GET `/notices` | public | `{items:[{id,title,body,pinned,createdAt,updatedAt,createdBy,createdByName,read}], unread, total, timezone}`;游客返回空列表 |
| GET `/notices/unread` | public | `{unread}`(铃铛红点,轮询用) |
| POST `/notices` | notice.publish | `{title(≤120), body(Markdown,≤100000), pinned?}`;发布者自动标记已读 |
| PATCH `/notices/:id` | notice.publish | `{title?, body?, pinned?}` |
| DELETE `/notices/:id` | notice.publish | 删除通知及其已读记录 |
| POST `/notices/:id/read` | user | 单条已读 |
| POST `/notices/read-all` | user | 一键已读,返回 `{marked}` |

### 8.10 curl 示例
```bash
A="-u admin:密码"; B=http://127.0.0.1:3000/api/v1
curl $A -X POST $B/albums -H 'content-type: application/json' -d '{"name":"旅行","visibility":"public"}'
curl $A -X POST $B/albums/mount -H 'content-type: application/json' -d '{"path":"/srv/photos","name":"外部相册"}'
curl $A -X POST "$B/media/upload?album=alb_xxxxxxxx&concurrency=8" -F f=@a.jpg -F f=@b.mp4
curl $A -X POST "$B/media/upload?dir=/srv/photos/2024/trip" -F f=@c.jpg      # 指定挂载目录内的子目录
curl $A -X POST $B/media/upload-url -H 'content-type: application/json' \
  -d '{"urls":["images-assets.nasa.gov/image/carina_nebula/carina_nebula~orig.png"],"album":"alb_xxxxxxxx"}'
curl $A -X POST $B/keys -H 'content-type: application/json' -d '{"key":"my-secret-key","expires":"24h"}'
curl $A -X POST $B/notices -H 'content-type: application/json' -d '{"title":"维护通知","body":"**今晚** 22:00 维护"}'
curl $A -X PUT  $B/settings -H 'content-type: application/json' -d '{"timezone":"Asia/Tokyo"}'
curl -o orig.jpg "http://host:3000/f/<id>?key=my-secret-key"                  # 原图;去掉 key 则得到预览图
curl -G "$B/media" --data-urlencode "q=日落" --data-urlencode "album=alb_xxxxxxxx"   # 相册内搜索
curl $A -X POST $B/users -H 'content-type: application/json' -d '{"username":"bob","password":"password123","role":"viewer"}'
curl $A $B/albums/alb_xxxxxxxx/status
curl $A -X DELETE "$B/media/<id>?purge=0"        # 仅排除(进黑名单,源文件保留)
curl $A $B/blocklist                              # 查看黑名单
curl $A -X POST $B/blocklist/<bid>/restore        # 解除黑名单并重生成缩略图
```

### 8.11 高清预览与安全事件(定义在 `server/api/hd.ts`,流程见 §6.14 / §7.6)

| 方法 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|
| GET `/media/:id/hd-token` | public | `w`(期望宽度,服务端吸附到档位) | `{id, token, expiresIn, width}`;媒体不可见 → 404(并计入异常检测);非图片 → 400;被限流 → 429 + `retry-after` |
| GET `/media/:id/hd` | public | `t`(令牌,必填)、`w` | 带水印的 `image/webp`;令牌无效/过期/跨媒体 → 403 `hd_token_invalid`;超估算硬限制 → 413 `hd_too_large`;预算等待超时 → 503 `hd_busy`(带 `retry-after`);`cache-control: private, no-store`;头 `x-pgs-cache`(`hit` / `miss` / `coalesced`)、`x-pgs-wm-cache`(`hit` / `miss` / `off` / `skip-user` / `untrusted-host`)、`x-pgs-wm`(`0` / `1`)、`x-pgs-hd-width` |
| GET `/security/events` | status | `limit`(≤300,默认 100) | `{events[]}`:内存中最近的安全事件(`hd_denied / hd_rate_limited / hd_scan_detected / hd_blocked / hd_abuse_blocked`),落盘在 `DATA_DIR/logs/security.log` |
| GET `/security/watermark` | users | `code=U-XXXXXX` | `{matches:[{id,username,role}]}`:由水印里的动态标识反查用户(遍历全部用户计算 HMAC) |

## 9. 支持的文件类型
图片:`jpg jpeg png gif webp avif bmp tif tiff heic heif hif`(GIF 仅取首帧;HEIC 由 `heic-convert` 解码;BMP 优先由 `ffmpeg` 转临时 PNG,无 `ffmpeg` 时回退 `media/bmp.ts`)。
视频:`mp4 m4v mov webm mkv avi wmv flv 3gp mpg mpeg ts`(封面/元数据依赖 ffmpeg/ffprobe,浏览器能否播放取决于编码)。
增减类型:改 `server/media/types.ts` 的 `IMAGE_EXT / VIDEO_EXT`,并同步 `cli/pgs.mjs` 的 `EXT`。

## 10. 环境变量(`.env`)

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL 连接串(`DB_DRIVER=postgres` 时必填) |
| `DB_DRIVER` | 自动 | `postgres` / `sqlite`;未设置时有 `DATABASE_URL` 用 postgres,否则 sqlite |
| `SQLITE_FILE` | `DATA_DIR/pgs.sqlite` | SQLite 数据文件(`DB_DRIVER=sqlite`) |
| `TZ` | `Asia/Shanghai` | 站点默认时区(IANA);通知发布时间与日期分组按它换算,部署后可在设置页改 |
| `PORT` | 3000 | 服务端口(`next start` 直接读取) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / `admin123456` | 超级管理员;每次启动同步到数据库。**生产环境若仍是占位密码会拒绝启动** |
| `SESSION_SECRET` | 自动生成 | 令牌签名密钥;留空时生产环境自动生成并持久化到 `DATA_DIR/secret.key`(0600) |
| `SESSION_DAYS` | 30 | 登录令牌有效天数 |
| `COOKIE_SECURE` | false | HTTPS 反代后设为 true |
| `PUBLIC_BASE_URL` | 空 | 生成文件链接用的对外地址(空则取请求头,并受 `ALLOWED_HOSTS` 约束) |
| `ALLOWED_HOSTS` | 空 | 可用于生成链接/水印的 Host 白名单,逗号分隔 |
| `TRUST_PROXY` | 0 | 信任几层反代;0 = 只信反代覆盖写入的 `X-Real-IP` |
| `DATA_DIR` | `./data` | 数据目录 |
| `THUMB_CONCURRENCY` | `min(4,CPU)` | 图片处理并发(1-128) |
| `VIDEO_CONCURRENCY` / `HEIC_CONCURRENCY` | 2 / 1 | 视频与 HEIC 解码单独限流 |
| `SHARP_CONCURRENCY` | 2 | 每个 sharp 任务的 libvips 线程数(1-16;1C1G 低内存机器建议设 1) |
| `MEDIA_MAX_INPUT_MP` | 268 | 派生图允许的最大输入百万像素(1-2000;超出以 `[LIMIT]` 拒绝,绝不被 `corrupt.ts` 误删原文件) |
| `MEDIA_BUDGET_MB` | 自动推导 | 媒体处理软内存预算(MB,0-65536;默认按 `(limit×0.85 − baseRss)×0.7` 钳制在 256~2048;`0` 关闭预算约束) |
| `MEDIA_MAX_EST_MB` | `MEDIA_BUDGET_MB×1.5` | 单任务估算内存硬上限(MB,0-65536;超出直接以 `[LIMIT]` 拒绝;`0` 关闭硬上限) |
| `MEDIA_PRESSURE_GUARD` | true | 动态内存压力保护开关(根据 cgroup `anon`/RSS 水位自动折扣预算或暂停重任务) |
| `THUMB_WIDTH` / `PREVIEW_WIDTH` | 720 / 1600 | 派生图最大宽度 |
| `EXIF_READ_BYTES` | 1048576 | EXIF 只读文件头字节数(读不到再放大到 8MB) |
| `MAX_UPLOAD_MB` | 2048 | 单文件上限,0=不限 |
| `MIN_FREE_DISK_MB` | 1024 | 上传前要求的最小剩余磁盘,0=不检查 |
| `CORRUPT_AUTO_PURGE_HOURS` | 5 | 疑似损坏文件在停止上传满该小时数后自动清理(排除 `[LIMIT]`/`[INTERRUPTED]`),0=关闭 |
| `JSON_BODY_MAX_KB` | 1024 | JSON 请求体上限 |
| `DB_POOL_MAX` / `DB_STATEMENT_TIMEOUT_MS` / `DB_CONNECT_TIMEOUT_MS` / `DATABASE_SSL` | 10 / 20000 / 5000 / false | 连接池与慢查询保护 |
| `ALLOWED_MOUNT_ROOTS` | 空 | 逗号分隔白名单;留空时只允许数据目录与 `/photos /mnt /media /srv /home /volume1` |
| `SCAN_INTERVAL_MIN` | 0 | 挂载相册自动重扫间隔(分钟),0=关闭 |
| `SCAN_MAX_DEPTH` | 32 | 递归扫描最大目录深度(1-128);超出时计入 `truncated` 并在扫描结果中提示 |
| `SCAN_PRUNE_MAX_RATIO` / `SCAN_PRUNE_MIN_COUNT` | 0.3 / 20 | 扫描熔断:一次允许清理的最大消失比例与最小样本数 |
| `GUEST_META` | `basic` | 游客元数据级别:`full` / `basic`(去 GPS/序列号/作者邮箱/raw)/ `none` |
| `GUEST_NOTE` | false | 游客是否可见管理员备注 |
| `SEARCH_RATE_PER_MIN` / `KEY_RATE_PER_MIN` | 60 / 30 | 匿名搜索与无效密钥校验的每 IP 每分钟上限 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | 视频工具路径 |
| `S3_BUCKET` `S3_REGION` `S3_ENDPOINT` `S3_ACCESS_KEY` `S3_SECRET_KEY` `S3_FORCE_PATH_STYLE` `S3_PREFIX` | — | 配置 `S3_BUCKET` 即启用对象存储 |
| `HD_*` | 见 §10.1 | 高清预览:宽度/质量/并发/缓存/令牌/限流/水印 |

### 10.1 `HD_*` 变量(`config.hd`)

| 变量 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `HD_WIDTH` | 2560 | 1024-4096 | 最大输出宽度(档位表 `[1280,1600,1920,2560,3840]` 中小于它的项 + 它自己) |
| `HD_MAX_HEIGHT` | 4096 | 1024-8192 | 最大输出高度(防超长图) |
| `HD_QUALITY` | 82 | 40-95 | 基图 WebP 质量;水印合成后的输出质量为 `min(95, HD_QUALITY+3)` |
| `HD_MAX_INPUT_MP` | 200 | 10-1000 | 单张原图允许的最大输入像素(百万),传给 sharp `limitInputPixels` |
| `HD_CONCURRENCY` | 3 | 1-32 | `convert` 与水印合成**共用**的并发闸门 |
| `HD_CACHE_DIR` | `DATA_DIR/cache/hd` | — | 缓存目录(容器内固定随 `/app/data` 卷持久化) |
| `HD_CACHE_MAX_MB` / `HD_CACHE_TTL_DAYS` | 2048 / 7 | 16-1048576 / 0.01-365 | 缓存**磁盘**上限(LRU,基图 + 游客水印成品合计)与过期天数;**不是内存上限** |
| `HD_TOKEN_TTL_SEC` | 90 | 15-3600 | 令牌有效期 |
| `HD_RATE_IP_PER_MIN` / `HD_RATE_USER_PER_MIN` / `HD_RATE_MEDIA_PER_MIN` / `HD_RATE_TOKEN_PER_MIN` | 30 / 40 / 120 / 60 | 1-100000 | 取图(IP/用户/媒体)与申请令牌(IP)的每分钟上限 |
| `HD_SCAN_DISTINCT` / `HD_SCAN_WINDOW_SEC` / `HD_SCAN_BLOCK_SEC` | 150 / 300 / 300 | 5+ / 30-86400 / 10-86400 | 批量访问检测:窗口内不同图片数上限 / 窗口秒数 / 封禁秒数 |
| `HD_WM_ENABLED` | true | — | 是否合成水印 |
| `HD_WM_TEXT` | `Source: {host} · {project}` | — | 宏 `{host}`(请求域名,受 `PUBLIC_BASE_URL`/`ALLOWED_HOSTS` 影响)、`{project}`(`PROJECT_URL`) |
| `HD_WM_OPACITY` / `HD_WM_FONT_SIZE` / `HD_WM_ANGLE` / `HD_WM_DENSITY` | 8 / 16 / -30 / 3 | 1-100 / 8-96 / -90~90 / 1-5 | 透明度(%)/字号(按图宽在 0.7~1.4 倍间缩放)/角度/平铺密度 |
| `HD_WM_USER` | true | — | 登录用户叠加动态标识 `U-XXXXXX` |
| `HD_WM_FONT_FILE` | 空 | — | 空 = `node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf`(仅拉丁字符;中文水印需 CJK 字体文件) |

### 10.2 硬编码常量(**没有**环境变量)

| 常量 | 值 | 位置 | 影响 |
|---|---|---|---|
| `sequentialRead` | true(派生图) | `media/derive.ts` | 流式读取降低常规格式峰值 |
| `sharp.cache` | false | `media/derive.ts` 模块加载时 | 关闭 libvips 操作缓存(线程数由 `SHARP_CONCURRENCY` 控制) |
| preview / thumb WebP 质量 | 84 / 84;thumb 高度上限 = 2×`THUMB_WIDTH` | `media/derive.ts#makeDerived` | — |
| HEIC→JPEG 质量 | 0.92 | `media/derive.ts#heicToJpeg` | 中间 JPEG 体积 |
| EXIF 最大读取 `EXIF_MAX_BYTES` | 64MB(TIFF 逐级放大 `EXIF_READ_BYTES`→8MB→64MB) | `media/metadata.ts` | 每个并发任务最多一个该大小的 Buffer |
| PNG 隐写提取像素上限 | 16,000,000 | `media/png.ts#readStealthInfo` | 超过不提取 |
| 队列重试与崩溃回路上限 | 3 次(运行时退避 1s/4s/16s;崩溃中断达 3 次写 `[INTERRUPTED]`) | `queue.ts` / `ready.ts` | — |
| 老化阈值 `agingMs` / HD 等待超时 | 10s / 15s | `admission.ts` / `hd/service.ts` | 防大任务饥饿 / 超时返回 503 `hd_busy` |
| 启动恢复 pending 上限 | 20000 条 | `ready.ts` | 超出只警告 |
| 缓存 TTL | 相册树 10s、相册统计 5s、黑名单外部键 5s、`/status` 5s、ffmpeg 探测 60s、Basic 认证 60s、用户对象 15s | `albums.ts` `blocklist.ts` `api/admin.ts` `auth.ts` | — |
| 软删除宽限期 `MISSING_GRACE_MS` | 7 天 | `albums.ts` | — |
| 扫描并发 / 探测并发 | 目录项 `stat` 8 路 / `probeLimiter` 4 路 | `albums.ts` / `queue.ts` | — |
| 登录失败限流 | IP 10 次 / 用户名 20 次 / 10 分钟 | `auth.ts` | — |
| 限流表上限 | `rate.ts` 20000 键;HD 安全事件内存 300 条、日志 5MB 轮转 | `rate.ts` `hd/guard.ts` | — |
| 水印层缓存 / 游客成品缓存条目上限 | 水印层 ≤24 个(FIFO);游客成品 ≤4000 条 | `hd/watermark.ts` / `hd/cache.ts` | — |
| 导入/上传并发 | 上传 `concurrency` 默认 4(≤`THUMB_CONCURRENCY`);直链上传 `min(3, THUMB_CONCURRENCY)`;服务器路径导入默认 4(≤`THUMB_CONCURRENCY`),单次最多 20000 个文件 | `api/media.ts` | 只影响入库(落盘+哈希),不是解码并发 |
| 直链下载 | 超时 120s、最多 5 次重定向 | `media/fetch-url.ts` | — |
| 镜像环境 | `UV_THREADPOOL_SIZE=12`(compose 可覆盖)、`MALLOC_ARENA_MAX=2`、`LD_PRELOAD=libjemalloc`、`NODE_OPTIONS=--max-old-space-size=${PGS_NODE_HEAP_MB:-1024}` | `Dockerfile` / `docker-compose.yml` | libuv 线程池与内存碎片 |

### 10.3 docker compose 的变量传递规则(重要)

`docker-compose.yml` 的 `app.environment` 采用**最小权限显式白名单映射**(不使用整份 `env_file:` 注入,以免把 `PGS_DB_PASSWORD` 等宿主机/数据库变量暴露进应用容器):

1. **无前缀标准名优先 + 兼容历史 `PGS_*` 前缀**:对曾有 `PGS_*` 别名的变量统一写为 `${THUMB_CONCURRENCY:-${PGS_THUMB_CONCURRENCY:-}}`,其余变量写为 `${NAME:-}`;未设置时传空串交由 `src/server/config.ts` 计算默认值(例如 `THUMB_CONCURRENCY` 的 `Math.min(4, cpu)` 与 `MEDIA_BUDGET_MB` 的容器内存自适应推导),**禁止在 compose 中硬编码数字默认值**。
2. **显式不映射项**:`PORT`(容器内固定 3000)、`DATA_DIR`(容器内固定 `/app/data`)、`HD_CACHE_DIR`(默认随 `/app/data` 卷持久化)。
3. **自动化门禁**:`node scripts/check-config.mjs` 强制校验 `src/` 读取的每一个环境变量均已在 `docker-compose.yml` 映射(或在 `NOT_MAPPED` 白名单登记理由)且已在 `.env.example` 说明。

## 11. 命令行(`cli/pgs.mjs`)

零依赖,Node ≥ 22。认证:`PGS_URL` + (`PGS_TOKEN` 或 `PGS_USER`/`PGS_PASSWORD`);`pgs login` 会把令牌存到 `~/.config/pgs/credentials.json`(0600)。参数解析用 `util.parseArgs`,未知参数直接报错。

```
node cli/pgs.mjs login [--user 名] [--password-stdin] | logout
node cli/pgs.mjs status | status queue [--watch]
node cli/pgs.mjs album list [--tree] | info <code> | status <code>
node cli/pgs.mjs album create <名称> [--parent 代码] [--public] [--storage local|s3]
node cli/pgs.mjs album mount <绝对路径> [--name 名] [--parent 代码] [--public] [--no-recursive] [--no-readonly]
node cli/pgs.mjs album set <code> [--name] [--public|--private] [--cascade] [--readonly|--no-readonly] [--parent 代码|root]
node cli/pgs.mjs album rm <code> [--delete-media] [--purge]      |  album scan <code> [--wait]
node cli/pgs.mjs upload <文件/目录...> [--album 代码|--dir /绝对路径] [--storage local|s3] [-c 并发] [--duplicate skip|keep] [--note 文本] [-r] [--dry-run]
node cli/pgs.mjs import <服务器路径...> [--album|--dir|--storage] [-c 并发]
node cli/pgs.mjs media list [--all] [--cursor C] [--json] | get <id> [--links] | note | rm | move | reprocess
node cli/pgs.mjs blocklist list | restore <id> | purge <id>
node cli/pgs.mjs key list | key set [--key K] [--ttl never|24h|<小时>] [--label L] | key rm <id> | key rm --key K
node cli/pgs.mjs user list | add <名> --pw 密码 [--role r] | set <名> [--role r] [--pw p] [--disable|--enable] | rm <名>
node cli/pgs.mjs settings get | set '<JSON>' | icon <文件> | icon-reset
node cli/pgs.mjs reprocess | regenerate-derived
```
`upload` 会先流式计算 SHA-256 调 `POST /media/exists` 跳过已存在文件,因此可反复执行做幂等同步;请求带 120 秒超时与 429/5xx 指数退避重试。新增 API 后,同步在 CLI 的 `main()` switch 里加子命令。

## 12. 常见改动速查

| 想做什么 | 改哪里 |
|---|---|
| 新增 REST 接口 | `server/api/<模块>.ts` 里 `route(...)`;业务逻辑放 `server/*.ts`;更新 §8 与 CLI |
| 新增权限 / 角色 | `server/auth.ts` 的 `Perm`、`ROLE_PERMS`;路由里用新权限;UI 用 `useApp().can()` |
| 新增存储后端 | `server/storage/index.ts` 增加驱动与 `StorageCode`;`ingest.ts#resolveTarget` 增加选择逻辑 |
| 调整派生图尺寸/质量 | 环境变量 `THUMB_WIDTH/PREVIEW_WIDTH`;质量在 `media/derive.ts#makeDerived` |
| 增加元数据字段 | `media/metadata.ts`(提取)+ `lib/meta-labels.ts`(显示);搜索文本在 `buildSearchText` |
| 支持新的 AI 工具参数格式 | `media/ai.ts#detectAi` |
| 改原文件/视频保护策略 | `server/files.ts#serveMedia` 与 `server/keys.ts` |
| 改可见性规则 | `server/albums.ts`(`effectivelyPublic/visibleIds`)与 `media/service.ts#canSee` |
| 改扫描熔断阈值 / 软删除宽限期 | `SCAN_PRUNE_MAX_RATIO`、`SCAN_PRUNE_MIN_COUNT`;宽限期在 `albums.ts#MISSING_GRACE_MS` |
| 改游客可见元数据 | `GUEST_META` / `GUEST_NOTE`;裁剪逻辑在 `media/service.ts#guestMetaView` |
| 改限流阈值 | 登录:`auth.ts` 的 `FAIL_MAX_IP/FAIL_MAX_USER`;匿名搜索与密钥:`SEARCH_RATE_PER_MIN`、`KEY_RATE_PER_MIN`(`server/rate.ts`) |
| 改令牌有效期 / 强制下线 | `SESSION_DAYS`;强制下线调用 `auth.ts#bumpTokenVersion(userId)` |
| 改挂载目录白名单 / 只读 | `ALLOWED_MOUNT_ROOTS`;`albums.ts#assertMountAllowed`、`pgs_albums.readonly` |
| 新增主题预设 | `lib/theme.ts#PRESETS`(自动出现在设置页) |
| 改启动页 | `components/Splash.tsx`;动画 CSS 在 `app/globals.css`;配置项在 `server/settings.ts`(支持 `title`/`subtitle` 可替换文本与自动字号适配) |
| 改图库布局 | `components/Gallery.tsx#columns`(分列算法,最矮列优先)、`app/globals.css` 的 `.masonry/.mtile`;列数由 `cols` 状态按视口宽度决定 |
| 改上传界面 | `components/UploadDialog.tsx`;服务端 `api/media.ts` + `media/ingest.ts` |
| 改删除行为 / 黑名单 | `server/albums.ts#deleteMediaByIds`、`server/blocklist.ts`、`components/Viewer.tsx#remove`、`components/settings/AdminTabs.tsx#BlocklistTab` |
| 改水印浓淡 | `.env` 的 `HD_WM_OPACITY`(默认 8);合成逻辑在 `server/hd/watermark.ts` |
| 改相册管理页层级显示 | `components/settings/AdminTabs.tsx#AlbumManager`(文件夹式导航) |
| 加数据库字段 | §5 的三步流程 |
| 加通知 / 改通知面板 | 数据 `server/notices.ts`、接口 `server/api/notices.ts`、面板 `components/NoticeBell.tsx`(必须 Portal)、发布页 `components/settings/NoticeTab.tsx` |
| 改 Markdown 渲染 | `lib/markdown.ts`(零依赖,先转义再替换,链接走协议白名单) |
| 改时区默认值 / 选择 | 默认值 `TZ` → `config.defaultTimezone`;设置页写入 `SiteSettings.timezone`;`components/settings/SystemTab.tsx` |
| 改直链上传 | `server/media/fetch-url.ts`(SSRF/重定向/体积);接口 `api/media.ts#/media/upload-url` |
| 改数据库驱动 | `src/db/index.ts`(驱动选择 + `rawQuery` + `nullSafeEq`)、`bootstrap.ts`(两套 DDL);SQL 里禁止 pg 专有语法 |
| 改端口 / 管理员 / 并发 | `.env`,无需改代码 |
| 改 HD 宽度档位 / 令牌 / 流程 | `server/hd/service.ts`(`hdWidths`、`convert`、`serveHd`);前端 `components/useHd.ts` |
| 改 HD 限流 / 封禁规则 | `config.hd.rate`、`server/hd/guard.ts`;安全日志在 `DATA_DIR/logs/security.log` |
| 改 HD 缓存策略 | `server/hd/cache.ts`(基图 + 游客水印成品缓存,版本号在 `service.ts#versionOf`);容量/TTL 用 `HD_CACHE_*` |
| 改队列 / 准入预算 / 内存估算 / 压力保护 | `server/admission.ts`、`server/queue.ts`、`server/pressure.ts`、`media/probe.ts`、`media/estimate.ts`;改动后重跑 `scripts/bench/*` 并对照 §16 |
| 改派生图输入限制 / 质量 | `MEDIA_MAX_INPUT_MP`、`MEDIA_MAX_EST_MB`、`media/derive.ts#makeDerived`;HD 用 `HD_MAX_INPUT_MP`/`HD_QUALITY` |
| 改 `/status` 指标 | `server/metrics.ts`、`server/cgroup.ts`、`server/api/admin.ts#/status`;前端 `components/settings/SystemTab.tsx` |
| 改 PWA / 离线 | `public/sw.js`(`VERSION` 变更才会更新缓存)、`app/manifest.ts`、`app/pwa-icon/[name]/route.ts`、`components/Pwa.tsx` |
| 改 docker 环境变量传递 | `docker-compose.yml` 的 `app.environment`(白名单,见 §10.3)与 `scripts/check-config.mjs`;镜像内环境在 `Dockerfile` |

## 13. 前端约定

- 组件全部 `"use client"`,数据通过 `lib/api.ts` 的 `api<T>()`(自动解包 `{ok,data}` 信封,错误抛 `ApiErr`)。
- 弹窗/确认框统一用 `DialogProvider` 的 `useDialog()`(`choose/confirm/prompt/alert/confirmCheck`),不要用原生 `alert/confirm/prompt`;危险且需显式勾选的操作(如"同时删除源文件")用 `confirmCheck({checkLabel, checkHint, defaultChecked})` → `Promise<{checked}|null>`。
- **位于 `.topbar` / `.dock` / 任何带 `backdrop-filter` 的元素内部的浮层,必须用 `createPortal` 挂到 `document.body`**:带 `backdrop-filter`(或 `filter`/`transform`/`contain`)的祖先会成为 `fixed` 后代的包含块,否则浮层的 `inset-0` 只等于该祖先的尺寸(通知面板曾因此塌成一条细线)。
- 浮层高度用 `flex` 居中 + `padding` 让出顶栏/底部工具栏,内容区用 `min-h-0 flex-1 overflow-y-auto overscroll-contain` 独立滚动;打开时锁 `document.body.style.overflow`。
- 启动页有纯 CSS 兜底动画(`splash-auto-hide`):即使客户端脚本没执行,也会在 `durationMs + 1.2s` 后自动淡出,不会永久挡住整站。

- 根布局注入 `<style id="pgs-theme">`(`themeCss()`),设置页修改主题时直接替换其 `textContent` 实现实时预览;保存后全站生效。CSS 变量:`--bg --bg2 --surface --fg --muted --accent --accent-fg --border`;毛玻璃类 `.glass / .glass-strong`;按钮 `.btn / .btn-primary / .btn-danger`;输入 `.field`。
- 全局事件(`window.dispatchEvent`):`pgs:changed`(媒体变更,图库刷新)、`pgs:albums`(相册变更,相册视图刷新)。
- 高清图查看:`Viewer.tsx` 在 HD 就绪前只显示转圈加载态,不先渲染无水印预览图;HD 响应本身已在服务端合成水印(`x-pgs-wm: 1`),客户端在生成 Blob URL 后先完成 `img.decode()` 异步预解码再挂载舞台,缩放/平移手势期间直接更新 DOM `transform`(`translate3d + scale`)避免逐帧触发 React 重渲染。
- 登录态与权限来自 `AppProvider`(`/auth/me`)。页面是否展示管理控件只做体验层判断,**真正的授权永远在服务端 `route()` 的 access 参数**。
- 图库(`Gallery.tsx`):**固定列数等宽瀑布流 + 二分视口窗口化**(每张图放入当前最矮的列,高度由 `aspect-ratio` 精确计算,宽高比钳制在 0.35~3;按列内单调递增高度通过二分查找只渲染视口 ±1.5 屏内的 Memo 瓦片,上下不可见区域合并为等高透明占位块,使万级图库滚动时 DOM 节点数与图片解码内存近似常数);游标分页每页 80 条,`IntersectionObserver`(`rootMargin` 1200px)触底加载;存在 `pending` 项时每 3 秒请求一次前 80 项并仅在字段变化时刷新状态,最多 40 次(约 2 分钟)后停止。
- 启动页每个标签页会话只显示一次(`sessionStorage["pgs-splash"]`),支持点击「跳过」或按 `Esc`/`Space` 立即关闭;内置模式针对可替换 `title`/`subtitle` 自动计算视觉宽度权重并做逐字 3D 快门翻转揭示、12 层纵深挤出与镜面反射;`url` 模式按扩展名选择 `<img>`/`<video>`/`<iframe sandbox="allow-scripts">`。

## 14. 性能与安全设计要点

- 上传全程流式,不进内存;SHA-256 边写边算;后台派生与交互式 HD 共用单点准入调度器 `Scheduler`(`admission.ts`:类别并发池 `image/heic/video` + 软内存预算 `MEDIA_BUDGET_MB` + 老化防饥饿 + 动态内存压力折扣 `pressure.ts`),解码前先经 `probe.ts` 轻量读文件头做估算与硬上限(`MEDIA_MAX_INPUT_MP`/`MEDIA_MAX_EST_MB`)拦截;`sharp.cache(false)` 避免缓存膨胀;缩略图由预览图再缩小,避免二次解码大图;输入统一加 `limitInputPixels` 与 `sequentialRead` 防解压炸弹。
- EXIF 只读文件头(`EXIF_READ_BYTES`,默认 1MB,读不到再放大到 8MB),不再整文件读入。
- 列表走键集分页 `(sort_at,id)` 与复合索引;相册树、统计与游客可见集合在内存短时缓存,`loadTree/loadStats` 有 in-flight 合并;媒体入库只做 2 秒防抖失效,避免批量上传期间反复全表聚合;搜索走 `pg_trgm` GIN 索引。
- 文件输出与派生/HD 查询均做列投影(不含 `meta`/`search_text`);派生图 `ETag` + `max-age=300`,原文件 `no-store`;所有 S3 访问懒加载 SDK。
- 密码 scrypt;失败路径只跑 1 次 scrypt(时序均衡复用固定哈希);Basic 与登录共用 IP + 用户名双维度限流;下载密钥只存哈希、最小长度 16、校验单条 SQL 完成并通过 `clientIp()` 限流;令牌 HMAC 常量时间比较并携带 `token_version`(改密码即失效);`local` 存储路径防穿越;挂载路径 `realpath` 后比对白名单并检查重叠;自定义图标光栅化重编码、SVG 以 `sandbox` CSP 输出;媒体 `Content-Type` 来自扩展名白名单且附带 `nosniff`。
- 全局安全响应头在 `next.config.ts` 统一注入;`/f/*` 与 `/api/v1/media/*` 带 `X-Robots-Tag: noindex`;`public/robots.txt` 默认 `Disallow: /`;游客元数据按 `GUEST_META` 裁剪(GPS/序列号/作者邮箱/raw 不返回),备注不进公开搜索、`error` 对游客置空。
- 水印在服务端合成进最终 WebP 像素(默认透明度 8%),前端不会先展示无水印大图;游客且域名可信时缓存水印成品(`cache/hd/wm/`),每次请求仍先完整校验令牌、限流与可见性;高清缓存目录不对外暴露;水印层缓存变体上限 24,**FIFO** 淘汰。
- 数据库连接池无条件缓存到 `globalThis` 并监听 `error` 事件(避免空闲连接出错杀死进程),带 `statement_timeout`。
- **内存模型**:进程 RSS 的主要来源是 sharp/libvips 的解码工作集(随输入像素、格式布局、并发数增长),而不是 V8 堆,也不是输出 Buffer;实测数据与推导见 §16。
- 已知边界:播放令牌 + `Sec-Fetch-Dest` 校验只能防"直接下载",无法阻止录屏/抓包;进程内队列、限流与缓存均为单进程内存,**仅支持单实例部署**;`/media/import` 仍是同步长请求。

## 15. 开发与验证

> 全量自动化测试(API / CLI / PostgreSQL+SQLite / local+ext / Docker / 基准)见 `scripts/TESTING.md` 与 `scripts/bench/README.md`;日常只需 `node scripts/test-matrix.mjs --drivers sqlite`。

```bash
npm install
cp .env.example .env            # 填写 DATABASE_URL 等
npm run dev                     # 开发
node scripts/check-config.mjs && node scripts/check-docs.mjs && node scripts/test-unit.mjs
npm run typecheck && npm run lint && npm run build   # 提交前校验(CI 同样执行)
```
CI:`ci.yml`(一致性校验 + 单元测试 + typecheck + lint + build,Node 22);`test.yml`(PostgreSQL 15 + SQLite 全链路,Node 24,素材 8 图 1 视频);`perf.yml`(手动/每周性能与内存回归基准 `--quick --assert`)。

端到端冒烟:启动后依次验证 `POST /albums` → `POST /media/upload` → `GET /media?q=` → `GET /f/:id`(无 key=预览,有 key=原图)→ `POST /keys` → 游客访问私有相册应 404。

## 16. 性能与内存模型(实测基线)

> 本节回答"内存/并发到底由什么决定"。基准套件位于 `scripts/bench/`(详见 `scripts/bench/README.md`),改动队列 / 准入预算 / 估算系数 / 出图流程后请重跑基准并更新本节。

### 16.1 结论摘要

1. **RSS 峰值 ≈ 基线 + Σ(同时在解码的任务的工作集)**。单个任务的工作集由「输入像素数 × 每像素字节 × 格式布局系数」决定,**与输出 Buffer 无关**:preview/thumb 输出均值仅约 176KB / 50KB,把 `toBuffer()` 改成 `toFile()` 仅作为代码卫生,峰值完全相同。
2. **格式布局系数差异巨大**:常规 PNG / TIFF / 基线 JPEG 在 `sequentialRead` 下是流式解码,工作集约 0.7~1.5 字节/像素;**隔行(interlaced)PNG** 与**渐进式(progressive)JPEG** 必须整幅缓冲,约 3.4~3.8 字节/像素;**CMYK** 色彩空间转换最重(可达 15~30 MB/MP)。`sharp().metadata()` 的 `isProgressive` / `space` / `depth` 在解码前由 `probe.ts` 只读文件头(256KB)即可零解码识别。
3. **像素加权单点准入(`admission.ts` + `estimate.ts`)**:仅按"任务个数"限制并发会让 4 个 100MP 隔行 PNG 打出 1430MB 峰值;引入按「格式布局 × 百万像素」估算的软预算(`MEDIA_BUDGET_MB`)与硬限制(`MEDIA_MAX_EST_MB`)后,4×100MP 隔行 PNG 峰值降至约 500MB,而常规小图吞吐不受影响;类别并发池(`image/heic/video`)同时消除了 HEIC 嵌套闸门造成的队首阻塞。
4. **HD 水印合成与游客成品缓存**:水印层通过 raw 画布直裁单次编码 PNG(消除双重 PNG 编解码);未登录游客在可信域名下命中 `cache/hd/wm/` 成品缓存时不再执行 sharp 水印合成,重复打开同一张大图服务端 CPU 与瞬时内存开销接近零。
5. **动态内存压力保护(`pressure.ts`)**:每秒根据容器 cgroup `memory.stat` 的 `anon`(不计可回收文件页缓存)与 `memory.max` 比值调整 `normal / elevated / high / critical` 四级水位,即使估算偏低也能防止容器 OOM kill。

### 16.2 内存来源清单

| 来源 | 量级 | 受什么控制 | 备注 |
|---|---|---|---|
| Next + Node 基线 | 空载 ~250MB | — | 裸 sharp 进程仅 ~61MB |
| libvips 解码工作集(派生图) | 见 §16.3 表 | `Scheduler`(`THUMB_CONCURRENCY` + `MEDIA_BUDGET_MB`)、`MEDIA_MAX_INPUT_MP`、`MEDIA_MAX_EST_MB`、`SHARP_CONCURRENCY` | 受格式布局影响最大 |
| libvips 解码工作集(HD `convert`) | 同上 | `Scheduler`(`withHd` 三路预算分流)、`HD_CONCURRENCY`、`HD_MAX_INPUT_MP` | 转换完成后 `res.adjust(wmEst)` 立即释放解码差额 |
| HD 水印合成 | 每次输出尺寸 W×H×12B 量级 | `Scheduler`(`wmEst`)、`HD_CONCURRENCY`、游客成品缓存 `cache/hd/wm/` | 游客命中成品缓存时为 0 |
| HEIC | 整文件 Buffer + libheif(wasm)RGBA + JPEG 编码 | 类别池 `heic`(`HEIC_CONCURRENCY`,默认 1)+ 高权重估算(`HEIC_COEF`,低置信度自动 ×1.5) | HD 路径有独立 `heicHdGate(1)`,不排在后台批量任务之后 |
| BMP | `ffmpeg` 子进程文件进文件出转临时 PNG(无 `ffmpeg` 回退 `decodeBmp`) | `probe.ts` 读前 26B 头做像素/内存拦截 + `Scheduler` | 有 `ffmpeg` 时不在 Node 堆内整图展开 |
| EXIF 读取 | ≤64MB Buffer(仅 TIFF 的最坏情况) | 随派生并发 | — |
| 视频 | ffmpeg/ffprobe 子进程,不计入 V8 堆 | 类别池 `video`(`VIDEO_CONCURRENCY`,默认 2)+ `VIDEO_COEF` | 子进程 RSS 同样计入容器 cgroup |
| V8 堆 | 通常 <100MB | `NODE_OPTIONS=--max-old-space-size`(compose 默认 1024) | 不约束原生内存;1GB 容器建议调低至 384 |

### 16.3 实测方法与基准套件(`scripts/bench/`)

环境与复现入口见 `scripts/bench/README.md`:
- `node scripts/bench/bench-memory.mjs`:每个场景在独立子进程中运行,取 `/proc/self/status` 的 `VmHWM` 与静置回落 RSS,自动对照 `estimateMemory()` 输出「估算 vs 实测 ΔRSS」偏差表。
- `node scripts/bench/bench-hd.mjs`:黑盒测试 HD 水印冷启动、基图缓存命中、游客水印成品缓存命中、登录用户绕过成品缓存、同图并发 `coalesced` 合并与混合尺寸请求。
- `node scripts/bench/bench-queue.mjs`:黑盒测试大小图混合(1 大图 + 20 小图)、HEIC + JPEG 混合入队(验证分池不队首阻塞、不饿死)。
- `node scripts/bench/bench-scan.mjs`:挂载目录平铺大目录扫描的堆增量与耗时。
- `scripts/bench-docker.sh`:在真实容器镜像(`1g / 2g / 4g` cgroup 档位、jemalloc、非 root)内一键运行上述基准。

合成素材代表性数据(沙箱 4 vCPU / 3.9GB,Node 22,`sharp@0.35.5` / libvips 8.18.7,独立进程基线 61MB):

| 场景 | 输入 | 并发 | 峰值 RSS(MB) |
|---|---|---|---|
| 派生图,`toBuffer` vs `toFile` | 24MP JPEG / 40MP TIFF / 100MP PNG | 1 | **86/86、123/123、135/135(完全相同)** |
| 派生图 | 24MP JPEG | 4 | 158 |
| 派生图 | 48MP 基线 JPEG vs **渐进** JPEG | 1 / 4 | 基线 96 / 195;渐进 235 / **753** |
| 派生图 | 100MP 非隔行 PNG vs **隔行** PNG | 1 / 4 | 非隔行 135 / 355;隔行 405 / **1430** |
| 派生图(**启用像素加权预算**) | 4×100MP 隔行 PNG | 4 | 1434MB → **500MB** |
| 派生图(**启用像素加权预算**) | 1×100MP 隔行 PNG + 20×24MP JPEG | 4 | 549MB·2.5s → **406MB·3.7s** |
| HD `convert` | 100MP 非隔行 PNG vs **隔行** PNG | 1 / 3 | 非隔行 145 / 311;隔行 409 / **1099** |
| HD 水印合成(2560×1707 WebP) | 首次合成 vs 游客成品缓存命中 | 1 / 24 | 未缓存 24 并发 ~931MB;游客成品缓存命中零重合成 |

### 16.4 局限与校准约定

- `estimate.ts` 中标注 `confidence: "low"` 的格式(如真实 iPhone 12MP/48MP HEIC、高位深/特殊色彩空间)已自动乘 `1.5` 保守系数,并在 `/status` 的 `queue.admission.lowConfidenceCount` 中计数;在容器环境使用 `REAL_DIR=/path/to/heic scripts/bench-docker.sh` 实测后可按 `scripts/bench/README.md` 规则更新系数表。
- glibc 默认分配器的内存碎片会导致峰值过后 RSS 不立即回落,生产部署请使用官方 Docker 镜像(内置 `libjemalloc2` 与 `MALLOC_ARENA_MAX=2`)。

### 16.5 运行时观测指标(`GET /api/v1/status`)

`/status` 与设置页「系统状态」面板实时暴露:
- `memory`:`{rss, heapUsed, heapTotal, external, arrayBuffers, maxRss, peak10m:{rss, anon, windowSec}, cgroup:{version, current, max, anon, inactiveFile, workingSet}}`
- `sharp`:`{cache, counters:{queue, process}, concurrency}`
- `eventLoop`:`{p99Ms, maxMs}`(当媒体任务长期显著拖高 `p99Ms` 时,作为未来拆分独立媒体 Worker 子进程的量化依据)
- `queue`:`{concurrency, running, waiting, probing, done, failed, rejected, retrying, byClass:{image,heic,video}, gates:{heic,heic-hd,video,hd}, admission:{usedMB,budgetMB,effectiveBudgetMB,waiting,hdRunning,hdWaiting,exclusive,lowConfidenceCount,agedCount,pressureState}, pressure:{state,ratio,workingSetMB,limitMB,reason,changedAt}}`
- `config.mediaBudget`:自动推导详情(`limitMb, source, baseRssMb, margin, factor, autoBudgetMb`)与当前生效的 `budgetMB / hardMaxMB`。
