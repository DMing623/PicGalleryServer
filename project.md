# PicGalleryServer — 工程说明(面向维护者)

> 读者:第一次接触本项目的专业程序员。读完本文件应当能 **不遍历代码** 就定位到要改的文件、知道对外暴露了哪些接口、各模块的黑盒契约是什么。
> 约定:凡是"改 X 去哪个文件"的问题,先查 §3(目录职责)和 §12(常见改动速查)。

---

## 1. 项目概述

自托管图片 / 视频相册服务。核心能力:

- 相册分类(树形嵌套);两类相册:**受管相册**(文件存放在 `DATA_DIR` 或 S3)与**挂载相册**(把 VPS 上任意绝对路径目录就地索引,子目录自动成为嵌套子相册)。
- 缩略图 / 预览图自动生成(并发可控),详尽元数据提取(EXIF/XMP/IPTC/ICC、PNG 文本块、Stable Diffusion / NovelAI / ComfyUI / InvokeAI 生成参数、视频流信息),缺失字段展示 `N/A`。
- 原文件保护:游客只能看到管理员"公开"的相册;文件链接默认只返回预览图;原图/原视频必须带下载密钥(或具备 `original` 权限的登录用户)。
- 全局搜索 / 相册内搜索(范围严格限定在当前相册及其子相册)。
- 管理员备注(只存数据库,不写入原文件)。
- 多用户、四级角色;完整 REST API + 零依赖 CLI;`.env` 配置端口、管理员、并发等私密/运行参数。
- 毛玻璃 UI,主题 / 启动页 / 站点图标均可在设置中调整(默认 Claude 经典配色)。

## 2. 技术栈与运行形态

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16 App Router(Node runtime),TypeScript,Tailwind CSS 4 |
| 数据库 | PostgreSQL + Drizzle ORM(`pg` 驱动) |
| 图像 | `sharp`(缩放/转码/统计)、`exifr`(EXIF/XMP/IPTC/ICC)、`heic-convert`(HEIC 解码)、自写 PNG 块解析 |
| 视频 | 外部 `ffmpeg` / `ffprobe`(可选,通过 `FFMPEG_PATH` / `FFPROBE_PATH`) |
| 对象存储 | `@aws-sdk/client-s3`(可选,懒加载) |
| 上传解析 | `busboy` 流式 multipart(边收边写临时文件并计算 SHA-256) |
| 认证 | 自实现:scrypt 密码哈希 + HMAC 无状态令牌(Cookie / Bearer / Basic 三种携带方式) |

运行形态:单进程 Next 服务(`npm run build && npm start`,端口由 `PORT` 决定)。后台任务(缩略图队列、定时器)都在同一进程内,状态挂在 `globalThis`。数据库表在启动时自动幂等创建(`src/db/bootstrap.ts`),**无需手动迁移**。

## 3. 目录与文件职责

```
.
├─ project.md / README.md          本文件(给开发者) / 用户说明(功能与部署)
├─ .env  .env.example              环境变量(私密);.env.example 为完整模板
├─ Dockerfile docker-compose.yml   容器化部署(含 ffmpeg、Postgres)
├─ next.config.ts                  serverExternalPackages(sharp/exifr/heic-convert/busboy/aws-sdk 不打包)
├─ drizzle.config.json             drizzle-kit 配置(仅开发期 push/export 使用)
├─ eslint.config.mjs               ESLint(关闭 react-hooks/set-state-in-effect)
├─ cli/pgs.mjs                     命令行管理工具(零依赖,调用 REST API)
├─ data/                           运行时数据目录(DATA_DIR,默认 ./data,git 忽略)
│   ├─ albums/<albumCode>/         受管相册(local 存储)的原文件;albums/_inbox/ 为未归类收件箱
│   ├─ derived/<id前2位>/<id>.thumb.webp|.preview.webp   派生图
│   ├─ branding/icon               自定义站点图标
│   └─ tmp/                        上传/导入临时文件(每小时清理 6h 前遗留)
└─ src/
   ├─ instrumentation.ts           服务启动钩子:触发 ensureReady()
   ├─ db/
   │   ├─ index.ts                 pg Pool + drizzle 实例(导出 db、pool)
   │   ├─ schema.ts                表结构定义(5 张表,见 §5)
   │   └─ bootstrap.ts             幂等建表 DDL(带 advisory lock)。改 schema 必须同步改这里
   ├─ lib/                         前后端共用的纯函数(无 IO)
   │   ├─ theme.ts                 主题预设 PRESETS、themeCss()、DEFAULT_THEME
   │   ├─ api.ts                   浏览器 fetch 封装:api<T>() 自动解包信封,错误抛 ApiErr
   │   ├─ format.ts                bytes/duration/dateTime/dayLabel 格式化
   │   └─ meta-labels.ts           元数据字段中文标签表(决定 UI 显示哪些字段)
   ├─ server/                      **全部服务端逻辑**(详见 §6)
   │   ├─ config.ts                唯一的环境变量读取点,导出 config 与 dirs
   │   ├─ http.ts                  ApiError / E 工厂 / json / ok / fail / readJson / str / intParam / boolParam
   │   ├─ router.ts                迷你路由器:route(method, pattern, access, handler)、dispatch()
   │   ├─ auth.ts                  角色权限矩阵、密码哈希、令牌、请求鉴权、env 管理员同步、登录限流
   │   ├─ settings.ts              站点设置(单 JSON,key="site")读写与校验、publicSite()
   │   ├─ ready.ts                 ensureReady():建表→建目录→同步管理员→恢复队列→定时器
   │   ├─ albums.ts                相册树缓存、可见性、统计、创建/挂载/改/删、目录扫描
   │   ├─ keys.ts                  下载密钥:创建(upsert)/列表/删除/验证/过期清理
   │   ├─ files.ts                 serveMedia():thumb/preview/file/stream 的授权与输出(Range/ETag)
   │   ├─ queue.ts                 进程内任务队列(THUMB_CONCURRENCY)+ limiter()
   │   ├─ storage/index.ts         存储驱动抽象:local / ext / s3,materialize()
   │   ├─ media/
   │   │   ├─ types.ts             扩展名→kind/mime、safeName、randomId
   │   │   ├─ upload.ts            parseUpload():流式 multipart → 临时文件
   │   │   ├─ ingest.ts            resolveTarget()、ingestOne()、collectFiles()/copyToTmp()
   │   │   ├─ derive.ts            processMedia():派生图 + 元数据入库;derivedPath/removeDerived
   │   │   ├─ metadata.ts          extractImageMeta()、probeVideo()、grabVideoFrame()、buildSearchText()
   │   │   ├─ png.ts               PNG 文本块读取、隐写(alpha LSB)提取
   │   │   ├─ ai.ts                AI 生成参数解析(A1111/NovelAI/ComfyUI/InvokeAI)
   │   │   └─ service.ts           listMedia()、mediaDetail()、updateMedia()、batchAction()、可见性判断
   │   └─ api/                     路由注册模块(导入即注册)
   │       ├─ index.ts             汇总导入
   │       ├─ auth.ts              /auth/*  /site  /branding/icon  /settings*
   │       ├─ albums.ts            /albums*  /fs/browse
   │       ├─ media.ts             /media*  /system/reprocess  /media-timeline
   │       └─ admin.ts             /keys*  /users*  /health  /status*
   ├─ app/
   │   ├─ layout.tsx               根布局:注入主题 <style id="pgs-theme">、站点图标 metadata、Splash、AppProvider
   │   ├─ globals.css              CSS 变量兜底、毛玻璃(.glass)、按钮/输入样式、启动页 3D 动画
   │   ├─ (app)/layout.tsx         带 Shell 的页面分组
   │   ├─ (app)/page.tsx           首页:全局图库 + 全局搜索(?q=)
   │   ├─ (app)/albums/page.tsx    顶层相册列表
   │   ├─ (app)/albums/[code]/page.tsx   相册详情(子相册 + 图库 + 相册内搜索);code=_unsorted 为未归类
   │   ├─ (app)/settings/page.tsx  设置页
   │   ├─ login/page.tsx           登录页
   │   ├─ f/[id]/route.ts          公开文件链接 /f/<id>[.ext][?key=][&dl=1]
   │   ├─ api/health/route.ts      平台健康检查(DB select 1)
   │   └─ api/v1/[[...path]]/route.ts   REST 入口:全部转交 server/router.dispatch
   └─ components/                  前端组件(全部 "use client",除特别说明)
       ├─ AppProvider.tsx          上下文:me(user/perms/site/features)、can(perm)、reload()
       ├─ Splash.tsx               启动页:粒子 canvas + 3D 光环 + 3D 挤出文字;url 模式支持图片/视频/iframe
       ├─ Shell.tsx                毛玻璃顶栏、导航、搜索框(相册页自动限定范围)、上传入口、账户菜单
       ├─ Gallery.tsx              等高行图库、游标无限滚动、按日期分组、处理中轮询;导出 MediaItem
       ├─ Viewer.tsx               全屏查看器:媒体、文件链接、备注编辑、元数据侧栏、删除/重处理
       ├─ MetaPanel.tsx            元数据渲染(固定字段缺失显示 N/A、AI 区块、原始段折叠)
       ├─ UploadDialog.tsx         上传对话框:相册下拉、存储选择、并发、进度、结果去向提示
       ├─ AlbumsView.tsx           相册列表/详情页的客户端主体、相册卡片
       ├─ AlbumActions.tsx         相册操作按钮组(新建子相册/重命名/公开私有/重扫/删除),导出 AlbumDto
       ├─ LoginForm.tsx            登录表单
       └─ settings/
           ├─ SettingsView.tsx     设置页标签容器(按权限显示标签)
           ├─ AppearanceTab.tsx    站点名/图标上传/主题/明暗/启动页/游客开关,主题实时预览
           ├─ AdminTabs.tsx        导出 AlbumManager(含目录挂载对话框)/KeysTab/UsersTab
           └─ SystemTab.tsx        系统状态面板(3 秒轮询)+ 重处理按钮
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
- `GET /media?q=&album=<code>` → **只在该相册内**(默认含子相册;`recursive=0` 仅限该相册自身)。
- 前端:`Shell.tsx` 依据路径 `/albums/<code>` 自动把搜索限定为当前相册,并显示"当前相册/全局"标签。
- 匹配:空格分词,每个词都必须出现(AND),对 `search_text`(小写的 文件名 + 备注 + 相机/镜头/软件 + 标题/描述/作者/关键词 + AI 提示词/模型)做 `LIKE %词%`。

### 4.5 角色与权限矩阵

权限字符串(`Perm`)定义在 `server/auth.ts`,路由注册时指定所需权限。

| 权限 | admin | manager | uploader | viewer | 游客 |
|---|:-:|:-:|:-:|:-:|:-:|
| `browse.private` 浏览私有相册 | ✓ | ✓ | ✓ | ✓ | ✗ |
| `upload` 上传 | ✓ | ✓ | ✓ | ✗ | ✗ |
| `media.edit` 备注/移动/重处理 | ✓ | ✓ | ✗ | ✗ | ✗ |
| `media.delete` 删除文件 | ✓ | ✓ | ✗ | ✗ | ✗ |
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

**pgs_users**:`id`(uuid 文本,PK) `username`(唯一) `password_hash`(`scrypt$salt$hash`) `role` `disabled` `source`(`env|api`) `created_at` `last_login_at`

**pgs_albums**:`id`(PK) `code`(唯一,对外使用) `name` `description` `parent_id` `kind`(`managed|mounted`) `storage`(`local|s3|ext`) `root_path`(挂载目录,唯一) `visibility` `cover_media_id` `sort_order` `last_scan_at` `created_at` `updated_at`;索引:`parent_id`、`root_path` 唯一。

**pgs_media**:`id`(12 位随机,PK) `album_id`(null=未归类) `kind`(`image|video`) `filename` `mime` `size` `width` `height` `duration`(秒) `taken_at` `sort_at`(= taken_at ?? 文件时间/上传时间,排序与游标依据) `storage` `storage_key` `hash`(SHA-256,上传才有) `color`(平均色,占位用) `status`(`pending|ready|failed`) `error` `note`(管理员备注) `meta`(jsonb,见 §7.3) `search_text` `uploaded_by` `created_at`;索引:`(sort_at,id)`、`(album_id,sort_at,id)`、`(storage,storage_key)` 唯一、`hash`、`status`。

**pgs_download_keys**:`id` `key_hash`(SHA-256,唯一) `hint`(前 2 位 + `*`) `label` `expires_at`(null=永不) `created_by` `created_at` `last_used_at` `use_count`。

**pgs_settings**:`key`(PK) `value`(jsonb) `updated_at`。目前只有 `key="site"`,内容为 `SiteSettings`(见 `server/settings.ts`):`siteName, theme{preset,mode,accent,background}, splash{enabled,mode,url,durationMs,title}, iconVersion, iconMime, guestBrowse`。

> 修改表结构:① 改 `schema.ts` ② 同步改 `bootstrap.ts` 的 DDL(`npx drizzle-kit export --sql` 可对照)③ 开发库可 `npx drizzle-kit push`。已发布版本的字段变更需在 `bootstrap.ts` 追加 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`。

## 6. 服务端模块黑盒契约

> 只列"暴露的接口 + 契约",实现细节请直接读对应文件。

### 6.1 `config.ts`
导出 `config`(只读,见 §10 全部环境变量)与 `dirs`(`albums/derived/tmp/branding` 绝对路径)。**其它文件不得直接读 `process.env`**。

### 6.2 `http.ts`
- `ApiError(status, code, message)`,工厂 `E.badRequest/unauthorized/forbidden/notFound/conflict/tooMany`。
- `ok(data, init?)` → `{ok:true,data}`;`fail(err)` → `{ok:false,error:{code,message}}`(非 ApiError 记录日志并返回 500 `internal_error`)。
- 入参助手:`readJson(req)`、`str(v,name,{max,optional})`、`intParam(v,def,min,max)`、`boolParam(v,def)`。

### 6.3 `router.ts`
- `route(method, "/path/:param", access, handler)`;`access` ∈ `"public" | "user" | Perm`。
- `handler(ctx)`,`ctx = {req, url, q(URLSearchParams), params, user|null, ip}`;返回 `Response` 原样输出,否则自动包装为 `ok(返回值)`。
- `dispatch(req, pathParts)`:`await ensureReady()` → 匹配 → 鉴权 → 调用 → 统一错误处理;路径存在但方法不符返回 405。
- **新增接口只需在 `server/api/*.ts` 里 `route(...)`**,新文件要在 `api/index.ts` 里 import。

### 6.4 `auth.ts`
- `can(user, perm)`、`permsOf(user)`、`ROLES`、`isRole`。
- `hashPassword / verifyPassword`(scrypt)、`validatePasswordStrength`(≥8 位)。
- `signToken/verifyToken`(`base64url(payload).hmac`)、`issueSession(userId)`、`sessionCookie/clearCookie`、`issueStreamToken/verifyStreamToken`。
- `authenticate(req)`:依次尝试 `Authorization: Bearer <token>` → `Authorization: Basic base64(user:pass)` → Cookie `pgs_session`;返回 `AuthUser|null`。Basic 成功结果缓存 60 秒,用户对象缓存 15 秒(`invalidateUserCache()` 清除)。
- `syncEnvAdmin()`:启动时把 `ADMIN_USER/ADMIN_PASSWORD` 同步到 `source=env` 的账户(改 .env 重启即生效)。
- `checkLoginRate / recordLoginFailure / clearLoginFailures`:按 IP,10 分钟内失败 10 次后 429。

### 6.5 `settings.ts`
`getSite()`(5 秒内存缓存)、`patchSite(patch)`(校验:主题预设白名单、`#RRGGBB`、启动页 URL 必须 `https://`、时长 800~20000ms)、`setIcon(version,mime)`、`publicSite(s)`(面向游客的子集,含 `iconUrl`)。

### 6.6 `albums.ts`
- 树缓存:`loadTree()`(10 秒 TTL,任何写操作后调用 `invalidateAlbums()`),`descendants / breadcrumbs / effectivelyPublic`。
- 可见性:`visibleIds(user)` → `{t, allowed: Set|null}`(`null`=不受限);`resolveAlbum(code,user)`(不可见抛 404);`scopeIds(t, album, recursive, allowed)`。
- 展示:`listAlbums(user, parent?)`、`albumDetail(code,user)`、`albumStatus(code,user)`、`albumDtos`(含 5 秒统计缓存:每相册计数/体积/处理中/失败、封面)、`unsortedCount()`。`rootPath` 仅对具备 `album.mount` 的用户返回。
- 变更:`createManaged`、`mountDir`、`updateAlbum`(`cascade:true` 时可见性级联到子孙)、`deleteAlbum({media:'move'|'delete', purge})`、`deleteMediaByIds(ids, purge)`。
  - 删除挂载相册:只删登记与记录,不动磁盘文件(`purge=true` 才物理删除)。
  - 删除受管相册:`media=move` 把文件上移到父相册(根级则变未归类);`media=delete` 连文件删除;子相册上移。
- 扫描:`scanAlbum(code, recursive)`:读取目录 → 子目录自动建嵌套相册(跳过 `.`/`@eaDir`/`#recycle`/`node_modules` 等)→ 新文件批量插入 `pending` 并入队 → 大小变化的文件重新入队 → 磁盘上已消失的文件删除记录(若根目录不可访问则中止并保留记录,防止卸载盘误删)。状态在 `scanStates`。
- `browseDirs(path)`、`assertMountAllowed(abs)`(受 `ALLOWED_MOUNT_ROOTS` 约束)、`scanAllMounted()`(`SCAN_INTERVAL_MIN` 定时器调用)。

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
  - `collectFiles / copyToTmp`:服务器路径导入使用。
- `derive.ts`:`processMedia(id)`(队列 runner)、`derivedPath(id, 'thumb'|'preview')`、`removeDerived`、`hintLocalCopy`。
- `metadata.ts`、`png.ts`、`ai.ts`:见 §7.3。
- `service.ts`:`listMedia`(游标分页、可见性、范围、搜索)、`getVisible`、`canSee`、`mediaDetail`、`updateMedia`、`batchAction`、`reprocessFailed`、`baseUrl`。

### 6.9 `keys.ts`
`createKey({key?,label?,expires:'never'|'24h'|'custom',ttlHours?,createdBy})`(相同密钥重复提交 = 更新标签与有效期)、`listKeys`、`deleteKeyById`、`deleteKeyByValue`、`verifyKey(key, countUse)`(过期即惰性删除)、`purgeExpiredKeys()`(每小时定时)。明文密钥只在创建响应里出现一次。

### 6.10 `files.ts`
`serveMedia(req, id, variant, user)`,`variant ∈ thumb|preview|file|stream`,实现 §4.3 的授权表;派生图带 `ETag` 与 `Cache-Control`(游客可公共缓存,登录态 private);派生图未生成时返回占位 SVG(`x-pgs-state: processing`,不缓存);原文件支持 `Range`(206/416)与 `Content-Disposition`(`dl=1` 为 attachment)。

### 6.11 `queue.ts` 与 `ready.ts`
- `enqueue(id, priority?)`(同 id 去重)、`queueStats()`、`idle(timeout)`、`limiter(n)`。并发上限 = `THUMB_CONCURRENCY`(默认 15);`sharp.concurrency(2)` 限制单任务线程。
- `ensureReady()`:进程内只执行一次(失败会重试):`runBootstrap` → 建 `dirs` → `syncEnvAdmin` → `setRunner(processMedia)` → 把所有 `status=pending` 记录重新入队 → 启动每小时定时器(过期密钥、tmp 清理)与可选的挂载相册定时重扫。

## 7. 关键流程

### 7.1 上传 / 入库
```
POST /media/upload  (multipart)
  parseUpload → 临时文件+sha256
  resolveTarget(album|dir|storage)
  对每个文件(limiter(concurrency)): ingestOne
     去重 → uniqueKey → driver.put → INSERT pending → enqueue(priority)
  返回 {target:{album,albumName,storage}, summary, results[]}
后台: processMedia(id) → 生成派生图 + 元数据 → status=ready
```
上传的文件落在哪:响应 `target` 明确给出相册与存储;前端上传对话框在选择相册时显示"将保存到"的路径,完成后提示"已上传到「相册名」"并提供跳转。未选择相册 → "未归类(收件箱)",登录用户在「全部」与「相册 → 未归类」中可见。

### 7.2 派生图
`processMedia`:取得本地路径(`materialize`/本地副本提示)→ 图片:HEIC 先转 JPEG;`sharp.rotate()` 自动方向,生成 **preview**(宽≤`PREVIEW_WIDTH`,webp q82)与 **thumb**(宽≤`THUMB_WIDTH`,webp q78,由 preview 缩小得到,避免二次解码原图),并计算平均色;视频:`ffprobe` 取信息 → `ffmpeg` 抽帧(1s 或时长一半)→ 同样生成派生图,无 ffmpeg 时使用占位图。完成后写回尺寸/时长/拍摄时间(→ `sort_at`)/颜色/`meta`/`search_text`/`status=ready`;异常置 `failed` 并记录 `error`。

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
| GET `/auth/me` | public | — | `{user|null, perms[], site, features:{s3,thumbConcurrency}}` |
| POST `/auth/password` | user | `{oldPassword,newPassword}` | 修改自己的密码(env 管理员不可) |
| GET `/site` | public | — | 公开站点配置 `{siteName,theme,splash,iconUrl,guestBrowse}` |
| GET `/branding/icon` | public | — | 站点图标(自定义或内置 SVG) |
| GET `/settings` | settings | — | 完整 `SiteSettings` |
| PUT `/settings` | settings | body 补丁:`siteName`、`guestBrowse`、`theme{preset,mode(light|dark|auto),accent,background}`、`splash{enabled,mode(builtin|url),url(https),durationMs,title}` | 返回合并后的设置。预设:`claude ocean forest rose violet mono` |
| POST `/settings/icon` | settings | multipart,任意字段名的一个文件(PNG/JPG/WebP/SVG,≤2MB) | 光栅图统一转 256×256 PNG;SVG 原样保存并以严格 CSP 输出。返回 `{iconUrl}` |
| DELETE `/settings/icon` | settings | — | 恢复默认图标 |

### 8.3 相册

| 方法 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|
| GET `/albums` | public | `parent=<code|root>` 限定层级;`tree=1` 返回嵌套树(`children`) | `{albums[], unsorted}`(`unsorted` 仅登录用户为数字);只含可见相册 |
| POST `/albums` | album.manage | `{name, parent?, visibility?(public|private,默认private), description?, storage?(local|s3), sortOrder?}` | **创建受管相册**(local 会在 `DATA_DIR/albums/<code>/` 建目录)。201,返回相册详情;代码 `alb_xxxxxxxx` |
| POST `/albums/mount` | album.mount | `{path(绝对路径), name?, parent?, recursive?=true, visibility?, scan?=true}` | **挂载服务器目录**为相册,默认立即异步扫描,子目录自动生成嵌套子相册;受 `ALLOWED_MOUNT_ROOTS` 约束。201 |
| GET `/fs/browse` | album.mount | `path` | `{path,parent,dirs[]}`,挂载对话框使用 |
| GET `/albums/:code` | public | — | 详情:`breadcrumbs[]`、`children[]`、`counts`、`rootPath`(仅特权) |
| GET `/albums/:code/status` | public | — | 相册状态:计数(`media/images/videos/size/mediaTotal/sizeTotal/pending/failed/children`)、`scan` 状态、`descendants` 数 |
| PATCH `/albums/:code` | album.manage | `{name?, description?, visibility?, sortOrder?, cover?(mediaId), parent?(code|null), cascade?(bool, 与 visibility 同用→子孙同步)}` | 修改;移动到自己子孙下会 400 |
| DELETE `/albums/:code` | album.manage | `media=move|delete`(默认 move)、`purge=0|1` | 挂载相册仅管理员可删,只解除登记(`purge=1` 才删磁盘文件) |
| POST `/albums/:code/scan` | album.mount | `recursive=1`、`wait=0|1` | 重新扫描挂载相册;`wait=1` 同步返回 `{added,removed,updated,albumsCreated}` |

相册 DTO:`{code,name,description,parent,kind,storage,rootPath,visibility,effectivePublic,coverId,sortOrder,counts{...},lastScanAt,createdAt}`。

### 8.4 媒体

| 方法 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|
| GET `/media` | public | `album`(相册代码或 `_unsorted`)、`q`(搜索)、`kind=image|video`、`recursive=1|0`(相册范围含子相册,默认 1)、`cursor`、`limit`(1-200,默认 60)、`order=desc|asc`、`from`/`to`(ISO 时间) | **列表 + 搜索**。无 `album` = 全局;有 `album` = 限定该相册。返回 `{items[], nextCursor}`(游标 = `(sort_at,id)` 键集分页) |
| GET `/media/:id` | public | — | 详情:列表字段 + `note, error, meta, storage, createdAt, breadcrumbs, canEdit, canOriginal, links{file,thumb,preview,originalTemplate,html,markdown}, streamUrl`;`storageKey/hash` 仅特权可见 |
| PATCH `/media/:id` | media.edit | `{note?(≤5000), album?(code|null)}` | 改备注(只存库,不写原文件)/ 移动相册 |
| DELETE `/media/:id` | media.delete | `purge=0|1` | 受管/S3 文件总是连原文件删除;`ext`(挂载目录)文件仅 `purge=1` 才删磁盘文件 |
| POST `/media/batch` | media.edit(delete 需 media.delete) | `{action: delete|move|reprocess, ids[1..2000], album?, purge?}` | 批量 |
| POST `/media/:id/reprocess` | media.edit | — | 重新生成派生图与元数据 |
| POST `/system/reprocess` | media.edit | — | 重新入队所有 `failed/pending` |
| POST `/media/upload` | upload | multipart(多文件,字段名任意)。参数可放 query 或表单字段:`album`、`dir`、`storage`(local|s3)、`concurrency`(1..THUMB_CONCURRENCY,默认 4)、`duplicate`(skip|keep,默认 skip)、`note`(需 media.edit) | 见 §7.1。全部失败返回 422;`dir` 须位于已挂载目录内 |
| POST `/media/import` | album.mount | `{paths[]|path, album|dir|storage, recursive?=true, concurrency?, duplicate?, note?}` | 把**服务器本地**文件/目录**复制**导入目标;返回统计与前 200 条失败项 |
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
| POST `/keys` | keys | `{key?(8-128位 [A-Za-z0-9_-],省略则自动生成), label?, expires: never|24h|custom, ttlHours?}` | **设置密钥**;明文仅在此响应返回一次;相同密钥重复提交 = 更新有效期。24h/custom 到期自动删除 |
| DELETE `/keys/:id` | keys | — | 按 id 删除 |
| DELETE `/keys?key=<明文>` | keys | — | 按明文删除 |
| GET `/keys/verify?key=` | keys | — | `{valid}`(不计数) |

### 8.6 用户

| 方法 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|
| GET `/users` | users | — | `{users[], roles[]}` |
| POST `/users` | users | `{username(3-32 位 [A-Za-z0-9_.-]), password(≥8), role: admin|manager|uploader|viewer}` | 创建,201 |
| PATCH `/users/:id` | users | `{role?, disabled?, password?}` | env 管理员不可改角色/禁用/密码;不能禁用自己 |
| DELETE `/users/:id` | users | — | env 管理员与自己不可删 |

### 8.7 系统

| 方法 路径 | 权限 | 说明 |
|---|---|---|
| GET `/health` | public | `{status:"ok",version}`(同时存在平台用 `/api/health`) |
| GET `/status` | status | 版本、运行时长、计数(总数/图/视频/待处理/失败/未归类/字节/相册/用户/密钥)、队列、工具可用性(ffmpeg/ffprobe/s3)、内存、磁盘、关键配置 |
| GET `/status/queue` | status | `{concurrency,running,waiting,done,failed}` |

### 8.8 curl 示例
```bash
A="-u admin:密码"; B=http://127.0.0.1:3000/api/v1
curl $A -X POST $B/albums -H 'content-type: application/json' -d '{"name":"旅行","visibility":"public"}'
curl $A -X POST $B/albums/mount -H 'content-type: application/json' -d '{"path":"/srv/photos","name":"外部相册"}'
curl $A -X POST "$B/media/upload?album=alb_xxxxxxxx&concurrency=8" -F f=@a.jpg -F f=@b.mp4
curl $A -X POST "$B/media/upload?dir=/srv/photos/2024/trip" -F f=@c.jpg      # 指定挂载目录内的子目录
curl $A -X POST $B/keys -H 'content-type: application/json' -d '{"key":"my-secret-key","expires":"24h"}'
curl -o orig.jpg "http://host:3000/f/<id>?key=my-secret-key"                  # 原图;去掉 key 则得到预览图
curl -G "$B/media" --data-urlencode "q=日落" --data-urlencode "album=alb_xxxxxxxx"   # 相册内搜索
curl $A -X POST $B/users -H 'content-type: application/json' -d '{"username":"bob","password":"password123","role":"viewer"}'
curl $A $B/albums/alb_xxxxxxxx/status
```

## 9. 支持的文件类型
图片:`jpg jpeg png gif webp avif bmp tif tiff heic heif hif`(GIF 仅取首帧;HEIC 由 `heic-convert` 解码)。
视频:`mp4 m4v mov webm mkv avi wmv flv 3gp mpg mpeg ts`(封面/元数据依赖 ffmpeg/ffprobe,浏览器能否播放取决于编码)。
增减类型:改 `server/media/types.ts` 的 `IMAGE_EXT / VIDEO_EXT`,并同步 `cli/pgs.mjs` 的 `EXT`。

## 10. 环境变量(`.env`)

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | — | **必填** PostgreSQL 连接串 |
| `PORT` | 3000 | 服务端口(`next start` 直接读取) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / `admin123456` | 超级管理员;每次启动同步到数据库,改密码改这里重启即可 |
| `SESSION_SECRET` | 由管理员密码派生 | 令牌签名密钥,生产务必设置 32+ 位随机串 |
| `SESSION_DAYS` | 30 | 登录令牌有效天数 |
| `COOKIE_SECURE` | false | HTTPS 反代后设为 true |
| `PUBLIC_BASE_URL` | 空 | 生成文件链接用的对外地址(空则取请求头 `x-forwarded-*`/`host`) |
| `DATA_DIR` | `./data` | 数据目录 |
| `THUMB_CONCURRENCY` | 15 | 缩略图/预览图/元数据任务最大并发(1-128) |
| `THUMB_WIDTH` / `PREVIEW_WIDTH` | 480 / 1600 | 派生图最大宽度 |
| `MAX_UPLOAD_MB` | 0 | 单文件上限,0=不限 |
| `ALLOWED_MOUNT_ROOTS` | 空 | 逗号分隔白名单,限制可挂载/导入/`dir` 上传的路径 |
| `SCAN_INTERVAL_MIN` | 0 | 挂载相册自动重扫间隔(分钟),0=关闭 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | 视频工具路径 |
| `S3_BUCKET` `S3_REGION` `S3_ENDPOINT` `S3_ACCESS_KEY` `S3_SECRET_KEY` `S3_FORCE_PATH_STYLE` `S3_PREFIX` | — | 配置 `S3_BUCKET` 即启用对象存储 |

## 11. 命令行(`cli/pgs.mjs`)

零依赖,Node ≥ 18。认证:`PGS_URL` `PGS_USER` `PGS_PASSWORD`(或 `--url --user --password`)。

```
node cli/pgs.mjs status
node cli/pgs.mjs album list [--tree] | info <code> | status <code>
node cli/pgs.mjs album create <名称> [--parent 代码] [--public] [--storage local|s3]
node cli/pgs.mjs album mount <绝对路径> [--name 名] [--parent 代码] [--public] [--no-recursive]
node cli/pgs.mjs album set <code> [--name] [--public|--private] [--cascade] [--parent 代码|root]
node cli/pgs.mjs album rm <code> [--delete-media] [--purge]      |  album scan <code> [--wait]
node cli/pgs.mjs upload <文件/目录...> [--album 代码|--dir /绝对路径] [--storage local|s3] [-c 并发] [--duplicate skip|keep] [--note 文本] [-r]
node cli/pgs.mjs import <服务器路径...> [--album|--dir|--storage] [-c 并发]
node cli/pgs.mjs media list|get|note|rm|move|reprocess ...
node cli/pgs.mjs key list | key set [--key K] [--ttl never|24h|<小时>] [--label L] | key rm <id> | key rm --key K
node cli/pgs.mjs user list | add <名> --pw 密码 [--role r] | set <名> [--role r] [--pw p] [--disable|--enable] | rm <名>
node cli/pgs.mjs settings get | set '<JSON>' | icon <文件> | icon-reset
node cli/pgs.mjs reprocess
```
`upload -c N` 为客户端并发请求数(每请求一个文件),服务端另有 `THUMB_CONCURRENCY` 兜底。新增 API 后,同步在 CLI 的 `main()` switch 里加子命令。

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
| 新增主题预设 | `lib/theme.ts#PRESETS`(自动出现在设置页) |
| 改启动页 | `components/Splash.tsx`;动画 CSS 在 `app/globals.css`;配置项在 `server/settings.ts` |
| 改图库布局 | `components/Gallery.tsx#justify` |
| 改上传界面 | `components/UploadDialog.tsx`;服务端 `api/media.ts` + `media/ingest.ts` |
| 加数据库字段 | §5 的三步流程 |
| 改端口 / 管理员 / 并发 | `.env`,无需改代码 |

## 13. 前端约定

- 根布局注入 `<style id="pgs-theme">`(`themeCss()`),设置页修改主题时直接替换其 `textContent` 实现实时预览;保存后全站生效。CSS 变量:`--bg --bg2 --surface --fg --muted --accent --accent-fg --border`;毛玻璃类 `.glass / .glass-strong`;按钮 `.btn / .btn-primary / .btn-danger`;输入 `.field`。
- 全局事件(`window.dispatchEvent`):`pgs:changed`(媒体变更,图库刷新)、`pgs:albums`(相册变更,相册视图刷新)。
- 登录态与权限来自 `AppProvider`(`/auth/me`)。页面是否展示管理控件只做体验层判断,**真正的授权永远在服务端 `route()` 的 access 参数**。
- 图库使用游标分页 + `IntersectionObserver` 无限滚动,等高行布局,`content-visibility:auto` 降低长列表渲染成本;存在 `pending` 项时每 3 秒轮询前 80 项状态。
- 启动页每个标签页会话只显示一次(`sessionStorage["pgs-splash"]`);`url` 模式按扩展名选择 `<img>`/`<video>`/`<iframe sandbox="allow-scripts">`。

## 14. 性能与安全设计要点

- 上传全程流式,不进内存;SHA-256 边写边算;派生任务受 `THUMB_CONCURRENCY` 约束;`sharp.cache(false)` 避免缓存膨胀;缩略图由预览图再缩小,避免二次解码大图。
- 列表走键集分页 `(sort_at,id)` 与复合索引;相册树与统计在内存短时缓存,写操作主动失效;游客可见性判断为内存集合运算。
- 派生图 `ETag` + 缓存头,原文件 `no-store`;所有 S3 访问懒加载 SDK。
- 密码 scrypt;下载密钥只存哈希;令牌 HMAC 常量时间比较;登录按 IP 限流;`local` 存储路径防穿越;自定义图标光栅化重编码、SVG 以 `sandbox` CSP 输出;媒体 `Content-Type` 来自扩展名白名单且附带 `nosniff`。
- 已知边界:播放令牌 + `Sec-Fetch-Dest` 校验只能防"直接下载",无法阻止录屏/抓包;进程内队列在多实例部署时各自独立(多实例需外置队列);限流与缓存为单进程内存。

## 15. 开发与验证

```bash
npm install
cp .env.example .env            # 填写 DATABASE_URL 等
npm run dev                     # 开发
npx next typegen && npx tsc --noEmit && npm run build   # 提交前校验
```
端到端冒烟:启动后依次验证 `POST /albums` → `POST /media/upload` → `GET /media?q=` → `GET /f/:id`(无 key=预览,有 key=原图)→ `POST /keys` → 游客访问私有相册应 404。
