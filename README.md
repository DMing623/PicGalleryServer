# PicGalleryServer

[![构建](https://github.com/DMing623/PicGalleryServer/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/DMing623/PicGalleryServer/actions/workflows/docker-publish.yml)
[![许可证:非商业](https://img.shields.io/badge/License-PolyForm--Noncommercial--1.0.0%20(Noncommercial)-blue.svg)](./LICENSE)

自托管的图片与视频相册服务。把照片和视频放在自己的服务器上,用漂亮的毛玻璃界面浏览、搜索、分享,并且原图受保护。

> ⚠️ **许可证**:本项目采用 **PolyForm Noncommercial License 1.0.0** —— 源码公开,可自由使用、修改与再分发,但**仅限非商业用途**;修改后再分发必须保留本项目的归属声明(`Required Notice:`)与许可证副本。注意这**不是开源许可证**(开源不允许限制商业用途),准确说法是「非商业许可」。完整条款见 [LICENSE](./LICENSE)。

## ✨ 功能

- **相册分类 + 嵌套相册**:可在数据目录里新建相册;也可以把 VPS 上任意位置的绝对路径目录"挂载"为相册,子目录自动变成嵌套子相册,原文件不搬家。
- **本地 / 对象存储**:原文件可放在服务器本地,也可放在 S3 兼容的对象存储。
- **自动缩略图与预览图**:生成速度可控(并发数可在 `.env` 配置,默认 `min(4, CPU 核数)`),不会把 CPU 和内存打满。
- **详尽元数据**:相机型号/镜头/光圈快门 ISO/GPS/时间等 EXIF 信息;PNG 文本信息;Stable Diffusion、NovelAI、ComfyUI 等 AI 生成图的提示词与参数;视频编码、分辨率、码率等。详情页只显示文件里实际存在的字段(名称/备注/分辨率/相册/ID/上传时间/格式为必备条目)。
- **文件链接**:每张图片/视频下方都有可复制的文件链接(直链、HTML、Markdown),可嵌入博客。
- **管理员备注**:管理员可为任意图片/视频添加备注(只保存在数据库,不改动原文件),游客只读。
- **搜索**:首页是全局搜索;在某个相册内搜索只会搜索该相册自身(子相册的文件只在其子相册中显示,不会在父相册重复出现)。
- **原文件保护**:游客只能浏览管理员"公开"的相册;网页和文件链接默认只返回缩略图/预览图,视频无法下载;只有在链接后追加管理员设置的**下载密钥**(可选永久或 24 小时后自动失效并删除)才能获取服务器上的原图和原分辨率视频。
- **多用户与权限**:管理员 / 管理者 / 上传者 / 查看者四个级别;游客不能上传。
- **炫酷界面**:重构级电影感启动页(深空体积极光 + 3D 景深星轨粒子 + 精密光学星盘 + 宽银幕变形眩光 + 多轴 3D 陀螺星环 + 支持任意中英文/符号替换且自动适配字号的逐字快门翻转 3D 流光立体主标题/副标题与镜面反射,也可换成你自己的 https 图片/视频/网页链接),毛玻璃质感主页;主题配色可在设置里调整,默认经典 Claude 配色;支持上传自定义站点图标。
- **完整 API 与命令行**:所有操作都能通过 HTTP API 或命令行完成。

* **高清预览与防盗图**:点击图片按屏幕分辨率加载无元数据的高清 WebP(最大 2560px,按需生成 + LRU 临时缓存),支持滚轮/双击/双指缩放;服务端合成来源水印(`Source: {域名} · github.com/DMing623/PicGalleryServer`,登录用户另有动态标识),短期令牌 + 独立限流 + 异常检测,不影响原图下载密钥体系。配置见 `.env.example` 的 `HD_*`。
* **站点通知**:顶部栏铃铛(有未读时右上角小红点)打开覆盖式通知面板,背后相册自动虚化;面板顶部「一键已读」,下方长条显示未读数并可下拉选择日期(有未读的日期会轻微闪烁变色),同一天多条通知以时间折叠展示。通知内容支持 **Markdown**,由管理者及以上在 设置 → 通知发布 里撰写(带实时预览)。默认展示安全隐私协议(默认已读,无需再次同意)。
* **时区可配置**:设置 → 系统状态 里可切换站点时区(默认 `Asia/Shanghai`,容器可用 `TZ` 环境变量指定);通知发布时间与日期分组都按该时区换算,改时区后历史通知的显示时间同步变化。
* **直链上传**:上传对话框可在「本地文件」与「直链上传」间切换;直链模式把拖拽区换成多行输入框,一行一个图片/视频 URL(可省略 `https://`),服务器下载后入库。带 SSRF 防护(拒绝内网地址)、重定向与体积限制。
* **双数据库驱动**:默认 PostgreSQL;设置 `DB_DRIVER=sqlite` 即可改用 Node 内置 SQLite 单文件存储,零外部服务,适合手机本地测试或图片数量不多的个人图库。
* **PWA**:可安装到手机主屏幕;**免责声明**:首次进入需阅读并同意后才显示相册。
* **隐私与索引控制**:游客默认只看到基础元数据(GPS、机身序列号、作者邮箱等不下发,可用 `GUEST_META` 调整);管理员备注不参与公开搜索;自带 `robots.txt`(默认禁止索引)且图片响应带 `X-Robots-Tag: noindex`。
* **挂载目录只读**:挂载相册默认只读,本系统不会上传/移动/删除其中的文件;路径会先 `realpath` 再校验白名单,并拒绝嵌套重叠挂载。
* **删除黑名单(可反悔的删除)**:详情页删除时默认只把文件"排除"出本项目(源文件留在服务器上,挂载目录重新扫描也不会再入库);只有勾选"同时删除服务器上的原文件"才会真正删除。被排除的记录集中在 设置 → 删除黑名单,可一键解除(恢复记录并重新生成缩略图)或彻底删除源文件。该页面仅管理者及以上可见。

> 反向代理请对 `/api/v1/media/*/hd*` 关闭缓存并透传真实 IP,示例见下方「反向代理(HTTPS)」。

## 🚀 部署

### 推荐部署方式(结论先行)

**只推荐一种:Docker Compose + 流水线镜像 + 反向代理。**

| 部署方式 | 是否推荐 | 原因 |
|---|---|---|
| Docker Compose(方式一) | ✅ **推荐** | 镜像内置 `jemalloc` 与 `MALLOC_ARENA_MAX=2`,内存碎片可控;`tini` 负责信号转发与僵尸回收;非 root 运行;数据库与应用同编排、健康检查联动 |
| 本地构建镜像(方式二) | ⚠️ 仅用于改代码 | 与方式一运行环境相同,但每次升级都要在服务器上编译,耗时且占磁盘 |
| 直接运行 `npm start`(方式三) | ⚠️ 仅用于开发调试 | **缺少 jemalloc**,glibc 内存碎片会让 RSS 在压测后不回落(实测裸机峰值 2.49GB 且不释放,容器内峰值 1.90GB 且静置回落到 0.71GB);也没有 `tini`,进程管理需自理 |

> 若确实必须裸机运行,请至少设置 `LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2`(或 `MALLOC_ARENA_MAX=2`)并降低 `THUMB_CONCURRENCY` / `HD_CONCURRENCY`,否则小内存机器容易触发 OOM。

### 方式一:Docker Compose(推荐,直接使用流水线构建好的镜像)

仓库已接入 GitHub Actions 自动构建镜像,**无需在服务器上自行构建**,直接拉取即可:

```bash
git clone <本仓库地址> picgalleryserver && cd picgalleryserver
cp .env.example .env       # 填 PGS_DB_PASSWORD / PGS_ADMIN_PASSWORD / PGS_SESSION_SECRET
docker compose pull        # 拉取 ghcr.io/dming623/picgalleryserver:<PGS_TAG>
docker compose up -d       # 启动服务
```
浏览器打开 `http://服务器IP:3000`,用你设置的管理员账号登录。

> compose 默认只监听 `127.0.0.1:3000`(由反向代理对外),直接对外暴露请把 `ports` 改成 `"3000:3000"`。
> `PGS_ADMIN_PASSWORD`、`PGS_SESSION_SECRET`、`PGS_DB_PASSWORD` 未设置时 compose 会直接报错退出,不会用默认弱密码启动;生产环境若 `ADMIN_PASSWORD` 仍是占位值,应用本身也会拒绝启动。

> 后续更新版本:把 `.env` 里的 `PGS_TAG` 改成目标版本号,再执行 `docker compose pull && docker compose up -d`。示例固定版本号,避免 `up` 时被动升级到未测试版本。

想使用 VPS 上已有的图片目录:在 `docker-compose.yml` 的 `volumes` 里加入 `- /srv/photos:/photos:ro`,然后在 **设置 → 相册管理 → 挂载服务器目录** 里选择 `/photos`。

> 挂载相册默认是**只读**的(不允许通过本系统上传/移动/物理删除其中的文件),需要写入时在相册设置里关闭只读。
> 若服务器为私有网络环境,需先执行 `docker login ghcr.io -u <GitHub用户名> --password-stdin` 并输入具备 `read:packages` 权限的 Personal Access Token。

### 方式二:在服务器本地自行构建镜像

如需改回本地构建,编辑 `docker-compose.yml` 的 `app` 服务:

```yaml
  app:
    image: ghcr.io/dming623/picgalleryserver:latest   # 注释或删除此行
    pull_policy: always                                # 注释或删除此行
    build: .                                           # 取消此行注释
```
然后执行 `docker compose up -d --build`。

### 方式三:直接运行(Node.js 24+ 与 PostgreSQL,或 Node.js 24+ 单文件 SQLite)

```bash
npm install
cp .env.example .env     # 修改 ADMIN_USER、ADMIN_PASSWORD、SESSION_SECRET
npm run build
npm start                # 端口由 .env 中的 PORT 决定,默认 3000
```

数据库二选一:

- **PostgreSQL**(推荐,多实例/大数据量):`.env` 里设 `DB_DRIVER=postgres` 与 `DATABASE_URL`。
- **SQLite**(零外部服务,单文件):`.env` 里设 `DB_DRIVER=sqlite`(`SQLITE_FILE` 默认 `DATA_DIR/pgs.sqlite`),无需安装任何数据库。数据表会在首次启动时自动创建。

> SQLite 依赖 Node 内置的 `node:sqlite`(Node ≥ 22.5 需 `--experimental-sqlite`,Node ≥ 24 默认可用),因此运行 SQLite 模式请使用 Node 24+。视频封面与视频元数据需要系统安装 `ffmpeg`(可选):`apt install ffmpeg`。

### 依赖版本要求与推荐版本

以下结论来自实测(见 [`scripts/TESTING.md`](./scripts/TESTING.md))与代码审查:

| 组件 | 最低 | 推荐 | 说明 |
|---|---|---|---|
| **Node.js** | 22.13(`engines` 写 ≥22) | **24 LTS**(镜像即 `node:24-bookworm-slim`) | SQLite 模式依赖内置 `node:sqlite`:Node 22.5–22.12 需 `--experimental-sqlite`(`next start` 无法方便传入),22.13+ 起默认可用;PostgreSQL 模式不依赖它。已在 Node 22.23 与 24 验证 |
| **PostgreSQL** | **13** | **15 / 16 / 17** | ① `pg_trgm` 在 13+ 为「受信任扩展」,非超级用户的库所有者也能建立索引;② 代码使用 `ADD COLUMN IF NOT EXISTS`、`FILTER`、窗口函数,12 及以下未测试;③ **v1.4.3 起 PG 15 及以下也可正常运行**(此前封面查询的子查询缺少别名,PG ≤ 15 会在创建相册时报 500,PG ≥ 16 才不报错)。已实测 PG 15 与 PG 16 |
| **SQLite**(`node:sqlite` 内置) | **3.35**(需要 `RETURNING`,聚合 `FILTER` 需 3.30,窗口函数需 3.25) | Node 24 内置的版本 | 版本由 Node 自带,无需单独安装;Node 22.23 内置 3.4x+,Node 24 更新。单进程单文件,**不要把 SQLite 文件放在网络文件系统(NFS/SMB)上**,也不要多实例共用 |
| **ffmpeg / ffprobe** | 4.x | 6.x / 7.x | 可选;没有时视频封面为占位图且无时长/编码元数据。官方镜像已内置 |
| **sharp(libvips)** | 随 npm 依赖安装 | — | 预编译 libvips **不含 BMP 加载器**,BMP 由项目内置解码器处理;HEIC 由 `heic-convert` 解码 |
| **Docker** | 20.10 | 24+ / Compose v2 | `docker-compose.yml` 使用 `service_healthy` 依赖条件 |
| 文件系统 | — | ext4 / xfs / btrfs / zfs | 挂载目录处理图片时会先复制私有副本(支持 reflink 的文件系统几乎零开销),避免外部程序截断文件导致进程崩溃 |

> 数据库功能差异:两种驱动对外行为一致(同一套 e2e 在两者上均全部通过)。区别主要在容量与并发:大图库(数万以上)与搜索性能建议用 PostgreSQL(`pg_trgm` GIN 索引加速模糊搜索),SQLite 的 `LIKE '%词%'` 是顺序扫描。

### 镜像构建流水线(GitHub Actions)

工作流文件:[`.github/workflows/docker-publish.yml`](./.github/workflows/docker-publish.yml)

| 项目 | 说明 |
|---|---|
| 触发条件 | 向 `main` 分支推送代码、推送 `v*` 版本标签,或手动触发(`workflow_dispatch`) |
| 镜像地址 | `ghcr.io/dming623/picgalleryserver` |
| 支持架构 | `linux/amd64`、`linux/arm64`(通过 QEMU 模拟构建) |
| 标签规则 | `latest`(main 分支与 v* 标签)、`main`、`sha-<短哈希>`、`v1.2.3`、`v1.2` |
| 构建缓存 | 使用 GitHub Actions 内置缓存(`type=gha`)加速重复构建 |
| 镜像可见性 | 公开仓库关联的容器包默认继承为 Public,服务器可免登录拉取;若仓库转为私有,需在仓库 **Packages** 页面手动将容器包设为 Public,或先 `docker login ghcr.io` |

在 GitHub 仓库的 **Actions** 页面可查看构建进度;镜像包托管于 **Packages** 页面。

### 反向代理(HTTPS)

放在 Nginx/Caddy 之后时,请在 `.env` 设置 `PUBLIC_BASE_URL=https://你的域名` 与 `COOKIE_SECURE=true`,并转发 `X-Forwarded-Proto`/`X-Forwarded-For`。

**真实 IP**:应用默认(`TRUST_PROXY=0`)只信任反向代理**覆盖写入**的 `X-Real-IP`。请务必用 `proxy_set_header X-Real-IP $remote_addr;`(**不要**用 `$proxy_add_x_forwarded_for`,那会把客户端自带的值排在最前,限流可被绕过)。若确实要信任多层代理,设 `TRUST_PROXY=n` 取 `X-Forwarded-For` 的倒数第 n 段。

**上传相关**(Nginx 默认 `client_max_body_size` 只有 1MB,不配会直接 413):

```nginx
client_max_body_size 0;                 # 或一个足够大的值,如 20g
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;

location /api/v1/media/upload {
    proxy_pass http://127.0.0.1:3000;
    proxy_request_buffering off;        # 流式转发,不先落盘
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
}
```

高清预览(HD)接口带短期令牌且按用户鉴权,**必须关闭缓存**并透传真实 IP(Nginx 示例):

```nginx
location ~ ^/api/v1/media/[^/]+/hd {
    proxy_pass http://127.0.0.1:3000;
    proxy_cache off; proxy_no_cache 1; proxy_cache_bypass 1;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
}
```

使用 CDN 时请把 `/api/*` 设为「绕过缓存」。

### 上线前安全清单

1. 改 `ADMIN_PASSWORD`(生产环境用占位值会拒绝启动)、设置 `SESSION_SECRET`(留空会自动生成并保存到 `DATA_DIR/secret.key`)。
2. 设 `PUBLIC_BASE_URL` 与 `COOKIE_SECURE=true`,全站走 HTTPS。
3. 反代用 `X-Real-IP $remote_addr` 覆盖真实 IP;`TRUST_PROXY` 保持 0,除非你确实有多层代理。
4. 用 `ALLOWED_MOUNT_ROOTS` 收窄可挂载目录;照片目录以 `:ro` 挂进容器,挂载相册保持只读。
5. 数据库端口不要对外;`docker compose` 里 app 默认只监听 `127.0.0.1`。
6. 定期备份:`pg_dump` 数据库 + `DATA_DIR/{albums,branding}`;`derived/`、`cache/` 可重建,不必备份。
7. 需要时用 `GUEST_META=none` 彻底不给游客元数据、`GUEST_NOTE=false` 隐藏管理员备注。

### 资源建议

| 规格 | 容器限制(`mem_limit` / `cpus`) | 建议配置(写进 `.env`) | 程序自动推导的媒体内存预算 |
|---|---|---|---|
| 1C1G | `1g` / `1.0` | `PGS_NODE_HEAP_MB=320`、`THUMB_CONCURRENCY=2`、`VIDEO_CONCURRENCY=1`、`HEIC_CONCURRENCY=1`、`HD_CONCURRENCY=1`、`SHARP_CONCURRENCY=1`、`UV_THREADPOOL_SIZE=4`、`HD_CACHE_MAX_MB=256` | ≈ 430 MB |
| 2C4G | `4g` / `2.0` | `PGS_NODE_HEAP_MB=1200`、`THUMB_CONCURRENCY=3`、`VIDEO_CONCURRENCY=2`、`HD_CONCURRENCY=2`、`UV_THREADPOOL_SIZE=8`、`HD_CACHE_MAX_MB=1024` | ≈ 2048 MB(上限) |
| 8C16G | `16g` / `8.0` | `PGS_NODE_HEAP_MB=2048`、`THUMB_CONCURRENCY=6`、`VIDEO_CONCURRENCY=3`、`HD_CONCURRENCY=4`、`HD_CACHE_MAX_MB=4096` | ≈ 2048 MB(上限) |

- **`mem_limit` 要真的设**:`docker-compose.yml` 里 `mem_limit` / `cpus` 默认注释着,取消注释即可。程序读取 cgroup 内存上限来推导预算与压力水位;不设上限时按宿主机内存推导,**在小内存机器上等于没有保护**。
- **堆上限 ≈ 容器内存的 25%~35%**(`PGS_NODE_HEAP_MB`,compose 转成 `--max-old-space-size`):内存大头是 libvips 的原生缓冲区,不受堆上限约束,堆设得太大只会挤占它的空间。
- **媒体内存预算**(`MEDIA_BUDGET_MB`,默认自动):`(容器内存 × 0.85 − 250MB) × 0.7`,夹在 256~2048MB 之间。后台缩略图、HEIC、视频、高清预览共用这一份预算——**按像素与格式估算每个任务的内存**(渐进 JPEG / 隔行 PNG / CMYK 比普通图重得多),放不下就排队;单个任务估算超过 `MEDIA_MAX_EST_MB`(默认预算 × 1.5)直接以 `[LIMIT]` 拒绝并保留原文件。`/api/v1/status` 的 `config.mediaBudget.derivation` 会展示推导过程;`MEDIA_BUDGET_MB=0` 关闭预算(回到只按并发数限制)。
- **内存压力保护**(`MEDIA_PRESSURE_GUARD`,默认开):运行时按 cgroup 的 `anon` 水位(不含可回收页缓存)分 normal / elevated / high / critical 四档,逐级收紧准入;预估有误差时它是兜底。
- 上表的并发数是**起点**;改完用 `/api/v1/status`(`memory` / `queue.admission` / `eventLoop`)观察一轮批量导入再调整。想在自己的机器上量一遍,见 `scripts/bench/README.md` 与 `scripts/bench-docker.sh`。

> **docker compose 部署**:`.env` 里的性能/安全/存储类变量(`THUMB_CONCURRENCY`、`HD_*`、`COOKIE_SECURE`、`MAX_UPLOAD_MB`、`S3_*` …)由 `docker-compose.yml` 逐项映射进容器,**无前缀名直接生效**(旧的 `PGS_THUMB_CONCURRENCY` 等仍兼容);不设置时使用程序默认值(图片并发按 CPU 核数自适应)。新增配置项必须同步写进 compose 映射,`node scripts/check-config.mjs` 会校验。
> 验证是否生效:`docker compose exec app printenv | grep -E 'HD_|THUMB_|COOKIE_SECURE'`,以及管理员登录后 `GET /api/v1/status` 的 `config` 字段。
>
> 容器部署时请同时设 `PGS_NODE_HEAP_MB`,让 V8 堆上限与容器内存限制匹配(默认 1024 不适合 1GB 机器),否则可能被 OOM Killer 直接杀掉;`UV_THREADPOOL_SIZE` 镜像默认 12,1C1G 建议 4(compose 已映射,`.env` 直接写)。

### 实测数据(v1.3.5,4 vCPU / 8GB 容器 / PostgreSQL 16,NASA 素材;为历史数据,v1.5 起的基线见 `scripts/bench/README.md`)

以下数据来自真实 NASA Image Library 素材(99 个文件,含 30MB 与 42MB 的 TIFF、100MP PNG、MP4 视频)在容器内实测,可作为容量规划参考:

| 场景 | 实测结果 |
|---|---|
| 全量上传 99 个文件(约 900MB,并发 8) | 5.5 秒,0 失败,RSS 峰值 733MB |
| 派生图队列排空(含 100MP PNG 与 TIFF) | 峰值 762MB |
| 24 路并发高清预览(HD_CONCURRENCY=3) | 10.1 秒,24/24 成功,**RSS 峰值 1897MB** |
| 全量重生成派生图 | 7.6 秒,峰值未超过 1897MB |
| 压测结束静置 20 秒 | RSS 回落到 **709MB**(jemalloc 生效,碎片可归还) |
| 空载常驻 | 约 250MB RSS |

> 内存主要开销在 *sharp/libvips* 的原生缓冲区,不受 `--max-old-space-size` 约束。1C1G 机器请把 `HD_CONCURRENCY` 降到 1、`THUMB_CONCURRENCY` 降到 2,并限制 `HD_CACHE_MAX_MB`。

> *sharp/libvips*:Node.js 的高性能图像处理库,解码大图时在堆外分配原生内存,因此容器内存限制必须留出这部分余量。

### 数据与存储说明

- **原图不重复存储**:上传后按 `SHA-256` 去重,同一相册内重复文件直接返回已有记录;磁盘原图总字节与源文件一致(实测 208 个文件 1468MB → 磁盘 1468MB)。
- **派生图很小**:缩略图(宽 ≤720)平均约 50KB,预览图(宽 ≤1600)平均约 176KB;208 个文件全部派生图仅约 53MB,约为原图的 3.6%。
- **元数据提取**:JPEG 的 EXIF/IPTC/XMP/ICC 提取率与数值正确率均为 100%;TIFF 在 v1.3.5 起改为整文件解析(受 `EXIF_MAX_BYTES` 约束),不再因截断丢字段;仅含 XMP 的文件也能取到标题、关键词与创建时间。
- **可安全删除的目录**:`DATA_DIR/derived`(派生图)、`DATA_DIR/cache`、`DATA_DIR/tmp`、`DATA_DIR/hdCache` 均可删除并重建;备份只需 `pg_dump` + `DATA_DIR/{albums,branding}`。
- **磁盘保护**:剩余空间低于 `MIN_FREE_DISK_MB` 时上传返回 `507 insufficient_storage`,`/api/v1/health/ready` 同步降级为 503,便于编排系统感知。

### 单实例说明

任务队列、限流计数、相册树与 HD 缓存索引都在**进程内存**里,因此本项目**只支持单实例部署**。不要对同一个数据库同时运行多个容器,否则会出现重复扫描与重复处理。

## ⚙️ 配置(.env)

私密与运行参数都在 `.env`(完整说明见 `.env.example`):

| 变量 | 说明 |
|---|---|
| `PORT` | 服务端口 |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 管理员账号密码(改密码改这里并重启;生产环境不允许占位密码) |
| `SESSION_SECRET` | 登录令牌签名密钥;留空时生产环境自动生成并保存到 `DATA_DIR/secret.key` |
| `DATABASE_URL` | PostgreSQL 连接(与 `DB_DRIVER=postgres` 配合) |
| `DB_DRIVER` | `postgres` / `sqlite`;不设时有 `DATABASE_URL` 用 postgres,否则 sqlite |
| `SQLITE_FILE` | SQLite 数据文件,默认 `DATA_DIR/pgs.sqlite` |
| `TZ` | 站点默认时区(默认 `Asia/Shanghai`),通知时间与日期分组按它换算 |
| `DATA_DIR` | 数据目录 |
| `THUMB_CONCURRENCY` | 图片处理并发,默认 `min(4, CPU)` |
| `VIDEO_CONCURRENCY` / `HEIC_CONCURRENCY` | 视频与 HEIC 解码的独立并发上限(默认 2 / 1) |
| `MEDIA_BUDGET_MB` / `MEDIA_MAX_EST_MB` | 媒体处理内存预算(软,按容器内存自动推导,0 = 关闭)/ 单任务估算硬上限(超过以 `[LIMIT]` 拒绝) |
| `MEDIA_MAX_INPUT_MP` / `SHARP_CONCURRENCY` | 派生图输入像素上限(默认 268MP,超过以 `[LIMIT]` 拒绝,不会删除原文件)/ 单个 libvips 任务的内部线程数(默认 2,低内存机器设 1) |
| `MEDIA_PRESSURE_GUARD` | 动态内存压力保护,默认开启 |
| `SCAN_MAX_DEPTH` | 挂载目录递归扫描的最大深度,默认 32 |
| `MAX_UPLOAD_MB` | 单文件上传上限,默认 2048,0 = 不限 |
| `MIN_FREE_DISK_MB` | 剩余磁盘低于该值拒绝上传,默认 1024 |
| `CORRUPT_AUTO_PURGE_HOURS` | 疑似损坏文件(处理失败)在停止上传满该小时数后自动清理,默认 5,0 = 关闭 |
| `ALLOWED_MOUNT_ROOTS` | 限制可挂载的目录范围(留空时只允许数据目录与 `/photos /mnt /media /srv /home /volume1`) |
| `TRUST_PROXY` | 信任几层反向代理,默认 0(只信反代覆盖的 `X-Real-IP`) |
| `ALLOWED_HOSTS` | 生成链接/水印时可用的 Host 白名单;**同时决定 HD 游客水印成品能否缓存**(见 `.env.example`,建议直接设 `PUBLIC_BASE_URL`) |
| `GUEST_META` / `GUEST_NOTE` | 游客可见的元数据级别(`full|basic|none`)与是否可见管理员备注 |
| `S3_*` | 对象存储(可选) |
| `HD_WM_OPACITY` | 高清预览水印透明度(默认 8,数值越大越明显) |
| `DB_DRIVER` / `SQLITE_FILE` | 数据库驱动(`postgres`/`sqlite`)与 SQLite 文件路径 |
| `TZ` | 站点默认时区,默认 `Asia/Shanghai` |

完整清单(含数据库连接池、扫描熔断、限流、EXIF 读取上限等)见 [`.env.example`](./.env.example)。

## 🖥️ 使用

- **上传**:登录后点底部「⬆ 上传」,选择目标相册(或"未归类");可拖拽/点选本地文件,也可切到「🔗 直链上传」一行一个 URL。上传完成后会告诉你文件去了哪里。
- **站点通知**:管理者及以上在 设置 → 通知发布 撰写 Markdown 通知;所有登录用户在顶部铃铛里查看,可一键已读,按日期筛选,同日多条按时间折叠。
- **时区**:设置 → 系统状态 → 时区,默认 `Asia/Shanghai`;改后历史通知显示时间同步变化。
- **公开相册给游客**:设置 → 相册管理 → 把相册设为"公开"。其余相册游客完全看不到。
- **相册管理是文件夹式的**:列表只显示当前层级的相册;有子相册的相册左侧会出现 📁 图标(或"N 个子相册 ›"),点击进入下一层,支持多层嵌套,顶部面包屑可逐级返回。每个相册的文件夹属性操作栏中均提供「📁 移动」按钮,点击后弹出可展开的文件树选择目标路径(对于受管相册会同步移动 VPS 数据目录中的源文件夹到目的文件夹;对于挂载服务器目录则仅调整项目内的层级链接与显示位置,不移动服务器上的源文件夹)。
- **删除与反悔**:图片/视频详情页点"删除"时,不勾选"同时删除服务器上的原文件"即只做排除(加入删除黑名单);要彻底删除必须显式勾选。反悔入口:设置 → 删除黑名单 → 解除黑名单。
- **疑似损坏文件**:损坏或伪造的文件(打不开、生成不了缩略图)不会出现在图库里,而是集中到 设置 → 系统状态 → 疑似损坏文件,可点卡片右上角的垃圾桶一键清理;若一直不处理,停止上传满 5 小时后会自动清理(可用 `CORRUPT_AUTO_PURGE_HOURS` 调整)。
- **允许别人下载原图**:设置 → 原文件下载密钥 → 创建密钥,然后把 `文件链接?key=密钥` 发给对方。
- **命令行**:
  ```bash
  export PGS_URL=http://127.0.0.1:3000
  node cli/pgs.mjs login --user admin --password-stdin   # 输入密码,令牌存到 ~/.config/pgs/credentials.json
  node cli/pgs.mjs album create 旅行 --public
  node cli/pgs.mjs album mount /srv/photos               # 默认只读
  node cli/pgs.mjs upload ./照片目录 --album alb_xxxxxxxx -c 8 -r
  node cli/pgs.mjs key set --ttl 24h
  node cli/pgs.mjs blocklist list
  node cli/pgs.mjs help
  ```
  `upload` 会先比对 hash 跳过已存在的文件,可反复执行做幂等同步;`--dry-run` 只看计划不发送。

## 📜 许可证

本项目采用 **[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)**(SPDX 标识:`PolyForm-Noncommercial-1.0.0`),这是一套由 PolyForm Project 发布的**非商业许可证**。完整条款见 [LICENSE](./LICENSE),归属声明见 [NOTICE](./NOTICE)。

> 关于措辞:本许可证**不是开源许可证**。按 OSI 的《开源定义》,开源许可证不得限制商业用途,而本许可证明确禁止商业使用,因此它属于「源码公开、但非商业」的许可模式(source-available / noncommercial),而不是 open source。请勿把本项目描述为「开源软件」,准确说法是「非商业许可的公开源码软件」。

| 你可以 | 你不可以 |
|---|---|
| ✅ 个人学习、研究、实验与业余项目 | ❌ 任何商业用途(收费托管、出售、集成盈利等) |
| ✅ 教育机构、慈善组织、科研机构的非商业使用 | ❌ 将本项目作为付费产品的一部分交付 |
| ✅ 修改本项目并制作衍生作品 | ❌ 删除或隐去 `Required Notice:` 归属声明 |
| ✅ 向本项目提交贡献 | ❌ 分发时附带的许可证与声明不完整 |

### 不可商用

许可证的 **Noncommercial Purposes** 条款规定:「Any noncommercial purpose is a permitted purpose.」即**只有非商业目的**才属于授权范围。

- 允许:个人学习研究、非盈利的业余项目、公益与教育机构使用、向本项目提交贡献
- 禁止:对外收费的托管或订阅服务、将本项目打包进付费产品、基于本项目提供有偿服务
- 商业使用需另行获得著作权人的书面授权

### 修改后必须提到本项目

许可证的 **Notices** 条款要求:任何获得本软件部分副本的人,都必须同时获得许可证副本(或官方 URL),以及所有以 `Required Notice:` 开头的纯文本行。

因此,若你修改了本项目并对外分发(源码、容器镜像、二进制等任何形式),请务必保留:

1. **[LICENSE](./LICENSE)** 全文(或官方 URL `https://polyformproject.org/licenses/noncommercial/1.0.0`);
2. **[NOTICE](./NOTICE)** 文件,其中包含必须原样传递的声明行:

   ```text
   Required Notice: Copyright (c) 2026 DMing623 (https://github.com/DMing623/PicGalleryServer)
   ```

3. 各源文件顶部的 `SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0` 标识;
4. 在 README 或产品说明中注明本项目来源:https://github.com/DMing623/PicGalleryServer

> 许可证的 **Changes and New Works License** 条款允许你为任何许可用途制作修改与新作品;但附加的许可条款不得与本许可证冲突,也不能放宽其非商业限制。

## 📄 说明

开发者文档(目录结构、API、扩展方式)见 [project.md](./project.md)。

全量测试(API / CLI / PostgreSQL+SQLite / local+ext / Docker / InstaBox)的脚本与步骤见 [scripts/TESTING.md](./scripts/TESTING.md)。
