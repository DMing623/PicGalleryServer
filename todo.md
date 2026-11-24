# todo.md — 性能 / 内存 / 可维护性改进计划

> 基线:`v1.4.3`(提交 `452b181`)。**修订记录**:r1 = 首版;**r2 = 吸收 ChatGPT 对 r1 的第二轮评审**(逐项处理见 §1.5)。r1/r2 两次提交都**只改文档,没有改动任何业务代码**。
> **执行方式(r2 起)**:分里程碑、带出口门禁(§4)。**先只做 M1,复核真实配置与观测/基线数据后,再决定是否进入 M2、M3**——不要一次性执行整份 todo。
> **证据等级**:【实测】= 沙箱里跑出的数据(见 `project.md` §17.3 与附录 A);【代码】= 读源码得出;【推断】= 合理推测但未验证,动手前先验证。
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

## 1.5 第二轮:ChatGPT 对本 todo 的评审与处理(r2 新增)

**总评**:ChatGPT 认可 r1 的主线(像素加权统一预算、不换 Rust、`toFile` 降级、先修 Compose),并指出 r1 里**几处设计不够严谨**。我逐条核对后,**接受其中大部分,并承认 r1 有两处设计缺陷**(HD 预算生命周期、`env_file` 推荐);对"Worker 异常恢复"采纳但**分阶段落地**,不提前做大改。它的评分(8.5/10)不影响决策,这里只看具体论点。

| # | ChatGPT 的论点 | 判断 | 处理 / 落点 |
|---|---|---|---|
| 1 | 估算公式不能当固定规律;应是**可校准策略**,带置信度,便于新增格式 | ✅ 采纳 | P1-1 §2:`estimate()` 返回 `{estMB, confidence, reason}`;系数表独立成文件,每格标注来源(实测/外推/猜测);**低置信度自动更保守**(×1.5),而不只是展示 |
| 2 | 预算应区分**软预算**与**硬限制**,`MEDIA_BUDGET_MB` 不是绝对上限 | ✅ 采纳 | P1-1 §3:`MEDIA_BUDGET_MB`(软,空闲时允许独占一个超预算任务)+ `MEDIA_MAX_EST_MB`(硬,超过拒绝并给原因)。r1 把两者混在 P1-2 里且默认相同,语义不清 |
| 3 | 预算基数应先扣除基础 RSS、同容器数据库、OS 与安全余量,而不是"容器内存的一半" | ✅ 采纳 | P1-1 §4:`(limit×(1−margin) − baseRss)×f`,推导过程在 `/status` 展示。注意默认 compose 的 PostgreSQL 在**独立容器**,不计入 app 的 cgroup;SQLite 模式/同容器部署才计入 |
| 4 | **HD 不能拆成两次独立预算申请**:convert 释放后其产物 Buffer 仍存活,水印阶段会漏计 | ✅ **成立,r1 此处有缺陷** | P1-1 §5:一次 HD 请求 = 一次覆盖整条流水线的 reservation;保留"禁止嵌套申请"(防死锁),并加开发期嵌套检测 |
| 5 | 水印缓存值得做,但安全边界要写清:Key 含版本/宽度/水印配置版本;不信任未校验 Host;容量+过期;**每次请求重新校验权限**;失效点齐全;可先用 LRU | ✅ 采纳(LRU 部分**部分采纳**) | P1-4 重写;新增 T-4 测试。内存 LRU 会直接抬高 RSS,与目标冲突,所以**默认仍选磁盘**,内存 LRU 仅作为测量后的备选 |
| 6 | D-2 最该先核实;**不要整份注入 `.env`**,按最小权限显式映射或用专门 env 文件;验收看运行中容器的 `printenv` 与 `/status` | ✅ **采纳,改变 r1 推荐** | D-2 重写:r1 推荐的 `env_file: [.env]` 改为**显式映射 + D-4 自动校验**;验收改为三层 |
| 7 | 队列分池没问题,但**不要让 `MediaBudget` 和 `queue.ts` 变成两个各自排队的系统**;决策顺序应为 类别并发 → 内存预算 → 优先级/等待时间 | ✅ **采纳,这是架构层面的重要修正** | P1-1 §6 / P1-3:所有"等待"只发生在**一个** `admit()` 里;HD 请求与后台队列共用同一等待表 |
| 8 | 新增**动态内存压力保护**(预测有误差,需要运行时兜底) | ✅ 采纳,但补一个技术坑 | 新增 **P1-6**。坑:cgroup 的 `memory.current` **含可回收页缓存**,直接拿它做阈值会误触发,应以 `anon`(或 current − inactive_file)为准 |
| 9 | 为未来 Worker 设计**异常恢复与幂等**(PENDING/RUNNING/SUCCESS/FAILED/INTERRUPTED) | ✅ 采纳,**分阶段** | 核查发现一个现存隐患(F9:`attempts` 仅在内存,重启后崩溃回路)。新增 **P2-9**(轻量版,不引入 Worker);完整生命周期并入 **P3-1 前置条件** |
| 10 | 基准脚本正式入库,拆成 `scripts/bench/*`;要同时看耗时,避免"峰值降了、时间翻倍" | ✅ 采纳 | P0-3 + T-2 合并,目录结构按其建议;输出增加 p50/p95、回落值,并与基线 JSON 对比 |
| 11 | 实施顺序:M1 先保证配置生效 + 监控 + **真实基线**;M2 调度;M3 预算;预算分步接入 | ✅ 采纳 | §4 重写。我原先把 P0-3 放 M2,现提前到 M1(基线先于一切调优);**预算接入顺序**:普通派生 → HD → HEIC/视频,每步独立提交、独立基准 |
| 12 | 1434→500MB 是合成素材微基准,**不等于真实负载收益**,务必补 HEIC / 16-bit PNG / 渐进 JPEG / 混合 HD | ✅ 完全同意(附录 B 已声明) | P0-3 清单硬性包含这些素材;**P0-3 完成前,估算系数与 `MEDIA_BUDGET_MB` 默认值不得定稿** |
| 13 | 先完成 M1,审查后再进 M2/M3 | ✅ 采纳 | §4 为每个里程碑设**出口门禁**;M1 结束必须人工复核 |
| 14 | Rust:当前没必要,保留为未来选项 | ✅ 一致 | P3-2 不变 |

**不采纳 / 调整的点**:
- ChatGPT 在 M1 里没有列 P2-7(`files.ts` 限流 IP),我同意——它改变运行行为,不属于"配置生效 + 观测",**从 r1 的 M1 移到 M2**。
- 它把 P1-2(Sharp 并发与输入限制)整体放 M2。我**拆开**:`SHARP_CONCURRENCY` 与按像素的 `MEDIA_MAX_INPUT_MP` 可配置化放 M2;"按估算内存拒绝"依赖 P1-1 的估算器,放 M3。
- 压力保护(P1-6)它没给里程碑;我放在 **M4 开头**——预算器稳定后立刻补兜底,但不与预算器同批上线(否则无法归因)。

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
| F9 | 任务重试计数 `attempts` 只在**进程内存**(`queue.ts` 的 `Map`),而 `ready.ts` 每次启动会把所有 `status='pending'` 重新入队;数据库里 `pending` 同时代表"排队中"和"处理中",没有中断标记 | 【代码】;崩溃回路为【推断】 | 若某个文件会让进程崩溃(OOM kill / `SIGBUS`),它会在**每次重启后再次被处理再次崩溃**。P2-9 |
| F10 | 变量命名不一致:compose 现有映射用 `PGS_*` 前缀(`PGS_HEIC_CONCURRENCY`…),而 README 的 1C1G/2C4G 配方让用户在 `.env` 里写**无前缀**的 `HD_CONCURRENCY`;两套名字并存,用户很难知道哪个生效 | 【代码】 | D-2 统一约定:新增映射沿用 README 的无前缀名,已有 `PGS_*` 保持兼容 |

---

## 3. 计划

**默认决策**(无需再确认):不重写后端、不引入 Rust;先修部署与观测,再做统一预算;画质默认值不动;每项改动都带验收指标,改动队列/闸门后必须重跑 `project.md` §17.3 的基准。

### P0 — 先做(低风险,让后续优化可度量)

#### ⬜ D-2 修 compose 变量传递(F1、F7、F10)— r2:改为"显式映射 + 自动校验",不用整份 `env_file`
- **做什么**:
  1. 在 `app.environment` 里**逐项映射**容器确实需要的变量,按组注释:
     - 性能/并发:`HD_CONCURRENCY`、`HD_CACHE_MAX_MB`、`HD_CACHE_TTL_DAYS`、`HD_WIDTH` 等 `HD_*`、`THUMB_WIDTH`、`PREVIEW_WIDTH`、`EXIF_*`、`SCAN_*`、`DB_POOL_MAX` 等;
     - 安全/反代:`COOKIE_SECURE`、`SESSION_DAYS`、`ALLOWED_HOSTS`、`PUBLIC_BASE_URL`、`ALLOWED_MOUNT_ROOTS`、`GUEST_*`、`HD_RATE_*`;
     - 存储/上传:`MAX_UPLOAD_MB`、`MIN_FREE_DISK_MB`、`S3_*`、`CORRUPT_AUTO_PURGE_HOURS`。
     写法 `NAME: ${NAME:-}`,**沿用 README 使用的无前缀名**(F10);已有的 `PGS_*` 映射原样保留。
  2. **空串语义**:`config.ts` 的 `int()/num()` 已确认"空串 = 未设置 → 默认值";`flag()/enumOf()/list()` 与字符串类(`PUBLIC_BASE_URL`、`S3_*`)实施前**逐个确认**空串等价于未设置,否则给显式默认值。
  3. **不映射**:仅 compose 自用的变量(`PGS_TAG`)、构建参数、与应用无关的变量——在 D-4 的校验清单里**显式登记为"不映射"并写理由**。
  4. D-3 同批:`PGS_TAG` 默认值与 `.env.example` 对齐到当前版本;`.env.example` 补 `SCAN_MAX_DEPTH`;`mem_limit`/`cpus` 写成可直接取消注释的形式。
- **为什么不用 `env_file: [.env]`(r1 的推荐)**:它会把 `.env` 里所有内容(含与应用无关的变量、各种密码)一股脑注入容器,违背最小权限;显式映射的缺点是"新增配置容易漏映射",这正是 F1 的成因——所以必须配套 **D-4 的校验**(`config.ts` 读取的每个环境变量,要么出现在 compose 映射里,要么在"不映射"清单里),把"漏映射"变成 CI 失败。备选的"专用 `app.env`"也可行,但会让用户维护两份文件,不选。
- **验收(三层)**:① `docker compose config` 输出里能看到 `HD_CONCURRENCY` 等;② **运行中的容器**里 `docker exec <c> printenv | grep -E 'HD_|COOKIE_SECURE|THUMB_'` 与 `.env` 一致(故意设置 `HD_CONCURRENCY=1` 验证);③ `GET /status` 的有效配置(`config.hdConcurrency` 等)随 `.env` 变化,且**不设置时回落到代码默认**(验证空串回落)。最后用此方法把 README 的 1C1G 配方端到端复测一次。
- **风险**:白名单漏项 = 静默失效(靠 D-4 校验兜底);空串被某个解析器当成有效值(第 2 点逐个确认)。
- **工作量**:S~M(1~1.5h,含校验清单与容器内复测)。**这是 M1 的第一件事:它决定其余所有调参是否真的生效。**

#### ⬜ P0-2 观测补全(F5)
- **做什么**:`/status` 的 `memory` 扩展为 `{rss, heapUsed, heapTotal, external, arrayBuffers, maxRss, cgroup:{current, max}}`(cgroup v2 读 `/sys/fs/cgroup/memory.current|memory.max`,v1 回落 `memory.usage_in_bytes`);新增 `sharp:{cache: sharp.cache(), counters: sharp.counters(), concurrency: sharp.concurrency()}`;`queue` 增加各闸门(`heic/video/hd`)的 `active/waiting`;记录一个"最近 10 分钟 RSS 最大值"滑动窗口。`SystemTab.tsx` 展示这些字段。
- **验收**:压测(批量上传 + HD 并发)后能从 `/status` 一眼看出峰值时刻、各闸门排队长度、external 与 RSS 的差;`limiter()` 需要暴露 `{active, waiting}` 的只读统计。
- **风险**:`/status` 有 5 秒缓存,峰值窗口要独立采样(`setInterval(...).unref()`,每秒一次即可)。
- **工作量**:S~M(2h)。
- **r2 追加**:① cgroup 额外导出 **`anon`**(`memory.stat` 的 anon 字段,不含可回收页缓存)——`memory.current` 含 page cache,会随读写大文件虚高,P1-6 的阈值必须以 `anon`(或 `current − inactive_file`)为准;② 可选 `perf_hooks.monitorEventLoopDelay`(P3-1 的触发条件之一);③ 为 P1-1 预留 `admission:{used,max,waiting,exclusive,lowConfidence}` 字段(M1 先返回空/0)。

#### ⬜ P0-3 用真实素材建立基线,脚本正式入库(原 P0-3 + T-2 合并;r2 扩充)
- **做什么**:把附录 A 的微基准整理成**入库的基准套件**(入库属于代码改动,放在实施阶段):
  ```text
  scripts/bench/
    generate-images.mjs   # 合成素材(隔行/非隔行 PNG、渐进/基线 JPEG、TIFF、16-bit PNG…)
    bench-memory.mjs      # 派生图 / HD convert:×1、×4 并发,每场景独立进程取 VmHWM
    bench-hd.mjs          # HD 水印 ×1/×3/×24,以及混合 HD 请求(大小图混合、命中/未命中缓存)
    bench-queue.mjs       # 队列与闸门:100 HEIC + 100 JPEG、1 大图 + 20 小图 的完成时间分布
    README.md             # 如何运行、如何解读、基线 JSON 的更新规则
  ```
- **素材清单(硬性要求,缺一项就不算完成)**:NASA 素材(`fetch-samples.mjs`);**HEIC**(iPhone 12MP、48MP,含竖拍/方向标记);BMP;**16-bit PNG**;CMYK TIFF;**渐进 JPEG**;**隔行 PNG**;外加一组真实相机 JPEG(24MP+)。
- **环境**:**容器内**运行(带 jemalloc、`MALLOC_ARENA_MAX=2`),并同时记录 CPU/内存/Node/sharp/libvips 版本。
- **每个场景记录**(r2:不只看峰值):单任务峰值、N 并发峰值、**静置 20s 后回落值**、**总耗时与单任务 p50/p95**、`/status` 里的 `external/arrayBuffers`。输出 Markdown 表 + JSON;JSON 与上一次基线比对,**同时报告内存与耗时的变化**,防止"峰值降了、时间翻倍"和"只盯隔行 PNG、普通 JPEG 变慢"。
- **验收**:`project.md` §17.4 的"未测"清单清零;能解释 README 里"24 并发 HD 1897MB"由哪几个并发任务构成;基线 JSON 入库,之后每次改媒体处理逻辑都能一键对比。
- **Gate**:**本项完成之前,P1-1 的估算系数与 `MEDIA_BUDGET_MB` 默认值只能标记为"临时",不得定稿。**
- **工作量**:M(0.5~1 天,含素材准备)。

### P1 — 核心优化(预期收益最大)

#### ⬜ P1-1 像素加权的统一内存预算 + 单点准入控制(`MediaBudget` / `admit()`)— r2 重写
- **问题**:并发只按"任务个数"限制,而单任务工作集差 5~9 倍(F3);派生槽、`heicGate`、`videoGate`、HD `gate` 互不感知(`project.md` §17.1-5)。
- **设计原则(r2)**:

  **① 预算是准入条件,不是第二个队列。** `queue.ts` 继续负责"任务清单 / 去重 / 重试 / dirty";**"何时可以开跑"只由一个 `admit()` 决定,所有等待只发生在这一处**。判定顺序固定:`类别并发上限(image/heic/video/hd 的 CPU 并发)→ 内存预算(含 P1-6 的压力折扣)→ 优先级 + aging`(交互式 HD > 后台派生;等待超过 N 秒的大任务开始阻塞后来的小任务,防饥饿)。HD 请求与后台队列共用同一张等待表,取代各自独立的 gate。

  **② 估算是可校准的策略,不是固定映射。** 新文件 `server/media/budget.ts`(准入) + `server/media/estimate.ts`(估算) + 系数表(独立文件):
  ```ts
  interface MediaMemoryEstimate {
    estMB: number; format: string; width: number; height: number;
    confidence: "high" | "medium" | "low"; reason: string;   // reason 用于日志/UI/调试
  }
  function estimateMemory(meta: SharpMetadata /* 或 HEIC ispe 等 */, stage: "derive" | "hd" | "watermark"): MediaMemoryEstimate
  ```
  系数表按 `格式 × 渐进/隔行 × 位深 × 色彩空间` 索引,**每格记录来源**:`measured`(P0-3 实测,high)/`extrapolated`(相邻格外推,medium)/`guess`(无数据如 HEIC、CMYK、16-bit,low)。**`low` 置信度的估算自动 ×1.5**(宁可保守),`/status` 暴露 `lowConfidenceCount`,提示该补测哪一格。新增 RAW/AVIF 只需加一行。初值(仅起点):流式(基线 JPEG / 非隔行 PNG / TIFF)≈ 1.5 B/px;渐进 JPEG / 隔行 PNG ≈ 3.6 B/px;16-bit ×2;HD 水印合成 ≈ 15 B/px × W×H;统一再乘 1.25。
  > 估算只考虑"像素与格式",真实峰值还受解码器内部工作区、resize 中间图、色彩空间转换、输入输出同时存活、libvips 线程数影响——这就是需要 P0-3 校准、且需要 P1-6 兜底的原因。

  **③ 软预算 / 硬限制,语义分开。**

  | 参数 | 语义 | 默认(起点,待校准) |
  |---|---|---|
  | `MEDIA_BUDGET_MB` | **软预算**:并发任务的估算总和上限。单个任务估算超过它时,**仅当当前没有其他任务持有预算时才独占启动**,期间其他任务等待;`/status` 标记 `exclusive` | 见 ④;`0` = 关闭预算(行为回到现状) |
  | `MEDIA_MAX_EST_MB` | **硬限制**:单任务估算上限。超过则**拒绝**,`error` 带固定前缀(如 `超出内存上限:…`),UI 与"疑似损坏文件"区分展示 | `MEDIA_BUDGET_MB × 1.5`,且不超过"可用上限"(见 ④) |

  **④ 预算基数先扣基础开销。** `可用 = limit × (1 − margin) − baseRss`;`MEDIA_BUDGET_MB = clamp(可用 × f, 256, 2048)`。`margin` 初值 0.15(安全余量);`baseRss` = 空载 RSS + 常驻增量(Next 约 250MB,以 P0-2 观测为准);`f` 初值 0.7(libvips 之外还有 Next、DB 连接池、wasm、页缓存)。PostgreSQL 在**独立容器**时不计入;SQLite 模式或同容器部署需把其缓存计入 `baseRss`。无 cgroup 限制时取 `os.totalmem() × 0.4`。示例:1GB 容器 ≈ (1024×0.85−250)×0.7 ≈ 434MB。**`/status` 展示推导过程**(limit、baseRss、margin、f、结果),方便排错。

  **⑤ 预算覆盖完整资源生命周期(修正 r1 的缺陷)。** r1 写的"HD `convert` 与水印是两次独立 `run`"**有缺陷**:convert 释放预算后,它产出的 WebP Buffer 仍然活着,水印阶段若只按自身申请就会漏计。新规则:
  - **一次 HD 请求 = 一次 reservation**,覆盖 convert(缓存未命中时)+ 水印合成 + 响应写出期间所有仍存活的资源。`estimateHdPipeline(meta, {cacheHit})`:命中 → 基图 Buffer + 水印阶段;未命中 → `max(convert 阶段, convert 产物 + 水印阶段)`(取 max 而非 sum 的前提是 convert 的解码工作集在产物生成后已释放,**该假设要用 P0-3 验证**)。
  - 响应 Buffer 的存活期计入,在写出完成后才释放预算。
  - **禁止嵌套申请**(防死锁):流水线内部函数不得再调 `run`;开发/测试模式用 `AsyncLocalStorage` 检测嵌套并直接抛错。
  - 预留 `reservation.adjust(newEstMB)`(升/降)接口,**首版不用**;仅当某条流水线阶段间差异很大时再启用,避免"先释放再重新申请"的缝隙。
  - HEIC/BMP 同理:整个 `processMedia`(解码 + 派生)是一次 reservation,不拆。

  **⑥ 估算需要先读文件头。** `sharp().metadata()` 只读头部(KB 级)。流程:入队 → **probe**(独立的小并发,不占预算)→ `admit()`(类别 + 预算 + 优先级)→ 执行。HEIC 的 sharp 预编译版读不了头:解析 `ispe` box 取宽高(`extractImageMeta` 已在读 HEIC 容器),失败则回落"文件大小 × 系数",置信度 `low`。

- **接入顺序(r2,每一步单独提交、单独跑基准,以便归因)**:**a.** 普通派生图(`processMedia` 的 sharp 路径)→ 对比"估算 vs 实测 ΔRSS" → **b.** HD 整条流水线 → **c.** HEIC / BMP → **d.** 视频(ffmpeg 子进程,不走 libvips,按固定权重)。每步门禁:`high` 置信度的格子,实测峰值增量 / 估算值落在合理区间(不低估;高估不超过约 1.6 倍),否则先修系数再进下一步。
- **验收**(用 `scripts/bench/` 回归):① 4×100MP 隔行 PNG 峰值 ≤ 550MB(现 1430MB;**合成素材结论,以 P0-3 真实素材复测为准**);② 1×大图 + 20×24MP JPEG:总耗时劣化 < 50%、p95 不显著变差、峰值不高于现状;③ 24 路 HD 并发(含大图、含混合尺寸)峰值显著低于现状;④ `MEDIA_BUDGET_MB=0` 时行为与现状一致;⑤ 输出"估算 vs 实测"偏差表;⑥ **纯逻辑单测**(`node --test`,不依赖 sharp/DB):放行 / FIFO / aging / 独占 / 硬限制拒绝 / 不嵌套 / 类别上限与预算联合判定 / 低置信度加成。
- **风险**:估算偏低 → 预算形同虚设(靠 P0-3 校准 + `/status` 的 `external` 对照 + **P1-6 兜底**);估算偏高 → 吞吐下降(只影响极端输入);死锁(靠"不嵌套"规则与检测);`admit()` 成为单点——必须有单测与超时/取消路径(请求断开时要从等待表摘除)。
- **工作量**:L(2~3 天,分 a~d 四步,含校准)。**这是整份计划的核心。**

#### ⬜ P1-2 把硬编码阈值变成配置,并按估算拒绝极端输入(r2:拆成两步)
- **第一步(M2,不依赖预算器)**:新增 `SHARP_CONCURRENCY`(默认 2,低内存机器设 1)与 `MEDIA_MAX_INPUT_MP`(默认保持 268 以兼容现有数据;低配机器建议 100),**只按像素**判断。同步 `project.md` §10.2(这两项从"硬编码"移到"环境变量")、`.env.example`、compose 映射(D-2 的校验会强制这一点)。
- **第二步(M3,依赖 P1-1 的估算器)**:启用 `MEDIA_MAX_EST_MB` 的**硬限制**——估算超限时**失败并给出明确原因**("图片 12000×9000 渐进编码,估算需要 ~380MB,超过上限"),`error` 加固定前缀,UI 上与"疑似损坏文件"区分(避免被 `CORRUPT_AUTO_PURGE_HOURS` 误清理——**这一点必须核对**)。
- **不做**:不把默认上限一刀切降到 60~100MP(见 §1 第 6 行)。
- **验收**:设 `SHARP_CONCURRENCY=1` 后 `/status` 反映;`MEDIA_MAX_INPUT_MP=50` 时 100MP PNG 得到明确失败原因且不进入解码;第二步:超硬限制的文件不会被自动清理流程当作损坏文件删除。
- **工作量**:S(第一步 1h;第二步 1h)。

#### ⬜ P1-3 队列分池,消除嵌套闸门的队首阻塞(F2)
- **问题**:见 F2。典型:缩略图槽位 4、`heicGate` 1,队列里 `HEIC-1/2/3, JPEG-1`——前三个先占槽再等 gate,JPEG 明明能跑却被堵住。
- **做什么**:让 `pump()` 取下一个任务时就知道它的类别(`image` / `heic` / `video`),按类别各自的容量选取"下一个可运行"的任务(跳过暂时无容量类别的队首),而不是先占槽再排队。类别在入队处就有(`ingest.ts`/`albums.ts`/`reprocess` 都知道文件名/kind):`enqueue(id, {priority, cls})`,缺省 `image`。
- **r2 约束:按 `admit()` 的形状实现**。把"能不能启动这个任务"写成一个独立的、可单测的判定函数(M2 只含**类别并发**这一条),并预留"预算"与"优先级/aging"两个判定位。**M3 把预算并入同一个 `admit()`,而不是再加一个队列**(见 P1-1 ①)。否则会得到"分池消除了 HEIC 队首阻塞,却又被大图长期占预算堵住小图"的新问题。
- **HD 的 HEIC 转换**:现与后台队列共用 `heicGate`,交互式请求要排在后台任务之后。M2 先给 HD 路径独立的容量或更高优先级;M3 统一进 `admit()`(交互式优先)。
- **先写测试(T-3)**:"100 个 HEIC + 100 个 JPEG 同时入队":JPEG 完成时间不被 HEIC 拖到最后,**且 HEIC 在持续到来的 JPEG 流中也不被饿死**;重试、`dirty`、优先级插队路径保留类别。
- **验收**:上述用例通过;`/status/queue` 增加按类别的 `running/waiting`;批量 HEIC 导入期间 JPEG 吞吐接近无 HEIC 时。
- **风险**:`enqueue` 调用点多(上传、扫描、重处理、黑名单恢复、启动恢复),类别缺省必须安全;`dirty`/重试路径要保留类别。
- **工作量**:M(0.5~1 天)。

#### ⬜ P1-4 降低 HD 水印的重复成本(F4)— r2:写清安全边界
- **先测量**(依赖 P0-2、P0-3):同一张 2560px 图,缓存命中时 `serveHd` 的 CPU 耗时与瞬时内存;确认水印合成是否确实占大头。**测量结果不支持就不做。**
- **核心原则(写进代码注释与测试名)**:**缓存的是"图片处理结果",不是"访问权限"。** 命中缓存**不能**跳过任何权限检查。
- **候选方案**(按收益/风险排序,逐个验证):
  1. **游客水印结果缓存**(游客水印不含用户标识,结果确定):
     - **Key 必须包含**:`图片 id + 版本(ver/内容 hash)+ 输出宽度 + 水印配置版本(wmVer:文字/位置/透明度/字体等任一变化即变)+ 规范化 host`。
     - **host 必须先通过校验**(`ALLOWED_HOSTS`/`PUBLIC_BASE_URL`/请求自身 Host 的现有规则);**未通过校验的 host 不写缓存**(仍可正常出图),避免伪造 Host 撑爆缓存。
     - **容量与过期**:落 `cache/hd/wm/`,与基图同一套 LRU/TTL,容量计入 `HD_CACHE_MAX_MB`;另设水印缓存条目数上限。
     - **每次请求仍重新校验**:图片是否存在、可见性、相册权限、黑名单、速率限制——先于任何缓存读取。响应头保持 `no-store`。
     - **失效点(缺一不可)**:原图替换/重新处理(ver 变化)、可见性变更、**水印配置变更**、删除/黑名单、`invalidateHd(id)`。
     - 登录用户因带 `U-XXXXXX` 不缓存。
  2. **存放介质**:**默认磁盘**(复用现有缓存基础设施,页缓存可回收)。ChatGPT 提议先用内存 LRU——它会**直接抬高 RSS**(水印后 WebP 约数百 KB,100 项即几十 MB),与降内存的目标冲突,仅在测量显示磁盘 IO 成为瓶颈时作为备选。
  3. `loadVisibleImage` 只 select 必要列(P2-3)。
  4. 水印层预先栅格化为"原始 RGBA 瓦片"并只合成需要的区域——复杂度高,**仅当 1~3 之后仍是瓶颈才考虑**。
  5. 前端同一张图在一次查看会话内复用 Blob(`useHd` 已保留相邻 ±1 张):只在**页面内存**里短暂复用,不得违背"每次重校验权限"的设计。
- **验收**:同一张图第二次打开,服务端 CPU 耗时下降(游客)/ 不变(登录);`scripts/test-hd.mjs` 的 49 条安全测试全部通过;**新增 T-4**(权限每次重校验、各失效点、Key 隔离、伪造 Host 不撑爆缓存、水印配置变更后不命中旧缓存)。
- **与 P1-1 的关系**:缓存命中路径的 reservation 只含"读取 + 流出",远小于未命中路径(P1-1 ⑤)。
- **工作量**:M。

#### ⬜ P1-5 HEIC:评估原生解码子进程(文件进、文件出)
- **背景**:`heic-convert` = libheif 的 wasm 版 + 纯 JS JPEG 编码,整文件进 Buffer、整图 RGBA 在 wasm 堆里;wasm 线性内存【推断】只增不减。HEIC 又占派生槽位(F2)。
- **候选**:Debian bookworm 的 `libheif-examples`(`heif-convert`,原生)通过 `execFile` 把 `x.heic` 转成临时 JPEG 文件,再交给 sharp;子进程结束即把内存还给系统,Node 侧不再持有大 Buffer;保留 `heic-convert` 作回退(与 ffmpeg 可选的现有模式一致)。镜像 +约 20~30MB。
- **必须先验证**:方向与镜像/翻转(`irot/imir`)是否被正确应用且不与 sharp `.rotate()` 重复旋转;ICC 与 10-bit HEIC;HEIF 网格/多帧/Live Photo;HEVC 解码器的许可与专利立场(个人自托管通常可接受,但应写进 README);EXIF 仍从原文件读取(`extractImageMeta(file)` 已如此,不受影响)。
- **验收**:iPhone 12MP 与 48MP 样张,对比 `heic-convert` 的峰值 RSS、耗时、画面一致性(PSNR/肉眼)、方向正确性;批量 50 张后静置 RSS 是否回落。
- **工作量**:M。若验证不通过(许可/兼容),保留现状并把 HEIC 权重在 P1-1 中调高、`HEIC_CONCURRENCY` 默认保持 1。
- **r2 追加**:① HEIC 的**内存估算**:原生子进程的内存在 Node 之外,不占 Node 堆但仍占容器内存——预算里要计入(按子进程实测峰值),不能因为"在子进程里"就不计;② 必须验证并记录结果的清单保持不变(方向/镜像、ICC、10-bit、网格/多帧/Live Photo、许可),**内存下降但 iPhone 照片方向错或颜色变了,视为失败**;③ 子进程要有**超时 + 输出文件清理 + 失败回落**(回落到 `heic-convert` 时按其更高的内存估算申请预算)。

#### ⬜ P1-6 动态内存压力保护(r2 新增,ChatGPT 建议)
- **为什么**:P1-1 是"预测后准入",预测必有误差(附录 B 的局限、未覆盖的格式)。需要一个**运行时兜底**:预测错了,系统也不应走到 OOM kill。
- **状态机**(初始阈值只是参考,须结合 `baseRss`、cgroup 与 P0-3 压测调整):

  | 水位(`anon / limit`) | 状态 | 调度行为 |
  |---|---|---|
  | < 70% | 正常 | 正常准入 |
  | 70%–85% | 偏高 | 有效预算 × 0.7(降低新任务准入) |
  | 85%–93% | 高 | 暂停**重型**任务(估算 > 阈值的、HEIC、视频、大图 HD);轻任务继续;交互式 HD 超时返回 `503 + Retry-After`,而不是排到被 OOM |
  | > 93% | 紧急 | 暂停全部新的媒体准入;`sharp.cache(false)` 确认关闭;日志告警 |

- **关键技术点**:
  - 水位以 **`anon`**(P0-2 导出)为准,**不要**直接用 `memory.current`——它含可回收页缓存,会因读大文件而误触发。无 cgroup 限制时用 `RSS / os.totalmem()`。
  - **迟滞**:进入某状态后,需水位回落到阈值以下 5 个百分点并**连续 N 次**采样才降级,避免抖动。
  - **永不死锁**:任何状态下,只要当前没有运行中的媒体任务,就必须放行一个(紧急状态下放行最轻的)。
  - 采样沿用 P0-2 的每秒采样器(`unref()`),状态机本身写成**纯函数**(输入水位序列 → 输出状态),便于单测。
  - 与 `admit()` 的关系:压力状态只是 `admit()` 的一个输入(预算折扣 / 重型任务暂停),**不新增第二处等待**。
- **验收**:① 状态机纯逻辑单测(升降级、迟滞、永不死锁);② 故意把估算系数调成实际的 0.3 倍(模拟严重低估),跑 `bench-queue`/`bench-hd` 混合负载,**RSS 不越过容器上限**,吞吐下降但全部任务最终完成;③ `/status` 展示当前状态与最近一次状态切换原因。
- **依赖**:P0-2(anon)、P1-1(`admit()`)。**放 M4 开头,不与预算器同批上线**(否则无法判断改善来自哪一个)。
- **工作量**:M(1 天)。

### P2 — 次要优化与卫生项

| ID | 状态 | 内容 | 验收 / 说明 |
|---|---|---|---|
| P2-1 | ⬜ | **BMP**:`bmpToPng` 整文件 + RGBA + PNG Buffer。加像素上限(并入 P1-2 的估算);若 ffmpeg 可用,改用 `ffmpeg -i x.bmp -frames:v 1 out.png` 文件进文件出 | 罕见格式,低优先;验收:50MP BMP 不再产生数百 MB 的 Node Buffer |
| P2-2 | ⬜ | **`.toBuffer()` → `.toFile()`**(`makeDerived`、`convert`、水印输出):仅作代码卫生,**预期内存收益 ≈ 0**(实测);保留 tmp+rename 的原子写入 | 峰值不应变化;好处是少一次 Buffer 复制 |
| P2-3 | ⬜ | **列投影**:`processMedia` 与 `hd/service.ts#loadVisibleImage` 都 `select()` 整行(含 `meta` jsonb、`search_text`);改成 `files.ts#FILE_COLS` 那样只取必要列 | HD 取图每次请求少拉一次大 jsonb;`processMedia` 需要 `meta` 以外的列 |
| P2-4 | ⬜ | **前端窗口化**:`Gallery.tsx` 的 `items` 只增不减,无 `content-visibility`。先量化(5k/20k 项时 DOM 节点数与标签页内存);再做"按列累计高度只渲染视口 ±N 屏、其余用占位高度"的窗口化(列高可由 `aspect-ratio` 精确得到);同时评估为网格增加更小的缩略档(如 360px)或 `srcset`,当前 `THUMB_WIDTH=720` 对 6 列桌面网格偏大 | 验收:2 万项滚动到底,DOM 节点数与内存近似常数;滚动/回顶无闪烁;`pgs:changed` 刷新后保持位置 |
| P2-5 | ⬜ | **部署指引**:README/compose 给出"容器内存 → 推荐 `PGS_NODE_HEAP_MB`/`THUMB_CONCURRENCY`/`HD_CONCURRENCY`/`MEDIA_BUDGET_MB`"对照表(堆 ≈ 容器上限的 25%~35%,默认 1024 不适合 1GB 机器);`docker-compose.yml` 提供可直接取消注释的 `mem_limit`;`/status` 展示 cgroup 上限(P0-2) | 1GB/2GB/4GB 三档各跑一次 P0-3 的基准,写入文档 |
| P2-6 | ⬜ | **扫描内存**:用 10 万文件平铺目录实测 `scanAlbum` 的堆峰值与耗时;若 > 200MB 再改成 `opendir` 流式 + 1000 条一批查库 | 先测再决定,**默认不改** |
| P2-7 | ⬜ | **`files.ts` 密钥限流 IP**(F6):改用 `router.ts#clientIp(req)`(r2:它改变运行行为,**归 M2,不放 M1**) | 单元/e2e 增加"带 `TRUST_PROXY` 时按 XFF 倒数第 n 段限流" |
| P2-8 | ⬜ | `.env.example`/README 补 `SCAN_MAX_DEPTH`、`MEDIA_BUDGET_MB`、`MEDIA_MAX_EST_MB`、`SHARP_CONCURRENCY`、`MEDIA_MAX_INPUT_MP`(随 P1 落地;D-4 校验会强制) | 与 `project.md` §10 对齐 |
| P2-9 | ⬜ | **作业生命周期与崩溃回路保护**(F9,r2 新增,轻量版,**不引入 Worker**):现状 `pending` 既表示排队也表示处理中,`attempts` 只在内存,重启后会无限重试"会让进程崩溃的文件"。做法:给 `media` 增加 `attempts`(持久化)与 `processing_started_at`(或等价的租约时间),启动恢复时:`processing_started_at` 非空且超时 → 视为**中断**,`attempts+1` 后重新入队;超过上限(如 3)→ 置 `failed`,`error` 用固定前缀(如 `处理中断(疑似导致进程崩溃)`)。**写磁盘用 tmp+rename 已保证产物原子**,所以重复执行是幂等的;启动时已有 `cleanTmp(0)` 清残留。需要一次 schema 变更(Drizzle 迁移 + `project.md` §4 同步) | 验收:人为让某文件处理时 `kill -9` 进程,重启 3 次后该文件进入 `failed` 而不是反复崩溃;其余文件正常恢复;**不影响**现有的 pending 恢复与"重新处理"流程。完整的 PENDING/RUNNING/SUCCESS/FAILED/INTERRUPTED 状态机见 P3-1 前置条件 |

### P3 — 架构演进(只在触发条件成立时做)

#### ⏸ P3-1 独立的 Node 媒体 worker 进程(不是 Rust)
- **价值**:① 崩溃隔离——挂载目录的 `SIGBUS`(已用私有副本规避)与 OOM 不再拖垮 Web/API;② **可回收**——worker 的 RSS 超阈值或处理 N 个任务后优雅重启,同时解决 glibc 碎片与 wasm 内存不回落;③ 独立的 `--max-old-space-size`、`MALLOC_ARENA_MAX`、cgroup 配额;④ Web 事件循环不再被媒体任务影响。
- **形状**:`child_process.fork()` 同一份 TS/JS(`derive.ts`、`hd` 的 convert/水印),父子之间只传 JSON({jobId, 输入路径, 输出路径, 参数}),**绝不传图片 Buffer**;预算器(P1-1)放在父进程做准入,worker 内只负责执行;DB 写回仍由父进程做(或 worker 持有自己的连接,二选一,倾向父进程以保持单点)。
- **触发条件**(任一):`/status` 观察到事件循环延迟被媒体任务拖高(P0-2 可加 `perf_hooks.monitorEventLoopDelay`);出现容器 OOM kill 或 `SIGBUS` 崩溃;P1-5 验证后仍需回收 wasm 内存。
- **工作量**:L。
- **前置条件(r2 新增,ChatGPT 建议:拆 Worker 之前先把这些设计好)**:
  1. **作业生命周期**:`PENDING → RUNNING(租约:worker id + 开始时间 + attempt)→ SUCCESS | FAILED | INTERRUPTED`;`INTERRUPTED` 在 attempt 未超限时可安全重新执行,超限转 `FAILED`。P2-9 是它的轻量前身——先做 P2-9,再扩展。
  2. **Worker 意外退出**:父进程监听 `exit`,把该 worker 持有的 `RUNNING` 作业转 `INTERRUPTED` 并重启 worker(带退避,防止崩溃风暴)。
  3. **幂等**:同一作业重复执行结果相同(输出走 tmp+rename、以 `id + ver` 为键);父进程重启后,`RUNNING` 超租约的作业按 2 处理。
  4. **临时文件**:约定统一 tmp 目录与前缀,启动与 worker 重启时清理;数据库状态与磁盘文件不一致(库里 `ready` 但文件缺失,或反之)有对账/自愈路径。
  5. **准入仍在父进程**(`admit()`),worker 只执行;预算 reservation 的释放要覆盖"worker 崩溃"这条路径(父进程在 `exit` 事件里强制释放)。

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
| D-4 | ⬜ | **防止文档再次漂移**:加一个 `scripts/check-docs.mjs`(零依赖),CI 里比对 ① 路由清单 ↔ `project.md` §8、② `config.ts` 环境变量 ↔ §10/`.env.example`、③ `find src` 文件清单 ↔ §3、④ `package.json` 版本 ↔ compose/`.env.example` 的 `PGS_TAG`、**⑤(r2,配合 D-2)`config.ts` 读取的每个环境变量 ↔ compose `app.environment` 映射,或登记在"显式不映射"清单(含理由)——漏映射即失败**。偏差即失败(或先只告警)。`project.md` §0 已列出人工核对命令,这一步把它们自动化 |
| D-5 | ⬜ | `project.md` §8 中仍有少量参数描述未逐条核对(如各接口的取值范围),下次碰到相应接口时顺带校对 |
| D-6 | ✅ | `project.md` 表格里未转义的 `\|`(渲染错位)——本次已修 |

### T — 测试

| ID | 状态 | 内容 |
|---|---|---|
| T-1 | ⬜ | **性能/内存回归**:`test.yml` 增加手动/夜间触发的 job:合成素材(含隔行 PNG、渐进 JPEG)+ 读取 `/status` 的 `maxRss` 与各闸门排队长度,**宽松断言**(例如 4×隔行 PNG 峰值 < 阈值),避免 CI 机器差异造成抖动;PR 默认不跑 |
| T-2 | ⬜ | **基准脚本入库** = P0-3 的 `scripts/bench/*`(r2:已合并,目录结构见 P0-3),输出 Markdown 表 + JSON,可直接贴进 `project.md` §17.3 |
| T-3 | ⬜ | 队列分池(P1-3)、`admit()` 与预算器(P1-1)、压力状态机(P1-6)的**纯逻辑单测**(`node --test`,不依赖 sharp/DB)。**先于实现编写**(P1-3 的"HEIC 不堵 JPEG / 不饿死"用例是 M2 的验收标准) |
| T-4 | ⬜ | **HD 水印缓存安全测试**(P1-4,r2 新增),并入 `scripts/test-hd.mjs`:① 缓存命中仍每次重新校验权限(可见性变更后立即 404);② 原图替换 / 水印配置变更 / 删除 / 黑名单后不命中旧缓存;③ Key 隔离(不同宽度、不同 host、不同 ver 互不串);④ 伪造 Host 不写缓存、不撑爆容量;⑤ 登录用户请求不命中游客缓存 |

---

## 4. 建议的执行顺序(r2:分阶段 + 出口门禁)

> **规则**:一次只做一个里程碑。**每个里程碑结束 = 提交 + 复核 + 人工确认门禁,通过后才进入下一个。** 里程碑内的子项尽量各自提交、各自跑基准,避免把"队列 + 闸门 + 预算 + HD"混在一起改,否则无法归因性能变化。

| 里程碑 | 内容 | 出口门禁(未满足不得进入下一阶段) |
|---|---|---|
| **M1 先让配置生效、能看见、有基线**(1.5~2 天) | **D-2**(含 D-3)→ D-1 → **P0-2** → **P0-3**(含 T-2 基准套件) | ① 运行中容器 `printenv` 与 `/status` 有效配置都与 `.env` 一致;② `/status` 能显示 `external/arrayBuffers/cgroup(anon)/sharp/各闸门排队`;③ 基线 JSON 入库,素材覆盖 HEIC / 16-bit PNG / 渐进 JPEG / 隔行 PNG / 混合 HD;④ **人工复核基线数据,据此确认或修正 M2/M3 的参数与优先级**;⑤ 本里程碑**不含任何改变处理行为的改动** |
| **M2 修调度**(1 天) | **T-3(先写测试)** → **P1-3**(`admit()` 仅类别并发)→ P1-2 第一步(`SHARP_CONCURRENCY`、`MEDIA_MAX_INPUT_MP`)→ P2-7 | ① "100 HEIC + 100 JPEG"用例通过(不堵、不饿死);② `bench-queue` 与 M1 基线对比:耗时不劣化;③ 本阶段**不引入内存预算逻辑** |
| **M3 统一内存预算**(2~3 天) | **P1-1**,按 **a 普通派生 → b HD 流水线 → c HEIC/BMP → d 视频** 分四次提交;每步后重跑基准;P1-2 第二步(硬限制) | ① 每步"估算 vs 实测"偏差表达标;② 混合负载(大图 + 小图、混合 HD)峰值下降且耗时/p95 可接受;③ `MEDIA_BUDGET_MB=0` 可回退到现状;④ 系数表中 `low` 置信度项清零或有明确说明 |
| **M4 兜底与专项优化**(按需) | **P1-6 压力保护(开头)** → P1-4(+T-4) → P1-5 → P2-9 → P2-1 → P2-3 | 各项自带验收;P1-4/P1-5 **先测量,数据不支持就不做** |
| **M5 前端与架构**(按需) | P2-4、P2-5、P2-6、D-4(其实可更早,见下注) | — |
| **观察期** | P3-*(含 P3-1 前置条件) | 仅在触发条件成立时启动 |

> 注:D-4(文档/配置漂移校验)成本低,且 D-2 的"显式映射"策略**依赖它防止复发**;建议在 M1 的 D-2 完成后立刻补上其 ⑤ 项,其余检查项可以随 M5 一起做。

**为什么 P0-3(基线)提前到 M1**(采纳 ChatGPT 的调整):没有真实基线,M2 的"耗时不劣化"、M3 的"估算校准"都没有参照物;而 M1 已经让配置真正生效,此时测得的基线才是用户真实部署的样子。**代价**:M1 从半天变成约 2 天(素材准备占大头)。

## 5. 明确暂不做 / 不建议做

- ❌ 把 `toFile` 当作内存优化项(实测无收益,仅 P2-2 卫生)。
- ❌ 下调 `THUMB_WIDTH`/`PREVIEW_WIDTH`/`HD_WIDTH` 来"省内存"(输出尺寸不是主因,只损失画质)。
- ❌ 一刀切把输入像素上限降到 60~100MP(按格式加权才合理,见 P1-1/P1-2)。
- ❌ 整体或部分改写成 Rust(见 P3-2)。
- ❌ 把 `HD_CACHE_MAX_MB` 当作内存手段(它只是磁盘上限)。
- ❌ 在没有 P0-2 观测数据前调整 `UV_THREADPOOL_SIZE`/`MALLOC_ARENA_MAX`(镜像里已有 jemalloc,README 有容器实测)。
- ❌ **整份 `env_file: [.env]` 注入容器**(r1 曾推荐,r2 撤回):违背最小权限;改用显式映射 + D-4 校验。
- ❌ **在 P0-3 完成前把估算系数 / `MEDIA_BUDGET_MB` 默认值定稿**:合成素材数据不能直接当生产参数。
- ❌ **把 `MediaBudget` 做成与 `queue.ts` 各自排队的第二个队列**:所有等待只发生在 `admit()`。
- ❌ **直接用 cgroup `memory.current` 做压力判据**:含可回收页缓存,会误触发,须用 `anon`。
- ❌ **一次性执行整个 todo**:按 §4 的门禁分阶段推进。

## 6. 度量与验收的统一口径

- **峰值**:进程 `VmHWM`(`/proc/self/status`)或 P0-2 的 `maxRss`;**回落**:任务结束后静置 20 秒的 RSS。
- **基线**:启动后空载 RSS(Next 约 250MB;裸 sharp 进程 61MB)。
- **场景**:派生图 ×1/×4;HD convert ×1/×3;HD 水印 ×1/×3/×24;混合负载(1 大图 + 20 小图);HEIC 批量 50 张。
- **报告**:每次改动后把结果追加到 `project.md` §17.3,并注明环境(CPU/内存/Node/sharp/libvips、是否容器、是否 jemalloc、素材来源)。
- **r2 追加**:① 每次报告除峰值与回落外,必须同时给出**总耗时与 p50/p95**,并与上一次基线 JSON 对比;② 预算相关改动必须附"**估算 vs 实测**"偏差表(每个素材一行);③ 混合场景(大小图混合、混合 HD、HEIC + JPEG 混合)与单一场景同等重要;④ 合成素材的结论要标注"合成",真实素材结果出来后以后者为准。

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

注意:演示里的 `acquire/release` 带有自己的等待队列,**仅用于演示峰值内存的变化**——正式实现不要照搬这种"独立队列"形态(见 P1-1 ①,等待只能发生在 `admit()`);演示里的 `1.5` 只是让隔行/渐进更"重"的粗糙系数;正式实现请按 P1-1 的"字节/像素"表估算 MB,并用 P0-3 的真实素材校准。

## 附录 B:本次评估的局限(重申)

合成素材、glibc 默认 malloc、非容器、Node 22;未测 HEIC/BMP/视频/16-bit/CMYK;未复现 README 的 1897MB;F1 基于 Compose 语义判断,尚未在真实容器内验证。上述项目在 P0-3 中补齐,**在此之前请把 §1~§2 的结论当作"高置信的方向判断",而不是精确的容量规划**。

**r2 补充**:ChatGPT 提醒的两点这里再强调——① 1434MB → 500MB 是**合成图片、特定环境**下的微基准,**不等于真实用户负载会得到同样的改善**;② 估算公式里的每个系数,在 P0-3 给出真实素材数据之前,都只是"起点"。P0-3 必须补齐 HEIC、16-bit PNG、渐进 JPEG 与混合 HD 请求,再确定最终参数。另外 F9 的"崩溃回路"是由代码推出的风险,尚未用 `kill -9` 实测复现(P2-9 验收时一并验证)。
