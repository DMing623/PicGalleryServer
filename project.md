# PicGalleryServer — 工程说明(面向维护者)

> 读者:第一次接触本项目的专业程序员。读完本文件应当能 **不遍历代码** 就定位到要改的文件、知道对外暴露了哪些接口、各模块的黑盒契约是什么。
> 约定:凡是"改 X 去哪个文件"的问题,先查 §3(目录职责)和 §12(常见改动速查)。
> **校对基线**:本文件已对照代码 `v1.4.3`(提交 `452b181`,2026-11-24)核对。之后的代码变更必须按 §0 同步本文件;发现与代码不符时**以代码为准**并回改文档。
> 配套文件:`todo.md`(性能/内存/可维护性改进计划与评估依据)、`scripts/TESTING.md`(测试套件)、`README.md`(面向使用者的部署说明)。

---

## 0. 文档维护约定与校对基线

**事实以谁为准**(文档与它们冲突时,改文档):

| 事实 | 唯一来源 |
|---|---|
| 环境变量及默认值、取值范围 | `src/server/config.ts`(`.env.example` 是模板,`docker-compose.yml` 另有 `PGS_*` 映射变量) |
| REST 路由、所需权限 | `src/server/api/*.ts` 里的 `route(method, path, access, handler)` |
| 表结构 | `src/db/schema.ts` + `src/db/bootstrap.ts`(两处必须同步) |
| 版本号 | `package.json`(`config.version` 运行时读取它;`package-lock.json`、`cli/pgs.mjs`、`.env.example` 的 `PGS_TAG`、`docker-compose.yml` 默认 tag 需人工同步) |
| 文件清单 | `find src cli scripts .github -type f` |
| 代码里的 `issue §x.y` 注释 | 指向一份**已删除**的外部审查清单,仅作历史标记,不要据此去找文档 |

**改了什么 → 同步哪一节**:

| 代码变更 | 必须同步 |
|---|---|
| 新增/删除源文件 | §3 目录树 |
| 新增/改动环境变量或硬编码阈值 | §10(含"硬编码常量"表)、`.env.example`、必要时 `docker-compose.yml` / README |
| 新增/改动路由、权限 | §8、§4.5、`cli/pgs.mjs`、`scripts/test-*.mjs` |
| 改表结构 | §5、`schema.ts` + `bootstrap.ts` 两处 DDL |
| 改队列 / 并发闸门 / 内存相关逻辑 | §6.11、§7.2、§14、§17(并重跑 §17.3 的方法验证) |
| 改 HD(高清预览)流程 | §6.14、§7.6、§8.11 |
| 发版 | §16 追加一节、版本号五处一致 |

**快速核对命令**(在仓库根目录执行,输出与对应章节对照):

```bash
grep -rn -E '^route\(' src/server/api | sed -E 's/async \(.*//'          # 路由清单 ↔ §8
grep -o -E '"[A-Z][A-Z0-9_]{2,}"' src/server/config.ts | sort -u          # 环境变量 ↔ §10
grep -rn "globalThis as" src --include=*.ts                               # 进程内状态 ↔ §2.1
find src cli scripts .github -type f | sort                               # 文件清单 ↔ §3
```

**最近一次全量核对发现并已修正的偏差**(留作类似问题的检查线索):`THUMB_CONCURRENCY` 默认值写成 15(实为 `min(4, CPU)`);目录树缺 `server/hd/*`、`notices`、`bmp`、`corrupt`、`fetch-url`、PWA 相关文件;HD 接口与 `HD_*` 环境变量未成体系;图库描述为"等高行 + `content-visibility`"(实为固定列瀑布流,代码里没有 `content-visibility`);"分池限流"实为嵌套闸门;水印层缓存写成 LRU(实为 FIFO);§12 有 5 行重复。README 里仍有 1 处未修(见 `todo.md` 的 D-1)。

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
| `__pgsQueue` | `server/queue.ts` | 待处理 id 数组+游标、运行中集合、重试计数、`dirty` 集合、统计 | 重启后 `ensureReady()` 把 `status='pending'` 的**最近 20000 条**重新入队;`failed` 不自动重试;多实例会重复处理 |
| `__pgsHd` | `server/hd/cache.ts` | HD 缓存索引(含 LRU 时间)、失效代数 `gen`、统计 | 首次访问时重扫缓存目录重建;多实例会各自淘汰、容量记账不一致 |
| `__pgsGuard` | `server/hd/guard.ts` | HD 限流窗口、批量访问检测、封禁表、最近 300 条安全事件 | 重启即清零(封禁解除);`logs/security.log` 落盘保留 |
| `__pgsRate` | `server/rate.ts` | 匿名搜索 / 无效密钥限流计数 | 清零 |
| `__pgsScan` / `__pgsScanLocks` | `server/albums.ts` | 扫描状态、同目录并发扫描锁 | 状态丢失;多实例可同时扫同一目录 |
| `__pgsReady` | `server/ready.ts` | 初始化 Promise | — |
| `__pgsDb` / `__pgsPool` / `__pgsSqlite` | `db/index.ts`、`db/bootstrap.ts` | drizzle 实例、pg 连接池、SQLite 句柄 | — |
| 模块级 Map/Set | `albums.ts`(树缓存、统计缓存、`moveLocks`)、`blocklist.ts`(外部键缓存)、`auth.ts`(Basic/用户缓存、登录失败计数)、`media/ingest.ts`(`withHashLock`)、`media/derive.ts`(`localHints`、`heicGate`、`videoGate`)、`hd/service.ts`(`inflight`、`gate`)、`hd/watermark.ts`(`layerCache`) | 见各节 | 全部随进程丢失 |

## 3. 目录与文件职责

```
.
├─ project.md / todo.md / README.md   本文件(给开发者) / 改进计划 / 用户说明(功能与部署)
├─ LICENSE NOTICE                     PolyForm Noncommercial 1.0.0 与署名要求
├─ .env.example                       完整环境变量模板(含 PGS_* 容器映射变量);运行时读 .env
├─ Dockerfile docker-compose.yml      容器化:node:24-bookworm-slim + ffmpeg/tini/jemalloc/tzdata;
│                                     ENV: UV_THREADPOOL_SIZE=12 MALLOC_ARENA_MAX=2 TZ=Asia/Shanghai;
│                                     入口脚本 pgs-entrypoint 加载 jemalloc、修正数据目录属主后 setpriv 降权到 uid 1000
├─ next.config.ts                     serverExternalPackages(sharp/exifr/heic-convert/busboy/aws-sdk) + 全局安全头 + HD 响应禁缓存头 + allowedDevOrigins
├─ drizzle.config.json                drizzle-kit 配置(仅开发期 push/export)
├─ eslint.config.mjs  tsconfig.json  postcss.config.mjs
├─ .github/workflows/
│    ci.yml                           typecheck + lint + build(Node 22)
│    test.yml                         PostgreSQL 15 服务容器 + SQLite 全链路(scripts/test-matrix.mjs,Node 24)
│    docker-publish.yml               多架构镜像构建推送 GHCR
│    cleanup-image-versions.yml       清理旧镜像版本(调用 scripts/cleanup-image-versions.py)
├─ public/                            robots.txt(Disallow: /)、sw.js(Service Worker,仅缓存静态外壳,绝不缓存 /api/ 与 /f/)、offline.html
├─ cli/pgs.mjs                        命令行管理工具(零依赖,util.parseArgs,调用 REST API)
├─ scripts/                           测试与运维脚本(详见 scripts/TESTING.md,本文件不展开):
│    fetch-samples.mjs  lib/harness.mjs  test-e2e.mjs  test-cli.mjs  test-hd.mjs  test-matrix.mjs
│    test-docker.sh  instabox-test.sh  cleanup-image-versions.py  TESTING.md
├─ data/                              运行时数据目录(DATA_DIR,默认 ./data,git 忽略)
│   ├─ albums/<albumCode>/            受管相册(local 存储)的原文件;albums/_inbox/ 为未归类收件箱
│   ├─ derived/<id前2位>/<id>.thumb.webp|.preview.webp   永久派生图
│   ├─ cache/hd/<id前2位>/<id>.<ver12>.<宽>.webp          HD 临时缓存(LRU+TTL,可随时删除)
│   ├─ branding/icon                  自定义站点图标
│   ├─ logs/security.log(.1)          HD 安全事件(JSON Lines,>5MB 轮转一次)
│   ├─ tmp/                           上传/导入/私有副本/视频抽帧临时文件(启动时全清,之后每小时清 6h 前遗留)
│   ├─ secret.key                     自动生成的会话签名密钥(0600)
│   └─ pgs.sqlite                     SQLite 模式的数据文件(DB_DRIVER=sqlite)
└─ src/
   ├─ instrumentation.ts              服务启动钩子:nodejs 运行时触发 ensureReady()
   ├─ db/
   │   ├─ index.ts                    双驱动:pg Pool + drizzle/node-postgres,或 node:sqlite + drizzle/sqlite-proxy;导出 db、pool、dbKind、rawQuery、nullSafeEq、pingDb、closeDb(本文件直接读 DATABASE_URL,是 config.ts 之外唯一读 env 的业务文件)
   │   ├─ schema.ts                   表结构定义(8 张表,见 §5)
   │   └─ bootstrap.ts                幂等建表 DDL(pg 带 advisory lock 7351001;sqlite/pg 两套)。改 schema 必须同步改这里
   ├─ lib/                            前后端共用的纯函数(无 IO)
   │   ├─ theme.ts                    主题预设 PRESETS、themeCss()、DEFAULT_THEME
   │   ├─ api.ts                      浏览器 fetch 封装:api<T>() 自动解包信封,错误抛 ApiErr
   │   ├─ format.ts                   bytes/duration/dateTime/dayLabel 格式化
   │   ├─ markdown.ts                 零依赖 Markdown 渲染(先整体 HTML 转义再替换,链接协议白名单)
   │   └─ meta-labels.ts              元数据字段中文标签表(决定 UI 显示哪些字段)
   ├─ server/                         **全部服务端逻辑**(详见 §6)
   │   ├─ config.ts                   环境变量解析入口,导出 config 与 dirs(含 config.hd.*)
   │   ├─ secret.ts                   SESSION_SECRET 解析:env → DATA_DIR/secret.key → 生产自动生成 → 开发期由管理员密码派生
   │   ├─ rate.ts                     通用内存限流(匿名搜索、无效密钥校验):hit / count / overLimit
   │   ├─ http.ts                     ApiError / E 工厂 / json / ok / fail / readJson(带体积上限) / str / intParam / boolParam
   │   ├─ router.ts                   迷你路由器:route(method, pattern, access, handler)、dispatch()、clientIp()
   │   ├─ auth.ts                     角色权限矩阵、密码哈希、令牌(会话/播放/HD 共用 signToken)、请求鉴权、env 管理员同步、登录限流
   │   ├─ settings.ts                 站点设置(单 JSON,key="site")读写与校验、publicSite()、isValidTimezone()
   │   ├─ ready.ts                    ensureReady():建表→建目录→同步管理员→恢复队列→定时器
   │   ├─ albums.ts                   相册树缓存、可见性、统计、创建/挂载/改/删、目录扫描、文件搬迁(1100+ 行,最大的单文件)
   │   ├─ blocklist.ts                删除黑名单:写入/列出/解除(恢复记录+重生成派生图)/彻底删除
   │   ├─ keys.ts                     下载密钥:创建(upsert)/列表/删除/验证/过期清理
   │   ├─ notices.ts                  站点通知:列表/未读/发布/编辑/删除/已读
   │   ├─ files.ts                    serveMedia():thumb/preview/file/stream 的授权与输出(Range/ETag)
   │   ├─ queue.ts                    进程内任务队列(并发=THUMB_CONCURRENCY,重试 3 次指数退避)+ limiter()
   │   ├─ storage/index.ts            存储驱动抽象:local / ext / s3,materialize()
   │   ├─ hd/                         高清预览(HD)子系统(§6.14)
   │   │   ├─ service.ts              令牌签发/校验 → 权限 → 缓存/按需转换 → 水印 → 输出
   │   │   ├─ cache.ts                磁盘缓存(LRU+TTL+版本号)、失效代数、统计
   │   │   ├─ watermark.ts            水印层生成(平铺旋转文字)、合成、用户动态标识 U-XXXXXX
   │   │   └─ guard.ts                HD 专用限流 / 批量访问检测 / 封禁 / 安全日志
   │   ├─ media/
   │   │   ├─ types.ts                扩展名→kind/mime、isHeic、safeName、randomId
   │   │   ├─ upload.ts               parseUpload():busboy 流式 multipart → 临时文件 + sha256
   │   │   ├─ fetch-url.ts            直链上传:SSRF 校验、重定向、体积/超时限制
   │   │   ├─ ingest.ts               resolveTarget()、ingestOne()(含 withHashLock)、collectFiles()/copyToTmp()
   │   │   ├─ derive.ts               processMedia():派生图 + 元数据入库;derivedPath/removeDerived/heicToJpeg;heicGate/videoGate
   │   │   ├─ bmp.ts                  BMP 解码器(整文件读入 → RGBA Buffer)
   │   │   ├─ metadata.ts             extractImageMeta()、probeVideo()、grabVideoFrame()、buildSearchText()
   │   │   ├─ png.ts                  PNG 文本块读取、隐写(alpha LSB,≤16MP)提取
   │   │   ├─ ai.ts                   AI 生成参数解析(A1111/NovelAI/ComfyUI/InvokeAI)
   │   │   ├─ corrupt.ts              疑似损坏文件(failed)汇总与自动清理
   │   │   └─ service.ts              listMedia()、mediaDetail()、updateMedia()、batchAction()、可见性判断
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
   │   ├─ globals.css                 CSS 变量兜底、毛玻璃(.glass)、按钮/输入样式、瀑布流(.masonry)、启动页 3D 动画、通知面板
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
       ├─ AppProvider.tsx             上下文:me(user/perms/site/features)、can(perm)、reload()
       ├─ Splash.tsx                  启动页:粒子 canvas + 3D 光环 + 3D 挤出文字;url 模式支持图片/视频/iframe
       ├─ Shell.tsx                   毛玻璃顶栏、导航、搜索框(相册页自动限定范围)、上传入口、账户菜单、底部工具栏
       ├─ Gallery.tsx                 固定列等宽瀑布流(最矮列优先)、游标无限滚动(每页 80)、处理中轮询;导出 MediaItem
       ├─ Viewer.tsx                  全屏查看器:HD 图(加载中转圈→带水印大图)、文件链接、备注编辑、元数据侧栏、删除/重处理
       ├─ useHd.ts                    HD 加载 hook:申请令牌→取图→Blob URL;只保留当前±1 张,预加载相邻 2 张
       ├─ DialogProvider.tsx          内置对话框:choose/confirm/prompt/alert/confirmCheck
       ├─ MetaPanel.tsx               元数据渲染(固定字段缺失显示 N/A、AI 区块、原始段折叠)
       ├─ UploadDialog.tsx            上传对话框:相册下拉、存储选择、并发、进度、结果去向提示、只读挂载禁用
       ├─ AlbumsView.tsx              相册列表/详情页的客户端主体、相册卡片
       ├─ AlbumActions.tsx            相册操作按钮组(新建/重命名/公开私有/只读切换/重扫/删除),导出 AlbumDto
       ├─ NoticeBell.tsx              顶栏通知铃铛 + 覆盖式面板(必须 Portal 到 body)
       ├─ Markdown.tsx                dangerouslySetInnerHTML 承载 lib/markdown.ts 的输出
       ├─ Disclaimer.tsx              免责声明弹窗(需滚动到底并等待 6 秒;localStorage 记 30 天;layout 内联脚本先行判断)
       ├─ Pwa.tsx                     注册 Service Worker(仅生产)与"安装到主屏幕"事件
       ├─ DevI18n.tsx                 仅 `next dev` 生效:Next 开发悬浮球汉化(生产不渲染)
       ├─ LoginForm.tsx               登录表单
       └─ settings/
           ├─ SettingsView.tsx        设置页标签容器(按权限显示标签)
           ├─ AppearanceTab.tsx       站点名/图标上传/主题/明暗/启动页/游客开关,主题实时预览
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

**pgs_media**:`id`(12 位随机,PK) `album_id`(null=未归类) `kind`(`image|video`) `filename` `mime` `size` `mtime_ms`(源文件修改时间,变更检测/重命名配对) `width` `height` `duration`(秒) `taken_at` `sort_at`(= taken_at ?? 文件时间/上传时间,排序与游标依据) `storage` `storage_key` `hash`(SHA-256,上传才有) `color`(平均色,占位用) `status`(`pending|ready|failed`) `error` `note`(管理员备注,**不进 search_text**) `meta`(jsonb,见 §7.3) `search_text` `missing_at`(软删除标记) `uploaded_by` `created_at`;索引:`(sort_at,id)`、`(album_id,sort_at,id)`、`(storage,storage_key)` 唯一、`hash`、`status`、`missing_at`、`search_text` 的 GIN(trigram)、`status <> 'ready'` 部分索引。

**pgs_blocklist**(删除黑名单):`id`(PK) `media_id`(原记录 id,仅追溯) `album_id` `album_code` `kind` `filename` `mime` `size` `storage` `storage_key` `hash` `taken_at` `sort_at` `meta` `note` `created_by` `created_at`;唯一索引 `(storage,storage_key)`、普通索引 `album_id`。记录"被排除但源文件仍在"的文件;扫描时按 `(ext, 绝对路径)` 跳过。

**pgs_download_keys**:`id` `key_hash`(SHA-256,唯一) `hint`(前 2 位 + `*`) `label` `expires_at`(null=永不) `created_by` `created_at` `last_used_at` `use_count`。

**pgs_settings**:`key`(PK) `value`(jsonb) `updated_at`。目前只有 `key="site"`,内容为 `SiteSettings`(见 `server/settings.ts`):`siteName, theme{preset,mode,accent,background}, splash{enabled,mode,url,durationMs,title}, iconVersion, iconMime, guestBrowse, timezone`。

**pgs_notices**(站点通知,v1.4.0):`id`(PK) `title` `body`(Markdown 原文) `pinned` `created_by` `created_by_name`(用户名快照) `created_at` `updated_at`;索引 `created_at`。发布需要 `notice.publish`(admin / manager)。

**pgs_notice_reads**(通知已读,v1.4.0):`user_id` + `notice_id` 复合主键 `read_at`;索引 `user_id`。存在即已读,「一键已读」= 批量插入缺失行。游客没有账户,其已读状态保存在浏览器 localStorage。

> 修改表结构:① 改 `schema.ts` ② 同步改 `bootstrap.ts` 的 DDL(`npx drizzle-kit export --sql` 可对照)③ 开发库可 `npx drizzle-kit push`。已发布版本的字段变更需在 `bootstrap.ts` 追加 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`。

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
- `derive.ts`:导出 `processMedia(id)`(队列 runner,流程见 §7.2)、`derivedPath(id, 'thumb'|'preview')`、`removeDerived(id)`(同时 `invalidateHd`)、`hintLocalCopy(id, file)` / `dropLocalHint(id)`(S3 上传时保留本地副本,处理后删除)、`heicToJpeg(file): Promise<Buffer>`(HD 也调用)。模块加载时设置 `sharp.cache(false)` 与 `sharp.concurrency(2)`(**全进程生效**);内部有 `heicGate`(`HEIC_CONCURRENCY`)与 `videoGate`(`VIDEO_CONCURRENCY`)两个 `limiter`。
- `bmp.ts`:`isBmp(filename)`、`decodeBmp(buf)` → `{data: RGBA Buffer, width, height}`;支持 BI_RGB 1/4/8/16/24/32 位与 BI_BITFIELDS 16/32 位,不支持 RLE(抛错 → 记录 `failed`)。调用方 `derive.ts#bmpToPng` 整文件 `readFile` 后解码,再经 sharp raw 输入编成 PNG Buffer。
- `corrupt.ts`:见 §6.13。`fetch-url.ts`:见 §8.4 的 `/media/upload-url`。
- `metadata.ts`、`png.ts`、`ai.ts`:见 §7.3。
- `service.ts`:`listMedia`(游标分页、可见性、范围、搜索)、`getVisible`、`canSee`、`mediaDetail`、`updateMedia`、`batchAction`、`reprocessFailed`、`baseUrl`。

### 6.9 `keys.ts`
`createKey({key?,label?,expires:'never'|'24h'|'custom',ttlHours?,createdBy})`(相同密钥重复提交 = 更新标签与有效期)、`listKeys`、`deleteKeyById`、`deleteKeyByValue`、`verifyKey(key, countUse)`(过期即惰性删除)、`purgeExpiredKeys()`(每小时定时)。明文密钥只在创建响应里出现一次。

### 6.10 `files.ts`
`serveMedia(req, id, variant, user)`,`variant ∈ thumb|preview|file|stream`,实现 §4.3 的授权表;派生图带 `ETag` 与 `Cache-Control`(游客可公共缓存,登录态 private);派生图未生成时返回占位 SVG(`x-pgs-state: processing`,不缓存);原文件支持 `Range`(206/416)与 `Content-Disposition`(`dl=1` 为 attachment)。

### 6.11 `queue.ts` 与 `ready.ts`

**队列(`queue.ts`,状态在 `globalThis.__pgsQueue`)**
- `enqueue(id, priority?)`:同 id 去重(`queued` 集合);`priority=true` 插到队首。若该 id **正在运行**,只登记进 `dirty`,运行结束后补跑一次(处理期间源文件又变化/用户要求重处理不会丢)。
- **并发模型**:全局只有**一个**队列和 `THUMB_CONCURRENCY` 个槽位(默认 `min(4, CPU 核数)`,范围 1-128)。图片、视频、HEIC **共用这些槽位**,`pump()` 只看 `running < thumbConcurrency`。
- **二级闸门是嵌套的**:`derive.ts` 里的 `videoGate`(`VIDEO_CONCURRENCY`,默认 2,只包 ffprobe 与 ffmpeg 抽帧)和 `heicGate`(`HEIC_CONCURRENCY`,默认 1,包 HEIC 转 JPEG,**HD 转换也共用它**)是任务**已占用槽位之后**才排队的 `limiter`。后果:批量导入 HEIC 时,多个槽位被"占着等闸门",真正在解码的只有 1 个,同时其它 JPEG 拿不到槽位(队首阻塞,见 `todo.md` P1-3)。
- 失败重试:runner 抛错后最多重试 3 次(`MAX_ATTEMPTS`),间隔 1s / 4s / 16s(`setTimeout(...).unref()`);超过后计入 `failed`(记录的 `status='failed'` 由 `processMedia` 自己写库,队列只管计数)。重试期间 `queued` 中已无该 id,可被新的 `enqueue` 插入。
- `queueStats()` → `{concurrency, running, waiting, done, failed, retrying}`;`idle(timeoutMs)`(整队列排空);`idleIds(ids, timeoutMs)`(上传接口 `wait=1` 只等本次文件,200ms 轮询);`limiter(n)`(通用小闸门,FIFO,`derive.ts`/`hd/service.ts`/上传并发都用它)。
- `waiting` 是 id 字符串数组 + 游标 `head`(避免 `shift()` O(n)),游标超过 4096 且过半时压缩;队列只存 id,不存任务体,内存占用与待处理数量成线性、很小。

**初始化(`ready.ts`)**
- `ensureReady()` 进程内只执行一次(失败会重试;`instrumentation.ts` 与每个 API 请求都会 await 它):`assertSecureConfig`(生产环境拒绝占位管理员密码)→ `runBootstrap` → 创建 `dirs` 全部目录 → `syncEnvAdmin` → `setRunner(processMedia)` → 把 `status='pending'` 的记录按 `created_at` 倒序**最多 20000 条**重新入队(超出只打警告)→ 启动定时器。
- 定时器:每小时 `purgeExpiredKeys` + `cleanTmp`(清 6 小时前遗留)+ `sweepHdCache`;启动时额外 `cleanTmp(0)`(全清)、`sweepHdCache`、`startCorruptSweeper`(10 分钟一次);`SCAN_INTERVAL_MIN>0` 时按间隔 `scanAllMounted()`。所有定时器 `unref()`。

### 6.12 `blocklist.ts`
- `blockedExtKeys()`:黑名单中 `storage='ext'` 的绝对路径集合(5 秒内存缓存,`invalidateBlocklist()` 失效),扫描时用于跳过。
- `addToBlocklist(rows, user)`:把即将删除的 `pgs_media` 行写入黑名单(同 `(storage,key)` 已存在则忽略),并冗余保存相册代码。
- `listBlocklist()`:按创建时间倒序返回,`leftJoin pgs_albums` 带出当前相册名。
- `unblock(id)`:校验源文件仍存在 → 重新插入 `pgs_media`(`status=pending`,沿用原相册/备注/元数据)→ 删除黑名单行 → `enqueue(id, true)` 重新生成缩略图;源文件缺失抛 `source_missing`,已存在同路径记录抛 409。
- `purgeBlocked(id)`:物理删除源文件并移除黑名单行。
- 刻意不 import `albums.ts`(避免与 `albums.ts → blocklist.ts` 形成循环依赖)。

### 6.13 `media/corrupt.ts`(疑似损坏文件)
- `noteUploadActivity()`:每次入库(含失败)调用,重置自动清理倒计时。
- `corruptSummary(limit)`:返回 `{count, items[≤limit], autoPurgeHours, purgeInSec}`;`items` 只含 `id/filename/kind/size/error/createdAt`。
- `purgeCorrupt(ids?)`:ids 为空 = 全部 `status='failed'`。受管存储(local/s3)连源文件删除;挂载目录(ext)只删登记,不动用户文件。
- `startCorruptSweeper()`:每 10 分钟检查,若「距上次上传 ≥ `CORRUPT_AUTO_PURGE_HOURS`」则自动清理;`0` 关闭。进程启动时 `lastUploadAt = now`,不会一上线就清。
- 图库默认不展示 failed 记录(`listMedia` 的 `includeFailed` 默认 false),避免损坏文件干扰浏览。

### 6.14 `hd/*`(高清预览,v1.1.0 引入)

对外入口(`server/api/hd.ts` 调用):`requestHdToken(req,id,user,ip,w)`、`serveHd(req,id,user,ip)`、`recentSecurityEvents(limit)`、`userMarkCode(userId)`;`hdCacheInfo()` 由 `/status` 使用。

- `service.ts`
  - **宽度档位**:`hdWidths()` = `[1280,1600,1920,2560,3840]` 中小于 `HD_WIDTH` 的项加上 `HD_WIDTH`;`snapWidth(raw)` 吸附到不小于请求值的最小档(缺省取最大档),目的是提高缓存命中。
  - **令牌**:payload `{m:媒体id, s:"hd", u:用户id|null, w:宽度, exp}`,由 `auth.signToken` 签发,TTL `HD_TOKEN_TTL_SEC`(默认 90s);`checkHdToken` 校验 scope / 媒体 / 用户绑定。**HD 不接受下载密钥**,不返回原文件,不暴露存储路径。
  - **`serveHd` 流程**:① 验令牌(失败 → `hdStrike` + 403 `hd_token_invalid`)→ ② `guardHd(...,'serve')` 限流与异常检测 → ③ `loadVisibleImage`(**整行 select**,每次请求都重新校验可见性,缓存命中同样)→ ④ `snapWidth` + `versionOf(row)` = `sha1(hash|size|stat.size|mtime)` 前 12 位(原文件不存在 → `invalidateHd` + 404)→ ⑤ `getBase`:命中 → `readFile` 成 Buffer;未命中 → 经 `gate`(`HD_CONCURRENCY`)调 `convert`,同一 `(id,ver,宽)` 的并发请求合并成同一个 Promise(`inflight`,统计 `coalesced`),结果 `putCached` → ⑥ `HD_WM_ENABLED` 时**每次请求**再经**同一个 `gate`** 调 `applyWatermark(buf,{host,userId})`,**结果不缓存**(因为含请求 host 与用户标识)→ ⑦ 返回 `Response(Buffer)`,头含 `cache-control: private, no-store, max-age=0`、`x-pgs-cache: hit|miss|coalesced`、`x-pgs-wm`、`x-pgs-hd-width`。
  - **`convert`**:`materialize` 原文件 → HEIC 先 `heicToJpeg`(共用 `heicGate`)→ `sharp(input,{failOn:"none", limitInputPixels: HD_MAX_INPUT_MP*1e6}).rotate().resize({width, height: HD_MAX_HEIGHT, fit:"inside", withoutEnlargement:true}).webp({quality: HD_QUALITY}).toBuffer()`。**未设 `sequentialRead`**;视频不支持(400)。
  - **闸门**:`gate = limiter(HD_CONCURRENCY)`(默认 3)被 `convert` 与 `applyWatermark` 共用;它与后台派生队列(`THUMB_CONCURRENCY`)**互相不感知**,两者可同时满载。缓存命中时的 `readFile` 和 `loadVisibleImage` 不受 `gate` 约束。
- `cache.ts`:文件 `cache/hd/<id前2位>/<id>.<ver12>.<宽>.webp`,保存的是**无水印**基图;内存索引首次使用时扫目录重建;`putCached` 先写 `.tmp` 再 rename,并先删同 id 的旧版本;`evict()` 按 `lastAccess` LRU 淘汰到 ≤ `HD_CACHE_MAX_MB`;读时超过 `HD_CACHE_TTL_DAYS` 即删;`invalidateHd(id)` 自增失效代数 `gen` 并删文件,在途转换因代数不符丢弃结果;`sweepHdCache()` 启动与每小时执行(过期 / 超量 / 超过 1 小时的 `.tmp`)。`HD_CACHE_MAX_MB` 只约束**磁盘**,不约束请求时的内存。
- `watermark.ts`:`applyWatermark(webp,{host,userId})` → `metadata()` 取 W×H → `layerFor(...)` → `sharp(webp).composite([layer]).webp({quality: min(95, HD_QUALITY+3)}).toBuffer()`。水印层 = pango 渲染文字(DejaVu Sans,白字 + 1px 黑投影双层,透明度 `HD_WM_OPACITY`%)→ 旋转 `HD_WM_ANGLE` → 按 `HD_WM_DENSITY` 交错平铺到 `(W+2·pad)×(H+2·pad)` 的 RGBA 画布 → 裁回 W×H 的 PNG。奇数行用 `userMarkCode(userId)`(`U-` + HMAC(sessionSecret,`wm|<id>`) 前 6 位)交替站点文字。`layerFor` 以参数为键缓存 Promise(≤24 个,**FIFO** 淘汰,命中不刷新顺序)。字体缺失直接抛错,**不会退回无水印图**。
- `guard.ts`:1 分钟滑动窗口限流(令牌 `HD_RATE_TOKEN_PER_MIN`=60;取图 IP 30 / 用户 40 / 媒体 120);批量访问检测:`HD_SCAN_WINDOW_SEC`(300s)内同一 IP 访问不同图片数 > `HD_SCAN_DISTINCT`(150)→ 封禁 `HD_SCAN_BLOCK_SEC`(300s);`hdStrike`(无效/跨媒体/越权令牌)1 分钟累计 20 次 → 封禁。事件写内存(最近 300 条)与 `logs/security.log`;同源同事件 10 秒只记一条。超限统一 429 + `retry-after`。

### 6.15 其余服务端文件速览

- `db/index.ts`:`DB_DRIVER` 选驱动;导出 `db`(drizzle,类型按 pg 声明)、`pool`(仅 pg)、`dbKind`、`rawQuery(sql)`(两驱动都返回 `{rows}`)、`nullSafeEq(col,val)`(pg 用 `IS NOT DISTINCT FROM`,sqlite 用 `IS`)、`pingDb()`、`closeDb()`。连接池/SQLite 句柄缓存在 `globalThis`;pg 池监听 `error`。
- `db/bootstrap.ts`:`runBootstrap()` 幂等建表/索引(pg 在 `pg_advisory_lock(7351001)` 下执行并尝试 `CREATE EXTENSION pg_trgm`,失败只告警);SQLite 模式注册 `now()` / `gen_random_uuid()`。
- `secret.ts`:`resolveSessionSecret()`(同步读取,因为 `config` 是模块级常量)、`isPlaceholderSecret()`。
- `rate.ts`:`hit(key, perMinute, message?)`(记一次,超限抛 429)、`count(key)`(只记)、`overLimit(key, perMinute)`(只查);1 分钟滑动窗口,最多 20000 个键(超出淘汰最早)。
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
后台: processMedia(id) → 生成派生图 + 元数据 → status=ready
```
上传的文件落在哪:响应 `target` 明确给出相册与存储;前端上传对话框在选择相册时显示"将保存到"的路径,完成后提示"已上传到「相册名」"并提供跳转。未选择相册 → "未归类(收件箱)",登录用户在「全部」与「相册 → 未归类」中可见。全部文件失败时响应为 `ok:false` + HTTP 422。

### 7.2 派生图(`media/derive.ts#processMedia`)

入口是队列 runner。先 `invalidateHd(id)`(原文件可能已变);记录不存在则清理本地副本提示后返回。

1. **取得本地路径**:`localHints`(上传到 S3 时保留的本地副本)→ 否则 `materialize()`(local/ext 直接返回路径,S3 下载到 `tmp/`)。`finally` 里必定 `cleanup()`。
2. **图片**
   - ext(挂载目录)的图片(HEIC/BMP 除外)先 `copyFile(..., COPYFILE_FICLONE)` 成 `tmp/src-*` **私有副本**再交给 sharp:外部程序在 libvips `mmap` 期间截断/覆盖源文件会让整个 Node 进程 `SIGBUS` 崩溃。
   - **输入**:HEIC → `heicToJpeg()`(`heicGate` 限流;整文件 `readFile` → `heic-convert`(quality 0.92)→ JPEG **Buffer**);BMP → `bmpToPng()`(整文件 `readFile` → `decodeBmp` RGBA Buffer → sharp raw → PNG **Buffer**);其它 → 文件路径(或私有副本)。
   - `sharp(input, INPUT_OPTS).metadata()` 读尺寸/方向/色彩空间/位深(只读头部,廉价);EXIF 方向 5–8 时宽高互换后入库。
   - `makeDerived(id, input)`:`rotate()` → `resize(PREVIEW_WIDTH 方框, fit inside, withoutEnlargement)` → `webp q84` → `toBuffer()` 得 **preview**;再以 **preview Buffer** 为输入缩到 `THUMB_WIDTH × THUMB_WIDTH*2`(inside)→ `webp q84` 得 **thumb**;thumb 缩成 1×1 取平均色 `#rrggbb`。两个 Buffer 经 `writeAtomic()`(同目录 tmp + rename)写入 `derived/`。不调用 `keepMetadata`,输出不含 EXIF/XMP/ICC。
   - `INPUT_OPTS = {failOn:"none", limitInputPixels:268_000_000, sequentialRead:true}`,**硬编码**(§10.2)。注意 `metadata()` 与 `makeDerived` 是对同一输入的两次独立打开。
   - `extractImageMeta(file, facts, tz)` 另行读取**原文件头部**(`EXIF_READ_BYTES`,读不到再放大到 8MB;TIFF 逐级放大到 64MB),与出图互不共享;PNG 另读文本块;带 alpha 且 ≤16MP 的 PNG 再用 sharp 全解码一次 alpha 通道找 NovelAI 隐写。
3. **视频**:`videoGate(probeVideo)`(ffprobe;宽/高/时长全空 → 抛错 → `failed`)→ 候选时间点 `[min(1, 时长/2), 0, 时长25%, 时长75%]`(后两个仅时长 >4s)依次 `videoGate(grabVideoFrame)` 抽帧到 `tmp/frame-*.png`(ffmpeg `scale=min(PREVIEW_WIDTH,1600):-2`,单线程,60s 超时),`isBlankFrame()`(64×64 缩略图的标准差/均值)判纯色则换点重试;全失败或无 ffmpeg → SVG 占位图 → 同一个 `makeDerived`。
4. **写回**:宽/高/时长;拍摄时间在 `1990 ≤ 年份` 且 `≤ 明天` 时写 `taken_at` 与 `sort_at`;`color`、`meta`、`search_text`、`status='ready'`、`error=null`。任何异常 → `status='failed'` + `error`(≤500 字)→ 重新抛出,由队列按 §6.11 重试。

> 内存/并发特性(哪些输入格式最耗内存、闸门如何叠加)见 §17。

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
  GET /media/:id/hd?t=<token>&w=<档位>    → serveHd()  (见 §6.14 的 ①~⑦)
        命中: readFile(cache) ─┐
        未命中: gate → convert(原图→WebP) → putCached(无水印基图) ─┤
                                              gate → applyWatermark(每次请求) → Response(no-store)
  浏览器: res.blob() → URL.createObjectURL;只保留当前 ±1 张,切换即 revoke;当前图就绪 250ms 后预加载相邻 2 张
```
- 缓存的是无水印基图;水印每次请求合成(host、登录用户标识不同,不能共享)。因此**同一张图再次打开仍要付出一次 WebP 解码 + 合成 + 编码**,`no-store` 也让浏览器不会复用。
- 失效:`processMedia` 开头、`removeDerived`、文件被删/不存在、`versionOf` 变化(大小/mtime/hash 任一改变)。
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
| PUT `/settings` | settings | body 补丁:`siteName`、`guestBrowse`、`theme{preset,mode(light\|dark\|auto),accent,background}`、`splash{enabled,mode(builtin\|url),url(https),durationMs,title}`、`timezone`(IANA,经 `Intl` 校验) | 返回合并后的设置(附 `can`)。预设:`claude ocean forest rose violet mono` |
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
| GET `/status` | status | 版本、运行时长、计数、队列、`hd` 缓存统计、工具可用性、内存(**仅 `{rss, heapUsed}`**)、磁盘、关键配置(结果缓存 5 秒;ffmpeg 探测缓存 60 秒) |
| GET `/status/queue` | status | `{concurrency,running,waiting,done,failed,retrying}` |
| GET `/status/corrupt` | status | 疑似损坏文件:`{count, items[≤20], autoPurgeHours, purgeInSec}` |
| POST `/status/corrupt/purge` | media.delete | 清理疑似损坏文件,body `{ids?}`(空 = 全部);受管存储连源文件删除,挂载目录只删登记 |

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
| GET `/media/:id/hd` | public | `t`(令牌,必填)、`w` | 带水印的 `image/webp`;令牌无效/过期/跨媒体 → 403 `hd_token_invalid`;`cache-control: private, no-store`;头 `x-pgs-cache`(`hit` / `miss` / `coalesced`)、`x-pgs-wm`(`0` / `1`)、`x-pgs-hd-width` |
| GET `/security/events` | status | `limit`(≤300,默认 100) | `{events[]}`:内存中最近的安全事件(`hd_denied / hd_rate_limited / hd_scan_detected / hd_blocked / hd_abuse_blocked`),落盘在 `DATA_DIR/logs/security.log` |
| GET `/security/watermark` | users | `code=U-XXXXXX` | `{matches:[{id,username,role}]}`:由水印里的动态标识反查用户(遍历全部用户计算 HMAC) |

## 9. 支持的文件类型
图片:`jpg jpeg png gif webp avif bmp tif tiff heic heif hif`(GIF 仅取首帧;HEIC 由 `heic-convert` 解码)。
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
| `THUMB_WIDTH` / `PREVIEW_WIDTH` | 720 / 1600 | 派生图最大宽度 |
| `EXIF_READ_BYTES` | 1048576 | EXIF 只读文件头字节数(读不到再放大到 8MB) |
| `MAX_UPLOAD_MB` | 2048 | 单文件上限,0=不限 |
| `MIN_FREE_DISK_MB` | 1024 | 上传前要求的最小剩余磁盘,0=不检查 |
| `CORRUPT_AUTO_PURGE_HOURS` | 5 | 疑似损坏文件在停止上传满该小时数后自动清理,0=关闭 |
| `JSON_BODY_MAX_KB` | 1024 | JSON 请求体上限 |
| `DB_POOL_MAX` / `DB_STATEMENT_TIMEOUT_MS` / `DB_CONNECT_TIMEOUT_MS` / `DATABASE_SSL` | 10 / 20000 / 5000 / false | 连接池与慢查询保护 |
| `ALLOWED_MOUNT_ROOTS` | 空 | 逗号分隔白名单;留空时只允许数据目录与 `/photos /mnt /media /srv /home /volume1` |
| `SCAN_INTERVAL_MIN` | 0 | 挂载相册自动重扫间隔(分钟),0=关闭 |
| `SCAN_MAX_DEPTH` | 32 | 递归扫描最大目录深度(1-128);超出时计入 `truncated` 并在扫描结果中提示(**`.env.example` 未列出**) |
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
| `HD_CACHE_DIR` | `DATA_DIR/cache/hd` | — | 缓存目录 |
| `HD_CACHE_MAX_MB` / `HD_CACHE_TTL_DAYS` | 2048 / 7 | 16-1048576 / 0.01-365 | 缓存**磁盘**上限(LRU)与过期天数;**不是内存上限** |
| `HD_TOKEN_TTL_SEC` | 90 | 15-3600 | 令牌有效期 |
| `HD_RATE_IP_PER_MIN` / `HD_RATE_USER_PER_MIN` / `HD_RATE_MEDIA_PER_MIN` / `HD_RATE_TOKEN_PER_MIN` | 30 / 40 / 120 / 60 | 1-100000 | 取图(IP/用户/媒体)与申请令牌(IP)的每分钟上限 |
| `HD_SCAN_DISTINCT` / `HD_SCAN_WINDOW_SEC` / `HD_SCAN_BLOCK_SEC` | 150 / 300 / 300 | 5+ / 30-86400 / 10-86400 | 批量访问检测:窗口内不同图片数上限 / 窗口秒数 / 封禁秒数 |
| `HD_WM_ENABLED` | true | — | 是否合成水印 |
| `HD_WM_TEXT` | `Source: {host} · {project}` | — | 宏 `{host}`(请求域名,受 `PUBLIC_BASE_URL`/`ALLOWED_HOSTS` 影响)、`{project}`(`PROJECT_URL`) |
| `HD_WM_OPACITY` / `HD_WM_FONT_SIZE` / `HD_WM_ANGLE` / `HD_WM_DENSITY` | 8 / 16 / -30 / 3 | 1-100 / 8-96 / -90~90 / 1-5 | 透明度(%)/字号(按图宽在 0.7~1.4 倍间缩放)/角度/平铺密度 |
| `HD_WM_USER` | true | — | 登录用户叠加动态标识 `U-XXXXXX` |
| `HD_WM_FONT_FILE` | 空 | — | 空 = `node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf`(仅拉丁字符;中文水印需 CJK 字体文件) |

### 10.2 硬编码常量(**没有**环境变量)

调参前先确认是否真的需要把它们提升为配置(对应计划见 `todo.md`)。

| 常量 | 值 | 位置 | 影响 |
|---|---|---|---|
| 派生图输入像素上限 `limitInputPixels` | 268,000,000 | `media/derive.ts#INPUT_OPTS` | 超过即解码失败 → `failed`;HD 用 `HD_MAX_INPUT_MP` |
| `sequentialRead` | true(仅派生图;HD 未设置) | `derive.ts` / `hd/service.ts` | — |
| `sharp.concurrency` / `sharp.cache` | 2 / false | `derive.ts` 模块加载时 | 全进程 libvips 线程数/缓存 |
| preview / thumb WebP 质量 | 84 / 84;thumb 高度上限 = 2×`THUMB_WIDTH` | `derive.ts#makeDerived` | — |
| HEIC→JPEG 质量 | 0.92 | `derive.ts#heicToJpeg` | 中间 JPEG 体积 |
| EXIF 最大读取 `EXIF_MAX_BYTES` | 64MB(TIFF 逐级放大 `EXIF_READ_BYTES`→8MB→64MB) | `media/metadata.ts` | 每个并发任务最多一个该大小的 Buffer |
| PNG 隐写提取像素上限 | 16,000,000 | `media/png.ts#readStealthInfo` | 超过不提取 |
| 队列重试 | 3 次,1s/4s/16s | `queue.ts` | — |
| 启动恢复 pending 上限 | 20000 条 | `ready.ts` | 超出只警告 |
| 缓存 TTL | 相册树 10s、相册统计 5s、黑名单外部键 5s、`/status` 5s、ffmpeg 探测 60s、Basic 认证 60s、用户对象 15s | `albums.ts` `blocklist.ts` `api/admin.ts` `auth.ts` | — |
| 软删除宽限期 `MISSING_GRACE_MS` | 7 天 | `albums.ts` | — |
| 扫描并发 | 目录项 `stat` 8 路 | `albums.ts` | — |
| 登录失败限流 | IP 10 次 / 用户名 20 次 / 10 分钟 | `auth.ts` | — |
| 限流表上限 | `rate.ts` 20000 键;HD 安全事件内存 300 条、日志 5MB 轮转 | `rate.ts` `hd/guard.ts` | — |
| 水印层缓存 | ≤24 个,FIFO | `hd/watermark.ts` | 每项是一张 W×H 的 PNG Buffer |
| 导入/上传并发 | 上传 `concurrency` 默认 4(≤`THUMB_CONCURRENCY`);直链上传 `min(3, THUMB_CONCURRENCY)`;服务器路径导入默认 4(≤`THUMB_CONCURRENCY`),单次最多 20000 个文件 | `api/media.ts` | 只影响入库(落盘+哈希),不是解码并发 |
| 直链下载 | 超时 120s、最多 5 次重定向 | `media/fetch-url.ts` | — |
| 镜像环境 | `UV_THREADPOOL_SIZE=12`、`MALLOC_ARENA_MAX=2`、`LD_PRELOAD=libjemalloc`、`NODE_OPTIONS=--max-old-space-size=${PGS_NODE_HEAP_MB:-1024}`(compose) | `Dockerfile` / `docker-compose.yml` | libuv 线程池(sharp/fs/scrypt/DNS 共用)与内存碎片 |

### 10.3 docker compose 的变量传递规则(重要)

`docker-compose.yml` 的 `app.environment` 是**白名单**,且**没有 `env_file:`**。`.env` 里的变量只用于 compose 文件内的 `${...}` 插值,**不会自动进入容器**。按此语义(基于 Compose 行为判断,尚未在真实容器内用 `printenv` 验证),当前只有下列变量能从 `.env` 传到应用:

| 传递方式 | 变量 |
|---|---|
| `${PGS_*}` 映射 | `DB_DRIVER`←`PGS_DB_DRIVER`、`SQLITE_FILE`←`PGS_SQLITE_FILE`、`ADMIN_USER/ADMIN_PASSWORD/SESSION_SECRET`←`PGS_ADMIN_USER/PGS_ADMIN_PASSWORD/PGS_SESSION_SECRET`、`THUMB_CONCURRENCY`←`PGS_THUMB_CONCURRENCY`(默认 4)、`VIDEO_CONCURRENCY`←`PGS_VIDEO_CONCURRENCY`、`HEIC_CONCURRENCY`←`PGS_HEIC_CONCURRENCY`、`NODE_OPTIONS`←`PGS_NODE_HEAP_MB`(默认 1024)、`TRUST_PROXY`←`PGS_TRUST_PROXY` |
| 同名直通 | `TZ` |
| 固定值 | `DATABASE_URL`(指向 compose 内的 `db` 服务) |
| 仅注释示例 | `PUBLIC_BASE_URL`、`ALLOWED_MOUNT_ROOTS` |

**未传递**(在 `.env` 里写了也无效,除非自行加进 `environment:` 或增加 `env_file:`):全部 `HD_*`(含 README 内存建议里的 `HD_CONCURRENCY`、`HD_CACHE_MAX_MB`)、`S3_*`、`COOKIE_SECURE`、`MAX_UPLOAD_MB`、`MIN_FREE_DISK_MB`、`THUMB_WIDTH`、`PREVIEW_WIDTH`、`SCAN_*`、`GUEST_*`、`SEARCH_RATE_PER_MIN`、`KEY_RATE_PER_MIN`、`ALLOWED_HOSTS`、`EXIF_READ_BYTES`、`CORRUPT_AUTO_PURGE_HOURS` 等。这是内存调优与 HTTPS 部署的实际障碍,见 `todo.md` 的 D-2。另:`docker-compose.yml` 与 `.env.example` 的 `PGS_TAG` 默认值仍是 `1.4.0`,与 `package.json` 的 `1.4.3` 不一致。

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
| 改启动页 | `components/Splash.tsx`;动画 CSS 在 `app/globals.css`;配置项在 `server/settings.ts` |
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
| 改 HD 缓存策略 | `server/hd/cache.ts`(版本号在 `service.ts#versionOf`);容量/TTL 用 `HD_CACHE_*` |
| 改队列并发 / 闸门 / 重试 | `server/queue.ts`(槽位、重试)、`media/derive.ts`(`heicGate`/`videoGate`/`sharp.concurrency`);影响内存模型,先读 §17 |
| 改派生图输入限制 / 质量 | `media/derive.ts#INPUT_OPTS`、`#makeDerived`;HD 用 `HD_MAX_INPUT_MP`/`HD_QUALITY` |
| 改 `/status` 指标 | `server/api/admin.ts#/status`(内存目前只有 `rss/heapUsed`);前端 `components/settings/SystemTab.tsx` |
| 改 PWA / 离线 | `public/sw.js`(`VERSION` 变更才会更新缓存)、`app/manifest.ts`、`app/pwa-icon/[name]/route.ts`、`components/Pwa.tsx` |
| 改 docker 环境变量传递 | `docker-compose.yml` 的 `app.environment`(白名单,见 §10.3);镜像内环境在 `Dockerfile` |

## 13. 前端约定

- 组件全部 `"use client"`,数据通过 `lib/api.ts` 的 `api<T>()`(自动解包 `{ok,data}` 信封,错误抛 `ApiErr`)。
- 弹窗/确认框统一用 `DialogProvider` 的 `useDialog()`(`choose/confirm/prompt/alert/confirmCheck`),不要用原生 `alert/confirm/prompt`;危险且需显式勾选的操作(如"同时删除源文件")用 `confirmCheck({checkLabel, checkHint, defaultChecked})` → `Promise<{checked}|null>`。
- **位于 `.topbar` / `.dock` / 任何带 `backdrop-filter` 的元素内部的浮层,必须用 `createPortal` 挂到 `document.body`**:带 `backdrop-filter`(或 `filter`/`transform`/`contain`)的祖先会成为 `fixed` 后代的包含块,否则浮层的 `inset-0` 只等于该祖先的尺寸(通知面板曾因此塌成一条细线)。
- 浮层高度用 `flex` 居中 + `padding` 让出顶栏/底部工具栏,内容区用 `min-h-0 flex-1 overflow-y-auto overscroll-contain` 独立滚动;打开时锁 `document.body.style.overflow`。
- 启动页有纯 CSS 兜底动画(`splash-auto-hide`):即使客户端脚本没执行,也会在 `durationMs + 1.2s` 后自动淡出,不会永久挡住整站。

- 根布局注入 `<style id="pgs-theme">`(`themeCss()`),设置页修改主题时直接替换其 `textContent` 实现实时预览;保存后全站生效。CSS 变量:`--bg --bg2 --surface --fg --muted --accent --accent-fg --border`;毛玻璃类 `.glass / .glass-strong`;按钮 `.btn / .btn-primary / .btn-danger`;输入 `.field`。
- 全局事件(`window.dispatchEvent`):`pgs:changed`(媒体变更,图库刷新)、`pgs:albums`(相册变更,相册视图刷新)。
- 高清图查看:`Viewer.tsx` 在 HD 就绪前只显示转圈加载态,不先渲染无水印预览图;HD 响应本身已在服务端合成水印(`x-pgs-wm: 1`)。
- 登录态与权限来自 `AppProvider`(`/auth/me`)。页面是否展示管理控件只做体验层判断,**真正的授权永远在服务端 `route()` 的 access 参数**。
- 图库(`Gallery.tsx`):**固定列数等宽瀑布流**(每张图放入当前最矮的列,高度由 `aspect-ratio` 决定,宽高比钳制在 0.35~3);游标分页每页 80 条,`IntersectionObserver`(`rootMargin` 1200px)触底加载;**已加载项只增不减**(没有虚拟列表,代码中也没有 `content-visibility`),缩略图 `<img loading="lazy" decoding="async">`;存在 `pending` 项时每 3 秒请求一次前 80 项刷新状态,最多 40 次(约 2 分钟)后停止。
- 启动页每个标签页会话只显示一次(`sessionStorage["pgs-splash"]`);`url` 模式按扩展名选择 `<img>`/`<video>`/`<iframe sandbox="allow-scripts">`。

## 14. 性能与安全设计要点

- 上传全程流式,不进内存;SHA-256 边写边算;派生任务共用 `THUMB_CONCURRENCY` 个槽位,视频/HEIC 再经**嵌套**闸门(`VIDEO_CONCURRENCY`/`HEIC_CONCURRENCY`,见 §6.11);HD 另有独立的 `HD_CONCURRENCY` 闸门,与前者互不感知;`sharp.cache(false)` 避免缓存膨胀;缩略图由预览图再缩小,避免二次解码大图;输入统一加 `limitInputPixels` 与 `sequentialRead` 防解压炸弹。
- EXIF 只读文件头(`EXIF_READ_BYTES`,默认 1MB,读不到再放大到 8MB),不再整文件读入。
- 列表走键集分页 `(sort_at,id)` 与复合索引;相册树、统计与游客可见集合在内存短时缓存,`loadTree/loadStats` 有 in-flight 合并;媒体入库只做 2 秒防抖失效,避免批量上传期间反复全表聚合;搜索走 `pg_trgm` GIN 索引。
- 文件输出只 select 必要列(不含 `meta`/`search_text`);派生图 `ETag` + `max-age=300`,原文件 `no-store`;所有 S3 访问懒加载 SDK。
- 密码 scrypt;失败路径只跑 1 次 scrypt(时序均衡复用固定哈希);Basic 与登录共用 IP + 用户名双维度限流;下载密钥只存哈希、最小长度 16、校验单条 SQL 完成并限流;令牌 HMAC 常量时间比较并携带 `token_version`(改密码即失效);`local` 存储路径防穿越;挂载路径 `realpath` 后比对白名单并检查重叠;自定义图标光栅化重编码、SVG 以 `sandbox` CSP 输出;媒体 `Content-Type` 来自扩展名白名单且附带 `nosniff`。
- 全局安全响应头在 `next.config.ts` 统一注入;`/f/*` 与 `/api/v1/media/*` 带 `X-Robots-Tag: noindex`;`public/robots.txt` 默认 `Disallow: /`;游客元数据按 `GUEST_META` 裁剪(GPS/序列号/作者邮箱/raw 不返回),备注不进公开搜索、`error` 对游客置空。
- 水印在服务端合成进最终 WebP 像素(默认透明度 8%),前端不会先展示无水印大图;高清缓存目录不对外暴露,只能经带令牌与权限校验的 `/media/:id/hd` 读取;水印层缓存变体上限 24,**FIFO** 淘汰(命中不刷新顺序)。
- 数据库连接池无条件缓存到 `globalThis` 并监听 `error` 事件(避免空闲连接出错杀死进程),带 `statement_timeout`。
- **内存模型**:进程 RSS 的主要来源是 sharp/libvips 的解码工作集(随输入像素、格式、并发数增长),而不是 V8 堆,也不是输出 Buffer;实测数据与推导见 §17。
- 已知边界:播放令牌 + `Sec-Fetch-Dest` 校验只能防"直接下载",无法阻止录屏/抓包;进程内队列、限流与缓存均为单进程内存,**仅支持单实例部署**;`/media/import` 仍是同步长请求。

## 15. 开发与验证

> 全量自动化测试(API / CLI / PostgreSQL+SQLite / local+ext / Docker)见 `scripts/TESTING.md`;日常只需 `node scripts/test-matrix.mjs --drivers sqlite`。

```bash
npm install
cp .env.example .env            # 填写 DATABASE_URL 等
npm run dev                     # 开发
npm run typecheck && npm run lint && npm run build   # 提交前校验(CI 同样执行)
```
CI:`ci.yml`(typecheck + lint + build,Node 22);`test.yml`(PostgreSQL 15 + SQLite 全链路,Node 24,素材 8 图 1 视频)。**没有**性能/内存回归用例(见 `todo.md` T-1)。

端到端冒烟:启动后依次验证 `POST /albums` → `POST /media/upload` → `GET /media?q=` → `GET /f/:id`(无 key=预览,有 key=原图)→ `POST /keys` → 游客访问私有相册应 404。

## 16. 版本历史与遗留项(v1.3.0 起)

本轮依据一份外部代码审查清单(整合版 issue,已在完成后移除)逐条落地,共完成 41 项。要点:

- 数据安全:扫描熔断 + `missing_at` 软删除、先搬文件后改库、`(size,mtime)` 变更与重命名识别、删除事务化、黑名单复用原 id。
- 认证:Basic 与登录共用限流、`TRUST_PROXY`、生产环境拒绝占位密码、`token_version`。
- 隐私:游客元数据裁剪、备注不进搜索、`error` 置空、`robots.txt`。
- 性能:分池并发、EXIF 只读头部、只选必要列、可见集合缓存、失效防抖、`pg_trgm`、队列游标。
- 部署:tini + 非 root + healthcheck + jemalloc、连接池 `error` 监听、CI 工作流。

**v1.3.0 时明确未做**(其中"自动化测试骨架"已在 v1.4.3 补齐为 `scripts/` + `test.yml`,其余至今仍未做):视频转码预览(720p/HLS)、`/media/import` 异步 Job、列表接口统一分页、个人访问令牌 PAT 与作用域、drizzle 迁移体系与 FK/CHECK 约束、ext 文件 hash 与感知哈希、前端虚拟列表与 SSE、Caddy/Cloudflare 反代示例。

**升级注意**:新增字段由 `bootstrap.ts` 的 `ALTER TABLE ... IF NOT EXISTS` 自动补齐,老库直接启动即可;`pg_trgm` 索引在数据库无权限时只告警不影响启动。挂载相册新增 `readonly` 且**默认 true**,升级后向挂载相册上传/移动会被拒绝,需要时用 `PATCH /albums/:code {readonly:false}` 或 `pgs album set <code> --no-readonly` 关闭。

### 16.1 v1.3.1 ~ v1.3.4 复查与实测修补(2026-11-23)

v1.3.0 的改动在代码复查与 InstaBox 真机部署中暴露出 8 处问题,均已修复:

1. 只读挂载可被物理删除:`deleteMediaByIds(ids, purge=true)` 与 `blocklist.purgeBlocked()` 原先不检查 `readonly`。现 `purge` 前先整体校验,命中只读挂载直接 403(而不是「删记录、留文件」——后者会让用户以为已删除,且下次扫描又把文件重新入库);黑名单彻底删除同样 403。
2. 扫描熔断误判:`gone` 原先包含「上次扫描已标记 `missing_at`」的记录,一次合法的大批量删除会让比例长期超阈值,导致此后每次扫描都抛错。现熔断只统计本次新消失的文件,且判断前移到任何写库动作之前(先熔断,后重命名/插入/软删除)。
3. 前端无法感知只读:上传对话框不显示只读状态,用户上传后才收到 403。现 `UploadDialog` 在选择只读挂载相册时禁用「开始上传」并给出说明,相册下拉标注「目录(只读)」;`AlbumActions` 增加「只读 ↔ 允许写入」切换(需 `album.mount`);挂载对话框增加「只读挂载(推荐)」勾选项;设置页相册列表显示「挂载·只读 / 挂载·可写」。
4. CLI 无法关闭只读:`util.parseArgs` 的 boolean 不接受 `--readonly=false`,新增 `--no-readonly`(`album mount` 与 `album set` 均支持),并修正帮助文本。
5. **升级后数据目录不可写(实测发现)**:旧版本容器以 root 运行,`DATA_DIR` 下的 `albums/derived/tmp` 属主为 root;v1.3.0 改为 `USER node` 后,这些目录对新容器只读,上传直接 `EACCES`(表现为 500)。现改为「容器以 root 启动入口脚本 → 仅修正本系统管理的子目录属主 → `setpriv` 降权到 uid 1000 再启动应用」,进程本身仍非 root,且不触碰用户自行挂载的照片目录。
6. 生产环境弱口令拦截生效(实测):`ADMIN_PASSWORD=admin123456` 会被拒绝启动。升级时若沿用旧测试口令需同步更换。
7. **受管相册移动不搬文件(实测发现)**:`batchAction('move')` 与 `PATCH /media/:id` 原先只对 `storage='ext'` 调 `relocateExtFile`,受管相册(`local`)的文件只改了 `album_id`,文件仍留在原相册目录——接口返回 `affected:6` 但磁盘上 `A=6 / B=0`。现新增 `relocateLocalFile()`,受管相册移动同样先搬文件后改库;`deleteAlbum` 的移交逻辑也改为同名冲突自动换名重试,不再因 `EEXIST` 中断整个移交。
8. **`local` 存储的 `storageKey` 是相对路径(实测发现)**:第一版 `relocateLocalFile` 直接把 `albums/<code>/x.jpg` 当绝对路径做 `fs.link`,全部 `ENOENT`。现统一经 `localAbs()` / `localKey()` 在「相对 DATA_DIR 的 key」与「绝对路径」之间转换,与 `storage/index.ts` 的 `localDriver` 保持同一规则;`deleteAlbum` 的移交路径同样修正。

版本号 `1.3.4`(`package.json`、`package-lock.json`、`config.ts`、`cli/pgs.mjs`、`.env.example` 的 `PGS_TAG` 一致)。`tsc --noEmit`、`eslint .`、`node --check cli/pgs.mjs` 均通过;InstaBox 真机 `scripts/test-hd.mjs` **46/46 通过**。

### 16.2 v1.3.5 外部检测报告缺陷修复(2026-11-23)

一份基于 208 个真实 NASA 素材、351 项检查的外部检测报告(裸机 `npm start`)指出 9 类问题,v1.3.5 全部修复并在容器内复测通过。

**元数据**
1. **TIFF 元数据几乎全部丢失(B1)**:`extractImageMeta` 用 `Object.keys(out).length` 判断 exifr 是否解析成功,而截断缓冲区时 exifr 返回 `{errors:[{}]}`,该判定为真 → 停止放大读取。TIFF 的条带偏移表在文件后部,因此 32 个 TIFF 只有 1 个能取到字段。现改为 `hasSegments()`:忽略 `errors` 键,只有真正解析出段才算成功;TIFF 的读取上限从固定 8MB 改为逐级放大到 `EXIF_MAX_BYTES`(64MB)。实测 33MB 的 NASA TIFF 在 1MB/8MB 处均为空壳,整文件解析后 Make/Model/ISO/镜头/拍摄时间/标题/关键词全部正确。
2. **仅含 XMP 的字段取不到(B4)**:exifr 把 XMP 按命名空间拆成独立段(`dc` / `photoshop` / `aux`),旧代码只读 `parsed.xmp`,因此 `dc:title`、`dc:subject`、`photoshop:DateCreated` 全部丢失。现按 `ifd0 → exif → gps → iptc → xmp → dc → photoshop → aux → …` 的顺序合并所有段;`fmt()` 对 XMP 的 `{lang,value}` 结构取 `value`;`time.taken` 在无 `DateTimeOriginal` 时回落到 `DateCreated`。
3. **XMP 字符串日期未识别**:`takenAt` 原先只接受 `Date` 实例,而 XMP 日期多为字符串。新增 `toDate()`,统一解析 `Date` / ISO 字符串 / EXIF 的 `YYYY:MM:DD HH:MM:SS` / 扫描件的 `YYYYMMDD`。
4. **展示值不可读(B10)**:`colorSpace` 的 `"1"` → `sRGB`、`"65535"` → `未校准`,无 EXIF 时回落到 sharp 的 `srgb/rgb/cmyk` 并转成常见写法;`bitDepth` 的 `uchar/ushort/float` → `8-bit/16-bit/32-bit`。

**相册与并发**
5. **并发建相册偶发幽灵 404(B2)**:`loadTree()` 的惊群合并会让「插入前启动的旧查询」在 `invalidateAlbums()` 之后把过期树写回缓存,新相册在 10 秒缓存期内查不到。现引入**缓存代数** `treeGen`:查询开始时记录代数,写回前比对,不一致则丢弃;同时若 in-flight 查询的代数已过期,新请求不再复用它。实测 120 并发建相册 120/120 返回 201(修复前 300 并发有 8 个 404)。
6. **相册名含 NUL 触发 500 并留孤儿目录(B6)**:`cleanName()` 过滤 `\u0000-\u001f` 与 `\u007f`;`createManaged()` 在 insert 失败时回滚已创建的目录。
7. **并发搬同一文件残留孤儿硬链接(B7)**:`link→unlink` 在并发下互相穿插,旧目录残留 nlink=2 的不可见文件。现为每个媒体 id 加键控互斥 `withMoveLock()`,并让 `moveNoOverwrite()` 容忍 `unlink` 的 `ENOENT`(另一请求已删源时目标文件仍有效)。实测 12 路并发搬 3 个文件:源目录 0 残留、目标 3/3。

**入库与视频**
8. **并发上传同一文件重复入库(B12)**:去重是「先查后插」且 `hash` 列无唯一约束。现按 `(hash, 相册)` 加键控互斥 `withHashLock()` 串行化入库(不引入唯一约束,因为 `album_id` 可为 NULL 且历史数据可能已有重复)。实测 20 路并发:created=1 / duplicate=19 / 相册内 1 条。
9. **损坏视频被标记 ready(B11)**:`probeVideo` 失败时返回全 null 但仍走 `status=ready` 与占位封面。现三个关键字段全 null 直接抛错 → `failed`,并给出「文件可能已损坏或不是有效视频」。
10. **视频封面可能是纯黑帧(B9)**:新增 `isBlankFrame()`,抽帧后检测标准差与均值,命中纯色/黑场则依次换 `duration/2 → 0 → 25% → 75%` 重试。

**运维**
11. **崩溃后 tmp 遗留(B8)**:`cleanTmp()` 增加阈值参数,启动时以 `0` 调用(进程刚启动不可能有进行中的上传),每小时定时清理仍保留 6 小时阈值。
12. **readiness 不反映磁盘阈值**:`/health/ready` 的磁盘检查从固定 64MB 改为 `max(64, MIN_FREE_DISK_MB)`,与上传的 507 保护同阈值。

**CLI**
13. **三处文档与实现不一致(B5)**:`OPTIONS` 补注册 `links`、`watch`(此前 `parseArgs` 严格模式直接退出码 2);`album list --parent <code>` 真正把 `parent` 传给接口(此前忽略该参数返回全部相册)。

**实测结果(容器内,4 vCPU / 8GB,PostgreSQL 16)**
- 修复验证 18/18 通过(12 项元数据/并发/异常文件 + 6 项搬移/tmp/CLI)。
- 内存:99 个 NASA 文件全量上传 5.5s / 峰值 733MB;24 路 HD 并发峰值 **1897MB**;静置 20 秒回落到 **709MB**。对比裸机 `npm start`(报告数据)峰值 2490MB 且压测后 2168MB 不回落 —— 差异来自镜像内的 `jemalloc` 与 `MALLOC_ARENA_MAX=2`,已在 README 的部署章节写明。

版本号 `1.3.5`(`package.json`、`package-lock.json`、`config.ts`、`cli/pgs.mjs`、`.env.example` 的 `PGS_TAG`、`docker-compose.yml` 的默认 tag 一致)。CI(`tsc --noEmit` + `eslint .` + `next build`)通过;镜像 `ghcr.io/dming623/picgalleryserver:1.3.5` 已发布。

### 16.3 v1.4.0(2026-11-24):通知 / 时区 / 直链上传 / SQLite / UI 修复

**新增能力**

1. **站点通知**:`pgs_notices` + `pgs_notice_reads` 两张表;`server/notices.ts` 提供列表/未读数/发布/编辑/删除/已读;接口 `server/api/notices.ts`。权限新增 `notice.publish`(admin / manager)。前端 `components/NoticeBell.tsx`(顶栏铃铛 + 覆盖式面板)与 `components/settings/NoticeTab.tsx`(Markdown 编辑 + 预览)。Markdown 渲染为自写的 `lib/markdown.ts`(零依赖:先整体 HTML 转义再替换,链接走 http/https/mailto/相对路径白名单)。
2. **时区**:`SiteSettings.timezone`(默认取 `TZ` 环境变量,回落 `Asia/Shanghai`),`isValidTimezone()` 用 `Intl` 校验;通知发布时间与日期分组按它换算,改时区后历史通知显示时间同步变化。设置页入口在「系统状态」顶部。
3. **直链上传**:`server/media/fetch-url.ts` 下载远端图片/视频到 tmp 后复用 `ingestOne`;接口 `POST /media/upload-url`。SSRF 防护按「全部解析结果都是内网地址才拒绝」(双栈环境会同时返回 ULA 与公网 IPv4,一刀切会误杀正常域名——实测 `images-assets.nasa.gov` 解析出 `fc00::3d` + `198.20.0.62`)。限制重定向 5 次、总时长 120s、体积 `MAX_UPLOAD_MB`;支持裸域名自动补 `https://` 与含空格的文件名。
4. **双数据库驱动**:`src/db/index.ts` 按 `DB_DRIVER` 选择 pg 或 `node:sqlite` + `drizzle/sqlite-proxy`;新增 `rawQuery()`(两驱动都返回 `{rows}`)、`nullSafeEq()`、`pingDb()`、`closeDb()`。`bootstrap.ts` 维护两套 DDL。SQLite 模式注册 `now()` / `gen_random_uuid()` 兼容函数,并在读回时把 `disabled` / `readonly` 的 0/1 还原为布尔。
5. **Docker**:基础镜像升到 `node:24-bookworm-slim`(`node:sqlite` 在 Node 24 默认可用),运行阶段装 `tzdata` 并设 `ENV TZ=Asia/Shanghai`;compose 增加 `DB_DRIVER` / `SQLITE_FILE` / `TZ` 三个变量。

**SQL 可移植性改造**(原先用了 pg 专有语法,SQLite 会直接报错)

- `count(*)::int` → `CAST(count(*) AS INTEGER)`;`sum(size)::float8` → `CAST(... AS DOUBLE PRECISION)`。
- `DISTINCT ON (album_id)` → `row_number() OVER (PARTITION BY album_id ORDER BY sort_at DESC)`。
- `to_char(sort_at,'YYYY-MM')` → SQLite 走 `substr(sort_at,1,7)`(按驱动分支)。
- `now()` → 参数传 ISO 时间串;`a IS NOT DISTINCT FROM b` → `nullSafeEq()`(SQLite 用 `IS`)。
- 去掉 `::timestamptz` 强转(ISO 字符串在两种驱动下都能正确比较)。

**UI 缺陷修复**

6. **通知面板塌成一条细线(实测)**:面板渲染在 `.topbar` 内,而 `.topbar` 带 `backdrop-filter` —— 带该属性的元素会成为 `fixed` 后代的包含块,`inset-0` 只等于 36px 高的顶栏。改为 `createPortal` 挂到 `document.body`,并用 `flex` 居中 + `padding` 让出顶栏/底部工具栏。
7. **挂载目录弹窗被顶栏遮挡 / 位置偏低**:容器改为 `flex` 居中 + `padding` 让出顶栏与底部工具栏;面板 `marginBottom: 4cm`(居中布局下等于上移 2cm),`maxHeight: calc(100% - 4cm)`;内容区 `min-h-0 flex-1 overflow-y-auto overscroll-contain` 独立滚动,打开时锁 `body` 滚动。
8. **启动页可能永久卡住**:新增纯 CSS 兜底动画 `splash-auto-hide`,即使客户端脚本未执行也会在 `durationMs + 1.2s` 后自动淡出。开发模式下 Next 会拦截跨源 dev 资源(`Blocked cross-origin request ... from "127.0.0.1"`),已在 `next.config.ts` 加 `allowedDevOrigins`。
9. **`AppProvider.reload()` 未捕获拒绝**:服务重启时日志刷 `unhandledRejection: Failed to fetch`,已补 `catch`。

**实测(SQLite 模式,沙箱内 `npm run dev`)**

- `tsc --noEmit` / `eslint .` 通过;`/`、`/albums`、`/settings`、`/login` 均 200。
- 建相册、multipart 上传(2 个文件,派生图与元数据 ready)、挂载目录扫描(子目录自动建嵌套相册)、删除→黑名单→解除、下载密钥创建与原图访问、用户创建、批量移动、通知发布/未读/一键已读 全部通过。
- 直链上传:NASA 星云 PNG(3.3MB)与 NASA 视频 MP4(167MB,1920×1080 / 93s)均下载入库成功,视频封面与 ffprobe 元数据正常。

**许可证表述修正**:PolyForm Noncommercial 1.0.0 **不是开源许可证**(OSI 开源定义不允许限制商业用途),README 与徽章说明统一改为「非商业许可证 / 源码公开但非商业」,不再称其为开源许可证。


### 16.4 v1.3.6 ~ v1.4.3(2026-11-23 ~ 11-24)

- **v1.3.6**:图库默认不展示 `failed` 记录;系统状态新增「疑似损坏文件」卡片与 `GET /status/corrupt`、`POST /status/corrupt/purge`;停止上传满 `CORRUPT_AUTO_PURGE_HOURS`(默认 5)小时自动清理(受管存储连源文件删除,挂载目录只删登记);设置页加载态;挂载弹窗可滚动。(`media/corrupt.ts`)
- **v1.4.1**(挂载扫描):① 并发扫描竞态——`scanAlbum` 在任何 `await` 之前同步占位 `scanLocks`,非 `wait` 模式也如实返回同步阶段失败;② 子目录改名不再产生幽灵相册——`dirSignature()`(直接子文件数 + `size:mtime` **多重集**)识别改名,`moveAlbumRoot()` 迁移 `rootPath` 前缀并改写 ext 的 `storage_key`,保留相册代码/记录/缩略图;③ 子目录删除后"先软删除 → 第二次扫描仍缺失/空相册才移除相册子树",仅 `ENOENT/ENOTDIR` 判定消失,权限/IO 错误一律保留;④ 深层目录不再静默丢失——`SCAN_MAX_DEPTH`(默认 32),超出计入 `truncated`。扫描统计新增 `albumsRemoved / albumsMoved / truncated`。挂载弹窗改为严格落在顶栏与底栏之间、`blur(14px)` 遮罩、Esc 关闭。
- **v1.4.2**:`dirSignature` 由 Set 改为排序数组(同尺寸同 mtime 的多个文件不再被去重);改名比对纳入已 `missing_at` 的记录并在迁移时清除标记;`storage_key` 前缀迁移改为"新前缀 + `substr` 去旧前缀";`config.version` 改读 `package.json`。
- **v1.4.3**(全链路测试发现的缺陷 + 测试套件):PG ≤15 子查询别名;BMP 解码(`media/bmp.ts`);`dir=` 绕过只读;ext 文件移到受管相册只改库;CLI 幂等上传漏传 / `-r` 无效 / `version`;ext 图片 `SIGBUS`(私有副本,§7.2);队列"处理中变更丢失"(`dirty`)与"重试永不发生"(§6.11);删除不存在通知应 404;`THUMB_WIDTH` 文档统一;EXIF 无时区拍摄时间改按**站点时区**解释(不再随进程 `TZ` 漂移,带 `OffsetTimeOriginal` 的仍按绝对时刻)。新增 `scripts/` 测试套件与 `.github/workflows/test.yml`,README 补充依赖版本建议。

> 版本号一致性提醒:`docker-compose.yml` 与 `.env.example` 的 `PGS_TAG` 仍为 `1.4.0`(见 §10.3)。


## 17. 性能与内存模型(实测基线)

> 本节回答"内存/并发到底由什么决定"。数据来自 2026-11-24 的一组**合成素材微基准**(方法与局限见 §17.3、§17.4),不是对生产环境的复现;README 里 NASA 素材的容器实测(空载 ~250MB、HD 24 并发峰值 ~1.9GB)是另一组数据,二者互补。改动队列/闸门/出图流程后,请按 §17.3 重新测量并更新本节。

### 17.1 结论摘要

1. **RSS 峰值 ≈ 基线 + Σ(同时在解码的任务的工作集)**。单个任务的工作集由「输入像素数 × 每像素字节 × 格式系数」决定,**与输出 Buffer 无关**:preview/thumb 输出均值仅约 176KB / 50KB(README 实测),把 `toBuffer()` 改成 `toFile()` 在实测中**峰值完全相同**。
2. **格式系数差异巨大**:常规 PNG / TIFF / 基线 JPEG 在 `sequentialRead` 下是流式解码,工作集约 0.7~1.5 字节/像素;**隔行(interlaced)PNG** 与**渐进式(progressive)JPEG** 必须整幅解码,约 3.4~3.6 字节/像素(100MP 隔行 PNG 单任务峰值 405MB,48MP 渐进 JPEG 235MB)。4 并发时:基线 JPEG 195MB、非隔行 PNG 355MB,而渐进 JPEG 753MB、隔行 PNG 1430MB。`sharp().metadata().isProgressive` 对 PNG 隔行与 JPEG 渐进都为 `true`(已实测),可以零成本识别。
3. **并发数按"任务个数"限制是粗糙的**:4 个 24MP 基线 JPEG 和 4 个 100MP 隔行 PNG 占用 `THUMB_CONCURRENCY=4` 的槽位完全一样,内存却差 9 倍。按**像素加权**的闸门(§17.3 的演示)能把后者的峰值压到约 1/3,代价只落在这类极端输入上。
4. HD 水印合成是**每请求**一次 W×H×4 级别的瞬时分配(2560×1707 ≈ 4.4MP,实测约 +35~75MB/次,折合 12~17 字节/像素),被 `HD_CONCURRENCY` 约束;若没有这个闸门,24 并发可到 ~930MB。
5. 各类闸门(派生槽位 / `heicGate` / `videoGate` / `HD gate`)**互相独立**,理论峰值是它们各自峰值之和。

### 17.2 内存来源清单

| 来源 | 量级 | 受什么控制 | 备注 |
|---|---|---|---|
| Next + Node 基线 | 空载 ~250MB(README)| — | 裸 sharp 进程仅 ~61MB |
| libvips 解码工作集(派生图) | 见 §17.3 表 | `THUMB_CONCURRENCY`、`limitInputPixels`(硬编码 268MP)| 受格式影响最大 |
| libvips 解码工作集(HD `convert`) | 同上 | `HD_CONCURRENCY`、`HD_MAX_INPUT_MP`(200)| 未设 `sequentialRead`(实测对常规输入无差异) |
| HD 水印合成 | 每次 W×H×4 的数份副本 | `HD_CONCURRENCY` | 每请求都做,结果不缓存 |
| 输出 Buffer(preview/thumb/HD 基图) | 几十 KB ~ 数百 KB | — | 可忽略 |
| HEIC | 整文件 Buffer + libheif(wasm)RGBA + JPEG 编码 + 中间 JPEG Buffer | `HEIC_CONCURRENCY`(1);**占用派生槽位**(§6.11) | wasm 线性内存**只增不减**(Wasm 规范特性,本项目未实测),长期含大 HEIC 的库 RSS 可能不回落 |
| BMP | 整文件 + RGBA(4 B/px)+ PNG Buffer | 无专门闸门 | 罕见格式;大 BMP 单任务可达数百 MB(推算,未实测) |
| EXIF 读取 | ≤64MB Buffer(仅 TIFF 的最坏情况) | 随派生并发 | — |
| 视频 | ffmpeg/ffprobe 子进程,不计入 V8 堆 | `VIDEO_CONCURRENCY`(嵌套闸门) | 子进程 RSS 同样计入容器 cgroup |
| HD 缓存读取 | 命中时 `readFile` 整张基图(数百 KB) | 无闸门 | 可忽略 |
| V8 堆 | 通常 <100MB | `NODE_OPTIONS=--max-old-space-size`(compose 默认 1024) | **不约束**上述任何原生内存 |

### 17.3 实测方法与结果(可重复)

环境:沙箱 4 vCPU / 3.9GB,Node 22.23.4,`sharp@0.35.5`(libvips 8.18.7),**glibc 默认 malloc**(无 jemalloc、未设 `MALLOC_ARENA_MAX`),非容器。每个场景在**独立进程**中运行,峰值取 `/proc/self/status` 的 `VmHWM`;进程启动基线 61MB。设置同项目:`sharp.cache(false)`、`sharp.concurrency(2)`;派生图用 `INPUT_OPTS`(`sequentialRead`),HD 用 `limitInputPixels=200e6`、宽 2560、q82。素材由脚本合成:24MP JPEG(q90)、40MP TIFF(deflate)、100MP PNG(非隔行 / 隔行)、48MP JPEG(基线 / 渐进)。脚本摘要见 `todo.md` 附录 A。

| 场景 | 输入 | 并发 | 峰值 RSS(MB) |
|---|---|---|---|
| 派生图,`toBuffer` vs `toFile` | 24MP JPEG / 40MP TIFF / 100MP PNG | 1 | **86/86、123/123、135/135(完全相同)** |
| 派生图 | 24MP JPEG | 4 | 158 |
| 派生图 | 48MP 基线 JPEG | 1 / 4 | 96 / 195 |
| 派生图 | 48MP **渐进** JPEG | 1 / 4 | 235 / **753** |
| 派生图 | 100MP PNG(非隔行) | 1 / 4 | 135 / 355 |
| 派生图 | 100MP PNG(**隔行**) | 1 / 4 | 405 / **1430** |
| HD `convert` | 24MP JPEG | 1 | 111 |
| HD `convert` | 40MP TIFF | 1 / 3 | 122 / 241 |
| HD `convert` | 100MP PNG(非隔行) | 1 / 3 | 145 / 311 |
| HD `convert` | 100MP PNG(**隔行**) | 1 / 3 | 409 / **1099**(开 `sequentialRead` 无变化:1098) |
| HD 水印合成(基图 2560×1707 WebP) | 叠一张同尺寸半透明 PNG 层 | 1 / 3 / 24(无闸门) | 166 / 336 / **931**(合成前 112) |
| 像素加权闸门演示 | 4×100MP 隔行 PNG | 无预算 vs 预算 150MP | 1434MB·2.6s → **500MB·9.6s** |
| 像素加权闸门演示 | 1×100MP 隔行 PNG + 20×24MP JPEG | 无预算 vs 预算 150MP | 549MB·2.5s → 406MB·3.7s |

按峰值反推的派生图工作集(扣除 61MB 基线,含固定开销,仅作量级参考):基线 JPEG ≈ 0.7 B/px、非隔行 PNG ≈ 0.7、deflate TIFF ≈ 1.5、渐进 JPEG ≈ 3.6、隔行 PNG ≈ 3.4;HD 水印合成 ≈ 12~17。

闸门演示的权重 = `ceil(宽×高/1e6 × (渐进/隔行 ? 1.5 : 1))`,`宽/高/isProgressive` 来自 `sharp().metadata()`——而 `processMedia` **本来就已经在出图前调用了 `metadata()`**,所以估算权重不需要额外 IO。

### 17.4 局限与未验证项(不要把本节当作生产结论)

- 素材是合成的(渐变 + 轻噪声),真实照片的压缩特征不同;**未测**:HEIC(`heic-convert`)、BMP、视频、16-bit PNG、带 ICC 的 CMYK TIFF、WebP/AVIF 大图。
- 未测 jemalloc / `MALLOC_ARENA_MAX=2` 的效果(README 已有容器实测:裸机峰值 2.49GB 不回落 vs 容器 1.90GB 回落到 0.71GB)。
- 未复现 README 的 "24 并发 HD 峰值 1897MB"。依本节数据的推测:`HD_CONCURRENCY=3` 个同时 `convert` 隔行/渐进/16-bit 的 NASA 大图 + 同期的水印合成与后台派生,已足够解释;**需要用真实素材 + 容器 + `printenv`/`/proc` 逐项验证**,在此之前不要据此调小 `HD_WIDTH` 等画质参数。
- 峰值 RSS 不等于"必须的内存":glibc 的碎片会让 RSS 不回落(README 已说明用 jemalloc)。

### 17.5 现有观测手段与缺口

- 现有:`GET /status` 返回 `memory:{rss, heapUsed}`、`queue`、`hd` 缓存统计;`/status/queue`。
- 缺口(`todo.md` P0-2):`external`、`arrayBuffers`、`sharp.cache()`/`sharp.counters()`(队列/处理中数)、`process.resourceUsage().maxRSS`、容器 `memory.current`/`memory.max`、各闸门的排队长度与等待时长、峰值 RSS 的滑动最大值。没有这些,无法区分"V8 堆 / Buffer / libvips 原生 / ffmpeg 子进程",也无法回答"哪个任务导致的峰值"。
