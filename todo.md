# todo.md — 性能 / 内存 / 可维护性改进计划

> 基线:`v1.4.3`(提交 `452b181`),2026-11-24。本文件**只做评估与规划,没有改动任何业务代码**(本次提交仅 `project.md` 与 `todo.md`)。
> **证据等级**:【实测】= 本次在沙箱里跑出的数据(见 `project.md` §17.3 与本文附录 A);【代码】= 读源码得出;【推断】= 合理推测但未验证,动手前先验证。
> **与 `project.md` 的分工**:`project.md` 写"现状",本文件写"下一步"。完成某项后:在 `project.md` 对应章节更新现状 → 在这里把状态改成 ✅ 并写版本号。
> **状态图例**:⬜ 未开始 · 🔧 进行中 · ✅ 完成 · ⏸ 暂缓

---

## 1. 对 ChatGPT 建议的评价

**总评**:方向基本正确(不整体重写、先测量、统一预算、进程隔离),但**排序有偏差**——它把 `toBuffer → toFile` 放在第一位,而实测这一项对峰值**没有影响**;真正决定峰值的"统一内存预算"被排在第三。它只做了静态阅读,所以漏掉了几个读代码就能发现、且影响更大的问题(§2:compose 变量不传递、嵌套闸门队首阻塞)。我给的分:**方向 8/10,定量与排序 5/10**。

| # | ChatGPT 的说法 | 我的判断 | 依据 | 处理 |
|---|---|---|---|---|
| 1 | 第一优先:`.toBuffer()` 改 `.toFile()` | ❌ **收益 ≈ 0** | 【实测】同一输入峰值完全相同:24MP JPEG 86/86MB、40MP TIFF 123/123MB、100MP PNG 135/135MB;【README】输出均值仅 preview 176KB / thumb 50KB | 降为 P2-2(代码卫生,别当优化) |
| 2 | HEIC/BMP 整文件进 Buffer 是重点 | ✅ 方向对,幅度未测;更好的做法是交给**原生解码子进程**,文件进文件出 | 【代码】`heicToJpeg`/`bmpToPng` 整文件 `readFile`;【推断】libheif-wasm 线性内存只增不减 | P1-5、P2-1 |
| 3 | HD 命中缓存也读成 Buffer,水印合成产生大 Buffer | ⚠️ 部分对:Buffer 本身很小(WebP 基图数百 KB);真正的成本是**水印合成时的像素缓冲(12~17 字节/像素)**,且**每次请求都做、结果不缓存** | 【代码】`serveHd`→`applyWatermark`;【实测】2560×1707 合成 +54MB/次 | P1-4 |
| 4 | 各类并发各自为政,缺统一内存预算 | ✅ **完全同意,这是最重要的一项**。但不要拍脑袋设"权重 1/2/3",应按**像素 × 格式系数**估算,且权重**零成本可得**(`processMedia` 已先调 `metadata()`) | 【实测】4×100MP 隔行 PNG:无预算 1434MB → 预算后 500MB;混合负载只慢 2.5s→3.7s | **P1-1(提升为核心)** |
| 5 | 保守配置:`THUMB_WIDTH=400`、`HD_WIDTH=1600`… | ⚠️ 并发与堆上限可采纳;**画质/尺寸项不建议**——输出尺寸不是内存主因,降它只损失画质 | 【实测】内存由输入解码决定,与输出尺寸无关 | 只采纳并发/堆(P2-5),不改画质默认 |
| 6 | `sharp.concurrency` 做成环境变量;输入像素上限可配置并降到 60–100MP | ✅ 可配置;❌ **一刀切降上限不对**:100MP 非隔行 PNG 仅 135MB,而 48MP 渐进 JPEG 就要 235MB——**该看格式,不只看像素** | 【实测】见 `project.md` §17.3 | P1-2(可配置 + 按权重拒绝) |
| 7 | 268MP × 4B = 1GB+ | ⚠️ 对隔行/渐进成立(100MP 隔行 405MB,线性外推 268MP ≈ 1.1GB),对流式格式夸大 | 【实测】 | 并入 P1-1/P1-2 |
| 8 | 抽出独立 Media Worker,用 Rust | ⚠️ **隔离**方向对;**Rust 没必要**:内存主体是 libvips,换语言工作集不变;同样的隔离/回收/独立内存上限用**第二个 Node 进程**就能得到,并复用全部 TS 与 sharp | 【代码】`derive.ts`/`hd/service.ts` 已是"文件路径进、文件出"的形状,天然适合拆进程 | P3-1(Node worker);P3-2(Rust 暂不做,给出触发条件) |
| 9 | 扫描时集中保留目录数据,超大目录有压力 | ⚠️ 夸大:扫描**按单个目录**进行(非全库),`stat` 8 路并发,库内只取 5 列 | 【代码】`albums.ts#scanAlbum`;【推断】10 万文件平铺目录约几十 MB | P2-6(先测再说) |
| 10 | 前端要虚拟列表 | ✅ 方向对:`items` 只增不减,代码里也没有 `content-visibility`。但瀑布流列高可由 `aspect-ratio` 精确算出,**窗口化比通用虚拟列表简单** | 【代码】`Gallery.tsx` | P2-4 |
| 11 | Docker 内存限制 ≠ Node 堆上限 | ✅ 且**比它说的更严重**:compose 默认 `--max-old-space-size=1024`、无 `mem_limit`;README 的 1C1G 配方让用户设 `HD_CONCURRENCY=1`,但 compose **不会把它传进容器** | 【代码】`docker-compose.yml` | **D-2(P0)**、P2-5 |
| 12 | README 缩略图并发默认值与配置不一致 | ✅ README 写 15,实际 `min(4, CPU)`;`project.md` 也写错过(本次已改) | 【代码】`config.ts` | D-1 |
| 13 | 先测量真实内存构成 | ✅ 同意;本次先做了一组微基准,但 `/status` 仍缺 `external/arrayBuffers/sharp.counters` | 【代码】`api/admin.ts` | P0-2、P0-3 |
| 14 | `HD_CACHE_MAX_MB` 是磁盘不是内存 | ✅ 正确(`project.md` §6.14 已写明) | — | — |

---

## 2. ChatGPT 没提到、但我认为更要紧的发现

| # | 发现 | 等级 | 影响 |
|---|---|---|---|
| F1 | `docker-compose.yml` 的 `environment:` 是白名单,**没有 `env_file:`**,`.env` 只用于插值。`HD_*`、`S3_*`、`COOKIE_SECURE`、`MAX_UPLOAD_MB`、`THUMB_WIDTH`、`PREVIEW_WIDTH`、`SCAN_*`、`GUEST_*`… 全都进不了容器 | 【代码】按 Compose 语义,**待容器内 `printenv` 验证** | README 的 1C1G/2C4G 内存建议里的 `HD_CONCURRENCY`、`HD_CACHE_MAX_MB` **实际不生效**;HTTPS 反代下 `COOKIE_SECURE` 也传不进去;S3 无法用 compose 配置 |
| F2 | 视频/HEIC 闸门**嵌套在队列槽位内**:任务先占 `THUMB_CONCURRENCY` 的槽,再排队等 `heicGate(1)`/`videoGate(2)`。批量 HEIC 时 4 个槽里 3 个"占着等",JPEG 也被堵住;HD 的 HEIC 转换还和后台队列共用同一个 `heicGate` | 【代码】`queue.ts` + `derive.ts` | 吞吐与延迟问题(不是内存问题):HEIC 批量导入期间整个缩略图队列近乎串行,HD 打开 HEIC 要排在后台任务后面 |
| F3 | 内存工作集随**格式**变化 5 倍:隔行 PNG / 渐进 JPEG ≈ 3.5 B/px,常规格式 ≈ 0.7~1.5 B/px;`metadata().isProgressive` 两者都能识别 | 【实测】 | 决定了预算器的权重设计(P1-1) |
| F4 | HD 水印**每次请求**重新合成(含解码 W×H、合成、重编码),响应 `no-store`,前端 fetch 也 `no-store`:同一张图重复打开重复付费;游客的水印结果其实是确定的(无用户标识),完全可缓存 | 【代码】 | 每次打开大图 ≈ 一次 CPU 突发 + 35~75MB 瞬时内存;是 HD 并发争用的主因之一 |
| F5 | `/status` 的内存只有 `{rss, heapUsed}`;没有 `external/arrayBuffers`、`sharp.counters()`、cgroup 水位、闸门排队长度 | 【代码】 | 无法回答"峰值由谁造成" |
| F6 | `files.ts` 的无效密钥限流直接读 `x-real-ip`,没走 `clientIp()`,不遵守 `TRUST_PROXY`;无反代时所有客户端共用 `"unknown"` 桶 | 【代码】 | 小型可用性/安全问题 |
| F7 | `PGS_TAG` 在 `docker-compose.yml` 与 `.env.example` 仍是 `1.4.0`(包是 `1.4.3`);`.env.example` 缺 `SCAN_MAX_DEPTH` | 【代码】 | 按文档部署会拿到旧镜像 |
| F8 | `project.md` 与代码有多处偏差(缺 HD 子系统、并发默认值错误、图库描述过时、§12 重复行…) | 【代码】 | **本次已全部修正**;根因是没有机制保证同步 → D-4 |

---

## 3. 计划

**默认决策**(无需再确认):不重写后端、不引入 Rust;先修部署与观测,再做统一预算;画质默认值不动;每项改动都带验收指标,改动队列/闸门后必须重跑 `project.md` §17.3 的基准。

### P0 — 先做(低风险,让后续优化可度量)

#### ⬜ D-2 修 compose 变量传递(F1)
- **做什么**:`docker-compose.yml` 的 `app` 增加 `env_file: [.env]`(或把 `HD_*`、`S3_*`、`COOKIE_SECURE`、`MAX_UPLOAD_MB`、`MIN_FREE_DISK_MB`、`THUMB_WIDTH`、`PREVIEW_WIDTH`、`SCAN_*`、`GUEST_*`、`ALLOWED_*`、`PUBLIC_BASE_URL` 逐个映射)。推荐 `env_file` + 保留现有白名单中的 `PGS_*` 映射(白名单优先级更高,不会被覆盖)。同时把 `PGS_TAG` 默认值与 `.env.example` 对齐到当前版本(F7),`.env.example` 补 `SCAN_MAX_DEPTH`,并把 `mem_limit`/`cpus` 的示例写成可直接取消注释的形式。
- **验收**:`docker compose config` 输出里能看到 `HD_CONCURRENCY`;起容器后 `docker exec <c> printenv | grep -E 'HD_|COOKIE_SECURE'` 与 `.env` 一致;`GET /status` 的 `config.hdConcurrency` 随 `.env` 变化。
- **风险**:`env_file` 会把 `.env` 里的 `PGS_*` 一并注入容器(无害,但含密码——容器内本来就有同值);`TZ` 已显式声明不受影响。
- **工作量**:S(0.5h)。

#### ⬜ P0-2 观测补全(F5)
- **做什么**:`/status` 的 `memory` 扩展为 `{rss, heapUsed, heapTotal, external, arrayBuffers, maxRss, cgroup:{current, max}}`(cgroup v2 读 `/sys/fs/cgroup/memory.current|memory.max`,v1 回落 `memory.usage_in_bytes`);新增 `sharp:{cache: sharp.cache(), counters: sharp.counters(), concurrency: sharp.concurrency()}`;`queue` 增加各闸门(`heic/video/hd`)的 `active/waiting`;记录一个"最近 10 分钟 RSS 最大值"滑动窗口。`SystemTab.tsx` 展示这些字段。
- **验收**:压测(批量上传 + HD 并发)后能从 `/status` 一眼看出峰值时刻、各闸门排队长度、external 与 RSS 的差;`limiter()` 需要暴露 `{active, waiting}` 的只读统计。
- **风险**:`/status` 有 5 秒缓存,峰值窗口要独立采样(`setInterval(...).unref()`,每秒一次即可)。
- **工作量**:S~M(2h)。

#### ⬜ P0-3 用真实素材建立基线(补全 §17.4 的未验证项)
- **做什么**:把附录 A 的微基准整理成 `scripts/bench-memory.mjs` 并写进 `scripts/TESTING.md`(**入库脚本属于代码改动,放到本计划的实施阶段**);在**容器**里(带 jemalloc、`MALLOC_ARENA_MAX=2`)用 `fetch-samples.mjs` 的 NASA 素材 + 补充 HEIC(iPhone 12MP/48MP)、BMP、16-bit PNG、CMYK TIFF、渐进 JPEG 各跑一遍,记录:单任务峰值、4 并发峰值、静置 20s 后回落值、耗时。结果回填 `project.md` §17.3。
- **验收**:§17.4 的"未测"清单清零;能解释 README 里"24 并发 HD 1897MB"由哪几个并发任务构成。
- **工作量**:M(半天,含素材准备)。

### P1 — 核心优化(预期收益最大)

#### ⬜ P1-1 像素加权的统一内存预算闸门 `MediaBudget`
- **问题**:并发只按"任务个数"限制,而单任务工作集差 5~9 倍(F3);派生槽、`heicGate`、`videoGate`、HD `gate` 互不感知(`project.md` §17.1-5)。
- **设计**(新文件 `server/media/budget.ts`):
  - `class MemoryBudget { constructor(maxMB); run<T>(estMB, fn): Promise<T> }`:信号量,单位是**估算 MB**;`used + estMB <= maxMB` 才放行;**空闲时无论多大都放行一个**(避免大图永远饿死,与基准演示一致);队列 FIFO,但允许小任务越过队首等待中的大任务,**同时给大任务一个 aging 上限**(等待超过 N 秒后阻塞后来者),避免饥饿。
  - 估算:`estMB = mp × bytesPerPx(format, isProgressive, depth)`。初值取自实测:流式(基线 JPEG / 非隔行 PNG / TIFF)≈ 1.5;渐进 JPEG / 隔行 PNG ≈ 3.6;16-bit ×2;HEIC 另算(见 P1-5);HD 水印合成 ≈ 15 B/px × W×H;统一再乘 1.25 安全系数。**这些数字只是起点,以 P0-3 的真实素材结果校准**。
  - 接入点:① `derive.ts#processMedia` 在已有的 `sharp(...).metadata()` 之后、`makeDerived` 之前;② `hd/service.ts#convert`(`row.width/height` 已入库,缺失则回退 `metadata()`);③ `hd/watermark.ts#applyWatermark`(已有 `metadata()` 取 W×H);④ HEIC/BMP 的整文件读入之前(按文件大小 × 系数估算)。`THUMB_CONCURRENCY`/`HD_CONCURRENCY` 保留,角色变为**CPU 并发上限**,预算器是**内存上限**,两者同时满足才放行。
  - 配置:`MEDIA_BUDGET_MB`,默认 = `clamp(cgroup内存上限 × 0.5 − 250, 256, 2048)`(无 cgroup 限制时取 `os.totalmem() × 0.4`);`0` = 关闭(回到现状)。`/status` 展示 `used/max/waiting`(依赖 P0-2)。
  - 超限语义:单任务估算 > `MEDIA_BUDGET_MB` 时仍单独放行(不拒绝),但在 `error`/日志里记录"超预算单独运行";是否拒绝由 P1-2 的 `MEDIA_MAX_INPUT_MP` 决定。
- **验收**(用附录 A 的脚本回归):4×100MP 隔行 PNG 峰值 ≤ 550MB(现 1430MB);1×大图 + 20×24MP JPEG 总耗时劣化 < 50%、峰值不高于现状;24 路 HD 并发(含大图)峰值显著低于现状;`MEDIA_BUDGET_MB=0` 时行为与现状一致;新增单元级测试(纯逻辑,不依赖 sharp)覆盖放行/FIFO/aging/空闲放行。
- **风险**:估算偏低 → 预算形同虚设(用校准 + `/status` 的 `external` 对照发现);估算偏高 → 吞吐下降(只影响极端输入,常规输入权重很小);死锁(一个任务在持有预算时又去申请预算)——接入点必须保证**不嵌套申请**,尤其 HD 的 `convert` 与水印是两次独立的 `run`。
- **工作量**:M~L(1~2 天,含校准)。**这是整份计划的核心。**

#### ⬜ P1-2 把硬编码阈值变成配置,并按权重拒绝极端输入
- **做什么**:新增 `SHARP_CONCURRENCY`(默认 2,低内存机器设 1)、`MEDIA_MAX_INPUT_MP`(默认保持 268 以兼容现有数据;低配机器建议 100)。当单张图的估算内存 > `MEDIA_MAX_EST_MB`(默认 = 预算上限)时,**失败并给出明确原因**("图片 12000×9000 渐进编码,估算需要 ~380MB,超过上限"),而不是静默吃光内存;`failed` 记录会进入"疑似损坏文件"流程——需要区分"超限"与"损坏",建议在 `error` 里加固定前缀并在 UI 上区别展示。同步 `project.md` §10.2 的表格(这两项从"硬编码"移到"环境变量")与 `.env.example`、compose 白名单(D-2 之后自动带上)。
- **不做**:不把默认上限一刀切降到 60~100MP(见 §1 第 6 行)。
- **验收**:设 `SHARP_CONCURRENCY=1` 后 `/status` 反映;`MEDIA_MAX_INPUT_MP=50` 时 100MP PNG 得到明确失败原因且不进入解码。
- **工作量**:S(2h,依赖 P1-1 的估算函数)。

#### ⬜ P1-3 队列分池,消除嵌套闸门的队首阻塞(F2)
- **问题**:见 F2。
- **做什么**:让 `pump()` 在取下一个任务时就知道它的类别(`image` / `heic` / `video`),按类别各自的容量选取"下一个可运行"的任务(跳过暂时无容量类别的队首),而不是先占槽再排队。类别信息在入队处就有(`ingest.ts`/`albums.ts`/`reprocess` 都知道文件名/kind):`enqueue(id, {priority, cls})`,缺省 `image`。`heicGate`/`videoGate` 的容量改由队列统一管理(HD 的 HEIC 转换仍需要一个独立闸门,或改走 P1-1 的预算器)。
- **验收**:先写回归用例——"100 个 HEIC + 100 个 JPEG 同时入队":JPEG 的完成时间不应被 HEIC 拖到最后;`/status/queue` 增加按类别的 `running/waiting`。
- **风险**:`enqueue` 的调用点较多(上传、扫描、重处理、黑名单恢复、启动恢复),类别缺省必须安全;`dirty`/重试路径要保留类别。
- **工作量**:M(0.5~1 天)。

#### ⬜ P1-4 降低 HD 水印的重复成本(F4)
- **先测量**(依赖 P0-2):同一张 2560px 图,缓存命中时 `serveHd` 的 CPU 耗时与瞬时内存;确认水印合成是否确实占大头。
- **候选方案**(按收益/风险排序,逐个验证):① **游客水印结果缓存**:键 `(id, ver, width, host)`,落 `cache/hd/wm/`(与基图同一套 LRU/TTL,容量计入 `HD_CACHE_MAX_MB`);登录用户因带 `U-XXXXXX` 不缓存。② `loadVisibleImage` 只 select 必要列(见 P2-3)。③ 水印层改成预先栅格化的"原始 RGBA 瓦片"并只对需要的区域合成——复杂度高,**仅当 ①② 后仍是瓶颈才考虑**。④ 前端同一张图在一次查看会话内复用 Blob(`useHd` 已保留相邻 ±1 张;关闭查看器即释放,可延长到 N 秒)——注意不得违背"禁止缓存以便每次重校验权限"的安全设计,服务端响应头保持 `no-store`,只在**页面内存**里短暂复用。
- **验收**:同一张图的第二次打开,服务端 CPU 耗时下降(游客)/ 不变(登录);安全测试(`scripts/test-hd.mjs` 的 49 条)全部通过,尤其"可见性变化后立即 404"和"缓存命中仍重新校验权限"。
- **风险**:水印缓存必须随 `invalidateHd(id)` 一起失效;host 来自请求,需受 `ALLOWED_HOSTS`/`PUBLIC_BASE_URL` 约束,否则伪造 Host 可撑爆缓存(现有 `layerCache` 的 24 项上限就是为此)。
- **工作量**:M。

#### ⬜ P1-5 HEIC:评估原生解码子进程(文件进、文件出)
- **背景**:`heic-convert` = libheif 的 wasm 版 + 纯 JS JPEG 编码,整文件进 Buffer、整图 RGBA 在 wasm 堆里;wasm 线性内存【推断】只增不减。HEIC 又占派生槽位(F2)。
- **候选**:Debian bookworm 的 `libheif-examples`(`heif-convert`,原生)通过 `execFile` 把 `x.heic` 转成临时 JPEG 文件,再交给 sharp;子进程结束即把内存还给系统,Node 侧不再持有大 Buffer;保留 `heic-convert` 作回退(与 ffmpeg 可选的现有模式一致)。镜像 +约 20~30MB。
- **必须先验证**:方向与镜像/翻转(`irot/imir`)是否被正确应用且不与 sharp `.rotate()` 重复旋转;ICC 与 10-bit HEIC;HEIF 网格/多帧/Live Photo;HEVC 解码器的许可与专利立场(个人自托管通常可接受,但应写进 README);EXIF 仍从原文件读取(`extractImageMeta(file)` 已如此,不受影响)。
- **验收**:iPhone 12MP 与 48MP 样张,对比 `heic-convert` 的峰值 RSS、耗时、画面一致性(PSNR/肉眼)、方向正确性;批量 50 张后静置 RSS 是否回落。
- **工作量**:M。若验证不通过(许可/兼容),保留现状并把 HEIC 权重在 P1-1 中调高、`HEIC_CONCURRENCY` 默认保持 1。

### P2 — 次要优化与卫生项

| ID | 状态 | 内容 | 验收 / 说明 |
|---|---|---|---|
| P2-1 | ⬜ | **BMP**:`bmpToPng` 整文件 + RGBA + PNG Buffer。加像素上限(并入 P1-2 的估算);若 ffmpeg 可用,改用 `ffmpeg -i x.bmp -frames:v 1 out.png` 文件进文件出 | 罕见格式,低优先;验收:50MP BMP 不再产生数百 MB 的 Node Buffer |
| P2-2 | ⬜ | **`.toBuffer()` → `.toFile()`**(`makeDerived`、`convert`、水印输出):仅作代码卫生,**预期内存收益 ≈ 0**(实测);保留 tmp+rename 的原子写入 | 峰值不应变化;好处是少一次 Buffer 复制 |
| P2-3 | ⬜ | **列投影**:`processMedia` 与 `hd/service.ts#loadVisibleImage` 都 `select()` 整行(含 `meta` jsonb、`search_text`);改成 `files.ts#FILE_COLS` 那样只取必要列 | HD 取图每次请求少拉一次大 jsonb;`processMedia` 需要 `meta` 以外的列 |
| P2-4 | ⬜ | **前端窗口化**:`Gallery.tsx` 的 `items` 只增不减,无 `content-visibility`。先量化(5k/20k 项时 DOM 节点数与标签页内存);再做"按列累计高度只渲染视口 ±N 屏、其余用占位高度"的窗口化(列高可由 `aspect-ratio` 精确得到);同时评估为网格增加更小的缩略档(如 360px)或 `srcset`,当前 `THUMB_WIDTH=720` 对 6 列桌面网格偏大 | 验收:2 万项滚动到底,DOM 节点数与内存近似常数;滚动/回顶无闪烁;`pgs:changed` 刷新后保持位置 |
| P2-5 | ⬜ | **部署指引**:README/compose 给出"容器内存 → 推荐 `PGS_NODE_HEAP_MB`/`THUMB_CONCURRENCY`/`HD_CONCURRENCY`/`MEDIA_BUDGET_MB`"对照表(堆 ≈ 容器上限的 25%~35%,默认 1024 不适合 1GB 机器);`docker-compose.yml` 提供可直接取消注释的 `mem_limit`;`/status` 展示 cgroup 上限(P0-2) | 1GB/2GB/4GB 三档各跑一次 P0-3 的基准,写入文档 |
| P2-6 | ⬜ | **扫描内存**:用 10 万文件平铺目录实测 `scanAlbum` 的堆峰值与耗时;若 > 200MB 再改成 `opendir` 流式 + 1000 条一批查库 | 先测再决定,**默认不改** |
| P2-7 | ⬜ | **`files.ts` 密钥限流 IP**(F6):改用 `router.ts#clientIp(req)` | 单元/e2e 增加"带 `TRUST_PROXY` 时按 XFF 倒数第 n 段限流" |
| P2-8 | ⬜ | `.env.example`/README 补 `SCAN_MAX_DEPTH`、`MEDIA_BUDGET_MB`、`SHARP_CONCURRENCY`、`MEDIA_MAX_INPUT_MP`(随 P1 落地) | 与 `project.md` §10 对齐 |

### P3 — 架构演进(只在触发条件成立时做)

#### ⏸ P3-1 独立的 Node 媒体 worker 进程(不是 Rust)
- **价值**:① 崩溃隔离——挂载目录的 `SIGBUS`(已用私有副本规避)与 OOM 不再拖垮 Web/API;② **可回收**——worker 的 RSS 超阈值或处理 N 个任务后优雅重启,同时解决 glibc 碎片与 wasm 内存不回落;③ 独立的 `--max-old-space-size`、`MALLOC_ARENA_MAX`、cgroup 配额;④ Web 事件循环不再被媒体任务影响。
- **形状**:`child_process.fork()` 同一份 TS/JS(`derive.ts`、`hd` 的 convert/水印),父子之间只传 JSON({jobId, 输入路径, 输出路径, 参数}),**绝不传图片 Buffer**;预算器(P1-1)放在父进程做准入,worker 内只负责执行;DB 写回仍由父进程做(或 worker 持有自己的连接,二选一,倾向父进程以保持单点)。
- **触发条件**(任一):`/status` 观察到事件循环延迟被媒体任务拖高(P0-2 可加 `perf_hooks.monitorEventLoopDelay`);出现容器 OOM kill 或 `SIGBUS` 崩溃;P1-5 验证后仍需回收 wasm 内存。
- **工作量**:L。

#### ⏸ P3-2 Rust —— 暂不做
- **理由**:图像解码/缩放/编码已经在原生库里(sharp = libvips);Rust 重写调用层不会减少像素工作集;"文件路径进、JSON 出"的拆分用 P3-1 的 Node worker 就能得到,且零重写成本。
- **重新评估的触发条件**(需同时满足 ①②,或满足 ③):① 需要 libvips 做不到的能力(自定义 RAW/HEIC 解码、严格的分块内存上限管线);② P3-1 之后瓶颈仍在 JS 侧的 CPU(例如超大库的目录遍历 + 哈希)而不是 libvips;③ 你愿意长期维护第二套工具链与多架构镜像。若要尝试,**从目录扫描/哈希 worker 开始**,而不是图像管线。

#### ⏸ P3-3 持久化队列 / 多实例
- 只在确有横向扩展需求时做(`project.md` §2.1 列出了全部进程内状态)。需要:数据库任务表 + 租约、HD 缓存索引共享或各自独立、限流计数外置(Redis)。当前个人自托管场景**不建议**。

#### ⏸ P3-4 视频转码预览(720p / HLS)
- 原"明确未做"项,与内存无关;有需求再做。

### D — 文档与一致性

| ID | 状态 | 内容 |
|---|---|---|
| D-1 | ⬜ | **README**:缩略图并发默认值写的是 15(第 14 行),实际 `min(4, CPU)`;内存实测表标注测试条件(NASA 素材/容器/版本);1C1G 等配方在 D-2 修复后再核对 |
| D-2 | ⬜ | 见 P0 的 D-2(compose 变量传递)——放在 P0 因为它决定其余调优是否生效 |
| D-3 | ⬜ | `.env.example` 与 compose 的 `PGS_TAG` 对齐当前版本;补 `SCAN_MAX_DEPTH`(并入 D-2) |
| D-4 | ⬜ | **防止文档再次漂移**:加一个 `scripts/check-docs.mjs`(零依赖),CI 里比对 ① 路由清单 ↔ `project.md` §8、② `config.ts` 环境变量 ↔ §10/`.env.example`、③ `find src` 文件清单 ↔ §3、④ `package.json` 版本 ↔ compose/`.env.example` 的 `PGS_TAG`。偏差即失败(或先只告警)。`project.md` §0 已列出人工核对命令,这一步把它们自动化 |
| D-5 | ⬜ | `project.md` §8 中仍有少量参数描述未逐条核对(如各接口的取值范围),下次碰到相应接口时顺带校对 |
| D-6 | ✅ | `project.md` 表格里未转义的 `\|`(渲染错位)——本次已修 |

### T — 测试

| ID | 状态 | 内容 |
|---|---|---|
| T-1 | ⬜ | **性能/内存回归**:`test.yml` 增加手动/夜间触发的 job:合成素材(含隔行 PNG、渐进 JPEG)+ 读取 `/status` 的 `maxRss` 与各闸门排队长度,**宽松断言**(例如 4×隔行 PNG 峰值 < 阈值),避免 CI 机器差异造成抖动;PR 默认不跑 |
| T-2 | ⬜ | **基准脚本入库**(P0-3):`scripts/bench-memory.mjs`,输出 Markdown 表,可直接贴进 `project.md` §17.3 |
| T-3 | ⬜ | 队列分池(P1-3)与预算器(P1-1)的**纯逻辑单测**(`node --test`,不依赖 sharp/DB) |

---

## 4. 建议的执行顺序

| 里程碑 | 内容 | 预期 |
|---|---|---|
| **M1(半天)** | D-2(含 D-3)、D-1、P2-7、P0-2 | 部署参数真正生效;能看见内存构成;这一步**本身就可能显著改善用户已有部署的内存**(例如 README 建议的 `HD_CONCURRENCY=1` 终于生效) |
| **M2(1 天)** | P0-3(含 T-2)、P1-2、P1-3 | 有真实素材基线;阈值可配置;HEIC 批量不再堵队列 |
| **M3(1~2 天)** | P1-1(含 T-3)、P1-4 | 统一预算上线;HD 重复成本降低;用 §17.3 方法回归 |
| **M4(按需)** | P1-5、P2-1、P2-3、P2-4、P2-5 | HEIC 原生解码、BMP、前端窗口化、部署表 |
| **观察期** | P3-* | 仅在触发条件成立时启动 |

## 5. 明确暂不做 / 不建议做

- ❌ 把 `toFile` 当作内存优化项(实测无收益,仅 P2-2 卫生)。
- ❌ 下调 `THUMB_WIDTH`/`PREVIEW_WIDTH`/`HD_WIDTH` 来"省内存"(输出尺寸不是主因,只损失画质)。
- ❌ 一刀切把输入像素上限降到 60~100MP(按格式加权才合理,见 P1-1/P1-2)。
- ❌ 整体或部分改写成 Rust(见 P3-2)。
- ❌ 把 `HD_CACHE_MAX_MB` 当作内存手段(它只是磁盘上限)。
- ❌ 在没有 P0-2 观测数据前调整 `UV_THREADPOOL_SIZE`/`MALLOC_ARENA_MAX`(镜像里已有 jemalloc,README 有容器实测)。

## 6. 度量与验收的统一口径

- **峰值**:进程 `VmHWM`(`/proc/self/status`)或 P0-2 的 `maxRss`;**回落**:任务结束后静置 20 秒的 RSS。
- **基线**:启动后空载 RSS(Next 约 250MB;裸 sharp 进程 61MB)。
- **场景**:派生图 ×1/×4;HD convert ×1/×3;HD 水印 ×1/×3/×24;混合负载(1 大图 + 20 小图);HEIC 批量 50 张。
- **报告**:每次改动后把结果追加到 `project.md` §17.3,并注明环境(CPU/内存/Node/sharp/libvips、是否容器、是否 jemalloc、素材来源)。

---

## 附录 A:基准脚本摘要(合成素材,沙箱 4 vCPU / 3.9GB,Node 22,sharp 0.35.5)

> 以下是本次实际使用脚本的精简版,供 P0-3/T-2 整理入库时参考。每个场景**单独起进程**以得到干净的 `VmHWM`。

**素材生成**(`gen.js`):用 `sharp({raw})` 合成 24MP JPEG(q90)、40MP TIFF(deflate)、100MP PNG(`progressive:false/true`,`compressionLevel:1`)、48MP JPEG(`progressive:false/true`)。像素内容为渐变 + 轻噪声。

**场景脚本**(`scen.js`,`node scen.js <场景> <文件> <并发>`):

```js
const sharp = require('sharp'); const fs = require('fs');
sharp.cache(false); sharp.concurrency(2);                 // 与项目一致
const [,, scen, file, n = 1] = process.argv;
const hwm = () => Number(/VmHWM:\s+(\d+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))[1]) / 1024;
const INPUT = { failOn: 'none', limitInputPixels: 268e6, sequentialRead: true };
const derive = async (f, toFile) => {                      // 与 derive.ts#makeDerived 等价
  const p = sharp(f, INPUT).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 });
  const pv = toFile ? (await p.toFile('/tmp/p.webp'), '/tmp/p.webp') : await p.toBuffer();
  const t = sharp(pv, INPUT).resize({ width: 720, height: 1440, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 });
  toFile ? await t.toFile('/tmp/t.webp') : await t.toBuffer();
};
const hd = (f) => sharp(f, { failOn: 'none', limitInputPixels: 200e6 }).rotate()   // 与 hd/service.ts#convert 等价
  .resize({ width: 2560, height: 4096, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
(async () => {
  const t0 = Date.now(), base = hwm();
  if (scen === 'derive-buf')  await Promise.all(Array.from({ length: +n }, () => derive(file, false)));
  if (scen === 'derive-file') await Promise.all(Array.from({ length: +n }, () => derive(file, true)));
  if (scen === 'hd')          await Promise.all(Array.from({ length: +n }, () => hd(file)));
  if (scen === 'wm') {                                     // 基图 + 同尺寸半透明 PNG 层(近似水印层)
    const b = await hd(file), m = await sharp(b).metadata();
    const layer = await sharp({ create: { width: m.width, height: m.height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.03 } } }).png().toBuffer();
    await Promise.all(Array.from({ length: +n }, () => sharp(b).composite([{ input: layer, blend: 'over' }]).webp({ quality: 85 }).toBuffer()));
  }
  console.log(`${scen} ${file} x${n} ${((Date.now() - t0) / 1000).toFixed(1)}s 峰值RSS ${hwm().toFixed(0)}MB (基线 ${base.toFixed(0)}MB)`);
})();
```

**像素加权闸门演示**(`gate.js`,`node gate.js a.jpg,b.png,... <预算MP>`):

```js
let used = 0; const q = [];
const acquire = (w) => new Promise((r) => { const t = () => (used === 0 || used + w <= BUDGET) ? (used += w, r(), true) : false; if (!t()) q.push(t); });
const release = (w) => { used -= w; for (let i = 0; i < q.length;) q[i]() ? q.splice(i, 1) : i++; };
async function job(f) {
  const m = await sharp(f, INPUT).metadata();                           // 与 processMedia 里已有的 metadata() 同一调用
  const w = Math.ceil(m.width * m.height / 1e6 * (m.isProgressive ? 1.5 : 1));
  await acquire(w);
  try { await sharp(f, INPUT).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toBuffer(); }
  finally { release(w); }
}
```

注意:演示里的 `1.5` 只是让隔行/渐进更"重"的粗糙系数;正式实现请按 P1-1 的"字节/像素"表估算 MB,并用 P0-3 的真实素材校准。

## 附录 B:本次评估的局限(重申)

合成素材、glibc 默认 malloc、非容器、Node 22;未测 HEIC/BMP/视频/16-bit/CMYK;未复现 README 的 1897MB;F1 基于 Compose 语义判断,尚未在真实容器内验证。上述项目在 P0-3 中补齐,**在此之前请把 §1~§2 的结论当作"高置信的方向判断",而不是精确的容量规划**。
