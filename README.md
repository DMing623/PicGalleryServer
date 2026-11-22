# PicGalleryServer

[![构建](https://github.com/DMing623/PicGalleryServer/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/DMing623/PicGalleryServer/actions/workflows/docker-publish.yml)
[![许可证](https://img.shields.io/badge/License-PolyForm--Noncommercial--1.0.0-blue.svg)](./LICENSE)

自托管的图片与视频相册服务。把照片和视频放在自己的服务器上,用漂亮的毛玻璃界面浏览、搜索、分享,并且原图受保护。

> ⚠️ **许可证**:本项目采用 **PolyForm Noncommercial License 1.0.0** —— 可自由使用、修改与再分发,但**仅限非商业用途**;修改后再分发必须保留本项目的归属声明(`Required Notice:`)与许可证副本。完整条款见 [LICENSE](./LICENSE)。

## ✨ 功能

- **相册分类 + 嵌套相册**:可在数据目录里新建相册;也可以把 VPS 上任意位置的绝对路径目录"挂载"为相册,子目录自动变成嵌套子相册,原文件不搬家。
- **本地 / 对象存储**:原文件可放在服务器本地,也可放在 S3 兼容的对象存储。
- **自动缩略图与预览图**:生成速度可控(并发数可在 `.env` 配置,默认 15),不会把 CPU 和内存打满。
- **详尽元数据**:相机型号/镜头/光圈快门 ISO/GPS/时间等 EXIF 信息;PNG 文本信息;Stable Diffusion、NovelAI、ComfyUI 等 AI 生成图的提示词与参数;视频编码、分辨率、码率等。没有的字段显示 `N/A`。
- **文件链接**:每张图片/视频下方都有可复制的文件链接(直链、HTML、Markdown),可嵌入博客。
- **管理员备注**:管理员可为任意图片/视频添加备注(只保存在数据库,不改动原文件),游客只读。
- **搜索**:首页是全局搜索;在某个相册内搜索只会搜索该相册(含其子相册)。
- **原文件保护**:游客只能浏览管理员"公开"的相册;网页和文件链接默认只返回缩略图/预览图,视频无法下载;只有在链接后追加管理员设置的**下载密钥**(可选永久或 24 小时后自动失效并删除)才能获取服务器上的原图和原分辨率视频。
- **多用户与权限**:管理员 / 管理者 / 上传者 / 查看者四个级别;游客不能上传。
- **炫酷界面**:3D 旋转光环 + 粒子 + 3D 文字的启动页(可换成你自己的 https 图片/视频/网页链接),毛玻璃质感主页;主题配色可在设置里调整,默认经典 Claude 配色;支持上传自定义站点图标。
- **完整 API 与命令行**:所有操作都能通过 HTTP API 或命令行完成。

## 🚀 部署

### 方式一:Docker Compose(推荐,直接使用流水线构建好的镜像)

仓库已接入 GitHub Actions 自动构建镜像,**无需在服务器上自行构建**,直接拉取即可:

```bash
git clone <本仓库地址> picgalleryserver && cd picgalleryserver
# 编辑 docker-compose.yml,修改管理员密码、SESSION_SECRET、数据库密码
docker compose pull        # 拉取 ghcr.io/dming623/picgalleryserver:latest
docker compose up -d      # 启动服务
```
浏览器打开 `http://服务器IP:3000`,用你设置的管理员账号登录。

> 后续更新版本时,只需在服务器执行 `docker compose pull && docker compose up -d` 即可获取最新镜像。

想使用 VPS 上已有的图片目录:在 `docker-compose.yml` 的 `volumes` 里加入 `- /srv/photos:/photos`,然后在 **设置 → 相册管理 → 挂载服务器目录** 里选择 `/photos`。

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

### 方式二:直接运行(Node.js 22+ 与 PostgreSQL)

```bash
npm install
cp .env.example .env     # 修改 DATABASE_URL、ADMIN_USER、ADMIN_PASSWORD、SESSION_SECRET
npm run build
npm start                # 端口由 .env 中的 PORT 决定,默认 3000
```
数据表会在首次启动时自动创建。视频封面与视频元数据需要系统安装 `ffmpeg`(可选):`apt install ffmpeg`。

### 反向代理(HTTPS)

放在 Nginx/Caddy 之后时,请在 `.env` 设置 `PUBLIC_BASE_URL=https://你的域名` 与 `COOKIE_SECURE=true`,并转发 `X-Forwarded-Proto`/`X-Forwarded-For`。

## ⚙️ 配置(.env)

私密与运行参数都在 `.env`(完整说明见 `.env.example`):

| 变量 | 说明 |
|---|---|
| `PORT` | 服务端口 |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 管理员账号密码(改密码改这里并重启) |
| `SESSION_SECRET` | 登录令牌签名密钥,请设置为随机长字符串 |
| `DATABASE_URL` | PostgreSQL 连接 |
| `DATA_DIR` | 数据目录 |
| `THUMB_CONCURRENCY` | 缩略图/预览图生成并发数,默认 15 |
| `ALLOWED_MOUNT_ROOTS` | 限制可挂载的目录范围(可选) |
| `S3_*` | 对象存储(可选) |

## 🖥️ 使用

- **上传**:登录后点右上角「上传」,在下拉框里选择要保存到的相册(或"未归类"),上传完成后会告诉你文件去了哪里。
- **公开相册给游客**:设置 → 相册管理 → 把相册设为"公开"。其余相册游客完全看不到。
- **允许别人下载原图**:设置 → 原文件下载密钥 → 创建密钥,然后把 `文件链接?key=密钥` 发给对方。
- **命令行**:
  ```bash
  export PGS_URL=http://127.0.0.1:3000 PGS_USER=admin PGS_PASSWORD=你的密码
  node cli/pgs.mjs album create 旅行 --public
  node cli/pgs.mjs album mount /srv/photos
  node cli/pgs.mjs upload ./照片目录 --album alb_xxxxxxxx -c 8 -r
  node cli/pgs.mjs key set --ttl 24h
  node cli/pgs.mjs help
  ```

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
