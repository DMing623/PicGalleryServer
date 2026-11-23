# PicGalleryServer

[![构建](https://github.com/DMing623/PicGalleryServer/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/DMing623/PicGalleryServer/actions/workflows/docker-publish.yml)
[![许可证](https://img.shields.io/badge/License-PolyForm--Noncommercial--1.0.0-blue.svg)](./LICENSE)

自托管的图片与视频相册服务。把照片和视频放在自己的服务器上,用漂亮的毛玻璃界面浏览、搜索、分享,并且原图受保护。

> ⚠️ **许可证**:本项目采用 **PolyForm Noncommercial License 1.0.0** —— 可自由使用、修改与再分发,但**仅限非商业用途**;修改后再分发必须保留本项目的归属声明(`Required Notice:`)与许可证副本。完整条款见 [LICENSE](./LICENSE)。

## ✨ 功能

- **相册分类 + 嵌套相册**:可在数据目录里新建相册;也可以把 VPS 上任意位置的绝对路径目录"挂载"为相册,子目录自动变成嵌套子相册,原文件不搬家。
- **本地 / 对象存储**:原文件可放在服务器本地,也可放在 S3 兼容的对象存储。
- **自动缩略图与预览图**:生成速度可控(并发数可在 `.env` 配置,默认 15),不会把 CPU 和内存打满。
- **详尽元数据**:相机型号/镜头/光圈快门 ISO/GPS/时间等 EXIF 信息;PNG 文本信息;Stable Diffusion、NovelAI、ComfyUI 等 AI 生成图的提示词与参数;视频编码、分辨率、码率等。详情页只显示文件里实际存在的字段(名称/备注/分辨率/相册/ID/上传时间/格式为必备条目)。
- **文件链接**:每张图片/视频下方都有可复制的文件链接(直链、HTML、Markdown),可嵌入博客。
- **管理员备注**:管理员可为任意图片/视频添加备注(只保存在数据库,不改动原文件),游客只读。
- **搜索**:首页是全局搜索;在某个相册内搜索只会搜索该相册自身(子相册的文件只在其子相册中显示,不会在父相册重复出现)。
- **原文件保护**:游客只能浏览管理员"公开"的相册;网页和文件链接默认只返回缩略图/预览图,视频无法下载;只有在链接后追加管理员设置的**下载密钥**(可选永久或 24 小时后自动失效并删除)才能获取服务器上的原图和原分辨率视频。
- **多用户与权限**:管理员 / 管理者 / 上传者 / 查看者四个级别;游客不能上传。
- **炫酷界面**:3D 旋转光环 + 粒子 + 3D 文字的启动页(可换成你自己的 https 图片/视频/网页链接),毛玻璃质感主页;主题配色可在设置里调整,默认经典 Claude 配色;支持上传自定义站点图标。
- **完整 API 与命令行**:所有操作都能通过 HTTP API 或命令行完成。

* **高清预览与防盗图**:点击图片按屏幕分辨率加载无元数据的高清 WebP(最大 2560px,按需生成 + LRU 临时缓存),支持滚轮/双击/双指缩放;服务端合成来源水印(`Source: {域名} · github.com/DMing623/PicGalleryServer`,登录用户另有动态标识),短期令牌 + 独立限流 + 异常检测,不影响原图下载密钥体系。配置见 `.env.example` 的 `HD_*`。
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

### 方式三:直接运行(Node.js 22+ 与 PostgreSQL)

```bash
npm install
cp .env.example .env     # 修改 DATABASE_URL、ADMIN_USER、ADMIN_PASSWORD、SESSION_SECRET
npm run build
npm start                # 端口由 .env 中的 PORT 决定,默认 3000
```
数据表会在首次启动时自动创建。视频封面与视频元数据需要系统安装 `ffmpeg`(可选):`apt install ffmpeg`。

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

| 规格 | 建议配置 |
|---|---|
| 1C1G | `THUMB_CONCURRENCY=2`、`VIDEO_CONCURRENCY=1`、`HEIC_CONCURRENCY=1`、`HD_CONCURRENCY=1`、`HD_CACHE_MAX_MB=256` |
| 2C4G | `THUMB_CONCURRENCY=3`、`VIDEO_CONCURRENCY=2`、`HD_CONCURRENCY=2`、`HD_CACHE_MAX_MB=1024` |
| 8C16G | `THUMB_CONCURRENCY=6`、`VIDEO_CONCURRENCY=3`、`HD_CONCURRENCY=4`、`HD_CACHE_MAX_MB=4096` |

> 容器部署时请同时设 `NODE_OPTIONS=--max-old-space-size=...`,让 V8 堆上限与容器内存限制匹配,否则可能被 OOM Killer 直接杀掉。

### 实测数据(v1.3.5,4 vCPU / 8GB 容器 / PostgreSQL 16)

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
| `DATABASE_URL` | PostgreSQL 连接 |
| `DATA_DIR` | 数据目录 |
| `THUMB_CONCURRENCY` | 图片处理并发,默认 `min(4, CPU)` |
| `VIDEO_CONCURRENCY` / `HEIC_CONCURRENCY` | 视频与 HEIC 解码的独立并发上限(默认 2 / 1) |
| `MAX_UPLOAD_MB` | 单文件上传上限,默认 2048,0 = 不限 |
| `MIN_FREE_DISK_MB` | 剩余磁盘低于该值拒绝上传,默认 1024 |
| `CORRUPT_AUTO_PURGE_HOURS` | 疑似损坏文件(处理失败)在停止上传满该小时数后自动清理,默认 5,0 = 关闭 |
| `ALLOWED_MOUNT_ROOTS` | 限制可挂载的目录范围(留空时只允许数据目录与 `/photos /mnt /media /srv /home /volume1`) |
| `TRUST_PROXY` | 信任几层反向代理,默认 0(只信反代覆盖的 `X-Real-IP`) |
| `ALLOWED_HOSTS` | 生成链接/水印时可用的 Host 白名单 |
| `GUEST_META` / `GUEST_NOTE` | 游客可见的元数据级别(`full|basic|none`)与是否可见管理员备注 |
| `S3_*` | 对象存储(可选) |
| `HD_WM_OPACITY` | 高清预览水印透明度(默认 8,数值越大越明显) |

完整清单(含数据库连接池、扫描熔断、限流、EXIF 读取上限等)见 [`.env.example`](./.env.example)。

## 🖥️ 使用

- **上传**:登录后点右上角「上传」,在下拉框里选择要保存到的相册(或"未归类"),上传完成后会告诉你文件去了哪里。
- **公开相册给游客**:设置 → 相册管理 → 把相册设为"公开"。其余相册游客完全看不到。
- **相册管理是文件夹式的**:列表只显示当前层级的相册;有子相册的相册左侧会出现 📁 图标(或"N 个子相册 ›"),点击进入下一层,支持多层嵌套,顶部面包屑可逐级返回。
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

本项目采用 **[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)**(SPDX 标识:`PolyForm-Noncommercial-1.0.0`),这是一套由 PolyForm Project 发布的、面向软件的开源许可证。完整条款见 [LICENSE](./LICENSE),归属声明见 [NOTICE](./NOTICE)。

| 你可以 | 你不可以 |
|---|---|
| ✅ 个人学习、研究、实验与业余项目 | ❌ 任何商业用途(收费托管、出售、集成盈利等) |
| ✅ 教育机构、慈善组织、科研机构的非商业使用 | ❌ 将本项目作为付费产品的一部分交付 |
| ✅ 修改本项目并制作衍生作品 | ❌ 删除或隐去 `Required Notice:` 归属声明 |
| ✅ 向本项目提交贡献 | ❌ 分发时附带的许可证与声明不完整 |

### 不可商用

许可证的 **Noncommercial Purposes** 条款规定:「Any noncommercial purpose is a permitted purpose.」即**只有非商业目的**才属于授权范围。

- 允许:个人学习研究、非盈利的业余项目、公益与教育机构使用、开源贡献
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
