# todo.md — 性能 / 内存 / 可维护性改进计划

> 基线:`v1.4.3`(提交 `452b181`)。**修订记录**:r1 = 首版;r2 = 吸收 ChatGPT 对 r1 的第二轮评审(见 §1.5);**r3 = 结合全量源码(`config.ts` / `derive.ts` / `queue.ts` / `hd/*` / `corrupt.ts` / `ready.ts` / `bootstrap.ts` / `docker-compose.yml`)的第三轮深度交叉评审与落地防坑修正**(见 §1.6、F11~F18)。r1/r2/r3 三次提交都**只改文档,没有改动任何业务代码**。
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
| 4 | 各类并发各自为政,缺统一内存预算 | ✅ **完全同意,这是最重要的一项**。但不要拍脑袋设"权重 1/2/3",应按**像素 × 格式系数**估算,且权重可由文件头轻量探测获得(注意 `derive.ts` 现状是在解码 HEIC/BMP 后才调 `metadata()`,需前移为独立 `probe`,见 F16) | 【实测】4×100MP 隔行 PNG:无预算 1434MB → 预算后 500MB;混合负载只慢 2.5s→3.7s | **P1-1(提升为核心)** |
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
| 4 | **HD 不能拆成两次独立预算申请**:convert 释放后其产物 Buffer 仍存活,水印阶段会漏计 | ✅ **成立,r1 此处有缺陷** | P1-1 §5:一次 HD 请求 = 一次覆盖整条流水线的 reservation(r3 补充:须区分缓存 `hit` / `inflight` 合并 / `miss` 三种路径,见 F14);保留"禁止嵌套申请"(防死锁),并加开发期嵌套检测 |
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

---

## 1.6 第三轮:结合全量源码的交叉评审与防坑修正(r3 新增)

**总评**:经过 r1(微基准实测证伪伪优化、定位核心瓶颈)与 r2(确立单点 `admit()` 准入控制、软硬预算分离、动态压力兜底、M1 门禁先行),整体方案的**战略方向、优先级排序和架构抽象已经非常扎实(9/10)**。
但在将 r2 的设计与仓库真实源码逐行对照后,发现 **8 处「设计假设与现有代码实现脱节」的工程盲区(F11~F18)**。其中两处若直接按 r2 落地,会导致**配置依然不生效**(F11)甚至**用户上传的原图在 5 小时后被自动清理定时任务永久物理删除**(F12)。r3 在不改变主线架构的前提下,把这 8 处盲区全部补齐到对应任务与验收门禁中:

| # | r2 中的盲区或隐患 | 源码核查依据 | r3 修正 / 落点 |
|---|---|---|---|
| 1 | D-2 写"新增用无前缀名,已有 `PGS_*` 映射原样保留" | 【代码】`docker-compose.yml` 已有 `THUMB_CONCURRENCY: ${PGS_THUMB_CONCURRENCY:-4}` 等。若原样保留:① YAML 同名键唯一,用户在 `.env` 按 README 写 `THUMB_CONCURRENCY=2` **仍不生效**;② `:-4` 写死默认值会覆盖 `config.ts` 的 `Math.min(4, cpu)`,导致 1C1G 机器默认跑 4 并发;③ `config.ts` 的 `COOKIE_SECURE` 与 `S3_FORCE_PATH_STYLE` 未走 `flag()` | **F11 → D-2**:改为双变量回落且默认空串交还 `config.ts`(`${THUMB_CONCURRENCY:-${PGS_THUMB_CONCURRENCY:-}}`);`config.ts` 统一用 `flag()` 解析布尔项 |
| 2 | P1-2 / P2-9 把超内存上限或崩溃中断的文件置为 `status='failed'` 并加 `error` 前缀 | 【代码】`corrupt.ts#sweep` 每 10 分钟检查,停止上传满 `CORRUPT_AUTO_PURGE_HOURS`(默认 5h)后查 `WHERE status='failed'`(**完全不看 `error` 前缀**),对受管存储(`local`/`s3`)直接调用 `deleteMediaByIds(owned, true)` **物理删除用户原文件** | **F12 → P1-2 / P2-9**:在 `corrupt.ts`(`corruptSummary` / `purgeCorrupt` / `sweep`)中硬性排除非损坏失败前缀(`[LIMIT]` / `[INTERRUPTED]`),严禁自动清理误删原图 |
| 3 | `ready.ts` 启动恢复顺序存在竞态 | 【代码】`ready.ts` 第 53 行 `pending.forEach(enqueue)` 同步触发 `pump()` 立即在 `dirs.tmp` 创建临时文件,第 68 行才异步调 `void cleanTmp(0)`(删除 `tmp/` 下所有文件),可能删掉刚启动任务正在读的临时副本 | **F13 → P2-9(及 M2)**:启动恢复时必须先 `await cleanTmp(0)`,再执行 `setRunner(processMedia)` 与 `pending.forEach(enqueue)` |
| 4 | P1-1 §5 规定"一次 HD 请求 = 一次覆盖整条流水线的 reservation",未区分 `hit` / `inflight` / `miss` | 【代码】`hd/service.ts` 有 `getCached` 与 `inflight` 并发合并,且 DB `media` 行已有 `width`/`height`;若在 `getBase` 前一律按 `miss` 申请预算或去 `probe` 原文件:① 缓存命中被重任务阻塞;② `inflight` 合并请求重复扣减双倍预算;③ S3 模式下为 `probe` 提前下载整文件 | **F14 → P1-1 §5 / P1-4**:先鉴权 + 查缓存/`inflight`,按 `hit`(仅水印预算)、`coalesced`(等 `inflight` 后仅申请水印预算)、`miss`(全流水线预算)分流;估算优先用 DB 已有 `row.width/height`。顺带补齐 `hd/service.ts` 缺失的 BMP 支持、`ext` 私有副本与 `missingAt` 校验 |
| 5 | P1-4 只讨论了"结果缓存",漏掉 `hd/watermark.ts#buildLayer` 自身的双倍画布与二次 PNG 编解码 | 【代码】`watermark.ts` 先建 `(W+2*pad)×(H+2*pad)` 画布(2560×1707 时约 9MP,面积翻倍),`.composite(parts).png().toBuffer()` 编码成 PNG 后,紧接着又 `sharp(canvas).extract(...).png().toBuffer()` 二次解码再编码 PNG | **F15 → P1-4**:合并 `buildLayer` 的二次 PNG 编解码(或直接裁剪 overlay 到 `W×H`),对**登录用户**(带 `U-XXXXXX` 无法用游客磁盘缓存)和首次尺寸同样立竿见影 |
| 6 | P1-1 §6 假设 `probe` 可零成本调 `sharp().metadata()` | 【代码】`derive.ts` 是在 `materialize`(S3 会下载整文件)和 `heicToJpeg`/`bmpToPng`(已整图解码)之后才调 `metadata()`;`queue.ts` 入队只存 `id` | **F16 → P1-1 §6**:明确 `probe` 在解码前只读文件头(JPEG/PNG/TIFF/WebP 走 `sharp(file).metadata()`,BMP 读前 26 字节头,HEIC 读 `ispe` box);**S3 无 `localHints` 时不下载文件,直接按 `row.size + mime` 低置信度估算** |
| 7 | P2-9 写"需要一次 Drizzle 迁移" | 【代码】项目运行期不使用 Drizzle 迁移文件,而是由 `src/db/bootstrap.ts` 的 `PG_DDL` + `ALTER TABLE` 与 SQLite 的 `LITE_DDL` + `LITE_UPGRADE` 幂等升级,且 `src/db/index.ts` 有双驱动类型映射 | **F17 → P2-9**:明确同步 `schema.ts` + `bootstrap.ts`(PG 与 SQLite 双分支);租约时间统一用毫秒整型 `processing_started_ms`(同 `mtime_ms`),规避双驱动时间戳差异 |
| 8 | P0-2 / P1-6 提到读 cgroup `anon`,但未写明 v2/v1 的精确文件与键名;且忽略了 `Dockerfile` 的 `UV_THREADPOOL_SIZE=12` | 【代码】`Dockerfile` 设了 `UV_THREADPOOL_SIZE=12`;cgroup v2 的 `anon` 在 `/sys/fs/cgroup/memory.stat` 内而非独立文件 | **F18 → P0-2 / P2-5**:写明 `memory.stat` 解析规则(v2 取 `anon`,v1 取 `total_rss`);在 P2-5 的 1C1G 配方中一并纳入 `UV_THREADPOOL_SIZE` |

---

## 2. ChatGPT 没提到、以及代码交叉审查新发现的问题(F1~F18)

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
| F10 | 变量命名不一致:compose 现有映射用 `PGS_*` 前缀(`PGS_HEIC_CONCURRENCY`…),而 README 的 1C1G/2C4G 配方让用户在 `.env` 里写**无前缀**的 `HD_CONCURRENCY`;两套名字并存,用户很难知道哪个生效 | 【代码】 | D-2 统一约定:以无前缀名为标准,对历史 `PGS_*` 做双变量兼容回落(见 F11) |
| F11 | **(r3 新增)** `docker-compose.yml` 现有 `THUMB_CONCURRENCY: ${PGS_THUMB_CONCURRENCY:-4}` 不仅忽略了 `.env` 里的无前缀 `THUMB_CONCURRENCY`,而且硬编码 `:-4` 覆盖了 `config.ts` 的 `Math.min(4, cpu)` 自适应默认值;此外 `config.ts` 中 `COOKIE_SECURE`(`=== "true"`)与 `S3_FORCE_PATH_STYLE`(`!== "false"`)未走 `flag()`,空串或 `1/yes` 行为不一致 | 【代码】`docker-compose.yml` + `config.ts` | 1C1G 机器默认被强制设为 4 并发;用户按 README 写 `THUMB_CONCURRENCY=2` 被静默忽略 → **D-2** |
| F12 | **(r3 新增)** `corrupt.ts` 的自动清理(`CORRUPT_AUTO_PURGE_HOURS=5`)查询 `WHERE status='failed'` 时**不区分 `error` 原因**,并对受管存储(`local`/`s3`)执行物理删除原文件(`deleteMediaByIds(owned, true)`) | 【代码】`src/server/media/corrupt.ts` | 若 P1-2(超内存上限)或 P2-9(崩溃中断 3 次)直接置 `status='failed'`,**5 小时后用户上传的原图会被当成损坏文件永久物理删除** → **P1-2 / P2-9** |
| F13 | **(r3 新增)** `ready.ts` 启动时先调 `pending.forEach((r) => enqueue(r.id))`(第 53 行,同步触发 `pump()` 创建 `dirs.tmp` 临时文件),后调 `void cleanTmp(0)`(第 68 行,异步删除 `dirs.tmp` 下所有文件) | 【代码】`src/server/ready.ts` | 启动恢复瞬间存在 `cleanTmp(0)` 删掉正在处理的 `pending` 任务临时文件的竞态 → **P2-9** |
| F14 | **(r3 新增)** `hd/service.ts` 与 `derive.ts` 存在三处不一致:① `convert` 未支持 BMP(`isBmp`),HD 打开 BMP 直接报错;② `convert` 对 `storage==='ext'` 未做 `COPYFILE_FICLONE` 私有副本,外部截断文件仍可触发 `SIGBUS`;③ `loadVisibleImage` 未检查 `row.missingAt`。此外 `serveHd` 若在查缓存/`inflight` 前统一申请全流水线预算,会导致缓存命中被阻塞、`inflight` 合并请求双倍扣预算 | 【代码】`src/server/hd/service.ts` | HD 打开 BMP 500、挂载目录 HD 仍有 `SIGBUS` 风险、HD 预算在缓存命中/并发合并时虚高 → **P1-1 §5 / P2-1** |
| F15 | **(r3 新增)** `hd/watermark.ts#buildLayer` 先建 `(W+2*pad)×(H+2*pad)` 画布(2560×1707 时约 9MP,面积翻倍)并编码为 PNG Buffer,紧接着又 `sharp(canvas).extract(...).png().toBuffer()` 二次解码再编码 PNG | 【代码】`src/server/hd/watermark.ts` | 登录用户(带 `U-XXXXXX` 无法命中游客磁盘缓存)及新尺寸首次生成水印层时多付一次 9MP PNG 编解码与内存峰值 → **P1-4** |
| F16 | **(r3 新增)** `derive.ts#processMedia` 现状是在 `materialize()`(S3 会下载整文件)和 `heicToJpeg`/`bmpToPng`(已把整图解码进内存)**之后**才调 `sharp().metadata()`;且 `queue.ts#enqueue(id)` 只传 `id` | 【代码】`derive.ts` + `queue.ts` | 若不把文件头探测前移到解码前,预算器在 HEIC/BMP 解码完后才拿到尺寸就晚了;而 S3 若在排队前 `probe` 原文件则会提前把磁盘/带宽打满 → **P1-1 §6** |
| F17 | **(r3 新增)** 项目运行期不使用 Drizzle 迁移文件,而是靠 `src/db/bootstrap.ts` 的 `PG_DDL` + `ALTER TABLE` 与 SQLite 的 `LITE_DDL` + `LITE_UPGRADE` 双驱动自举,且 `src/db/index.ts` 对布尔/时间列有驱动差异 | 【代码】`src/db/bootstrap.ts` + `src/db/index.ts` | P2-9 新增字段若只改 `schema.ts` 或只写 PG DDL,SQLite 模式与老库升级会直接报错 → **P2-9** |
| F18 | **(r3 新增)** `Dockerfile` 硬编码了 `ENV UV_THREADPOOL_SIZE=12`;且 cgroup v2 的 `anon` 位于 `/sys/fs/cgroup/memory.stat` 的键值行而非独立文件 | 【代码】`Dockerfile` | 1C1G 容器下 12 个 libuv 线程偏高;P0-2/P1-6 需明确 `memory.stat` 的 v2/v1 解析规则 → **P0-2 / P2-5** |

---

## 3. 计划

**默认决策**(无需再确认):不重写后端、不引入 Rust;先修部署与观测,再做统一预算;画质默认值不动;每项改动都带验收指标,改动队列/闸门后必须重跑 `project.md` §17.3 的基准。

### P0 — 先做(低风险,让后续优化可度量)

#### ⬜ D-2 修 compose 变量传递(F1、F7、F10、F11)— r2/r3:改为"显式映射 + 双前缀兼容回落 + 自动校验",不用整份 `env_file`
- **做什么**:
  1. 在 `app.environment` 里**逐项映射**容器确实需要的变量,按组注释:
     - 性能/并发:`THUMB_CONCURRENCY`、`VIDEO_CONCURRENCY`、`HEIC_CONCURRENCY`、`HD_CONCURRENCY`、`HD_CACHE_MAX_MB`、`HD_CACHE_TTL_DAYS`、`HD_WIDTH` 等 `HD_*`、`THUMB_WIDTH`、`PREVIEW_WIDTH`、`EXIF_*`、`SCAN_*`、`DB_POOL_MAX`、`UV_THREADPOOL_SIZE` 等;
     - 安全/反代:`COOKIE_SECURE`、`SESSION_DAYS`、`ALLOWED_HOSTS`、`PUBLIC_BASE_URL`、`ALLOWED_MOUNT_ROOTS`、`GUEST_*`、`HD_RATE_*`、`SEARCH_RATE_PER_MIN`、`KEY_RATE_PER_MIN`;
     - 存储/上传:`MAX_UPLOAD_MB`、`MIN_FREE_DISK_MB`、`S3_*`、`CORRUPT_AUTO_PURGE_HOURS`、`JSON_BODY_MAX_KB`、`FFMPEG_PATH`、`FFPROBE_PATH`。
  2. **(r3 关键修正,解决 F11)双变量兼容回落与空串交还 `config.ts`**:
     - 对历史上曾用 `PGS_*` 映射的变量(`THUMB_CONCURRENCY`、`VIDEO_CONCURRENCY`、`HEIC_CONCURRENCY`、`TRUST_PROXY`、`DB_DRIVER`、`SQLITE_FILE`、`ADMIN_USER`),**不能原样保留 `${PGS_THUMB_CONCURRENCY:-4}`**(否则用户在 `.env` 里按 README 写无前缀 `THUMB_CONCURRENCY=2` 会被完全忽略,且 `:-4` 会覆盖 `config.ts` 的 `Math.min(4, cpu)` 自适应逻辑)。
     - 统一改写为**无前缀优先、兼容 `PGS_*`、未设置时传空串由 `config.ts` 决定默认值**:
       ```yaml
       THUMB_CONCURRENCY: ${THUMB_CONCURRENCY:-${PGS_THUMB_CONCURRENCY:-}}
       VIDEO_CONCURRENCY: ${VIDEO_CONCURRENCY:-${PGS_VIDEO_CONCURRENCY:-}}
       HEIC_CONCURRENCY: ${HEIC_CONCURRENCY:-${PGS_HEIC_CONCURRENCY:-}}
       TRUST_PROXY: ${TRUST_PROXY:-${PGS_TRUST_PROXY:-}}
       ```
     - 其余新增映射统一写 `NAME: ${NAME:-}`。
  3. **空串语义核查(r3 已逐项核对 `config.ts`)**:
     - `int()` / `num()` / `flag()` / `enumOf()` / `list()` 在空串 `""` 时均安全返回代码默认值;
     - **但 `config.ts` 有两处没走 `flag()`(F11)**:① 第 66 行 `cookieSecure: process.env.COOKIE_SECURE === "true"` → 应改为 `flag("COOKIE_SECURE", false)`;② 第 155 行 `forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false"` → 应改为 `flag("S3_FORCE_PATH_STYLE", true)`。这样空串与 `1/true/yes/on` 语义完全统一。
  4. **不映射**:仅 compose 自用的变量(`PGS_TAG`、`PGS_DB_PASSWORD`、`PGS_NODE_HEAP_MB`)、宿主机端口/路径参数(`PORT`、`DATA_DIR` 在容器内固定为 `3000` 和 `/app/data`)——在 D-4 的校验清单里**显式登记为"不映射"并写理由**。
  5. D-3 同批:`PGS_TAG` 默认值与 `.env.example` 对齐到当前版本(`1.4.3`);`.env.example` 补 `SCAN_MAX_DEPTH`;`mem_limit`/`cpus` 写成可直接取消注释的形式。
- **为什么不用 `env_file: [.env]`(r1 的推荐)**:它会把 `.env` 里所有内容(含 `PGS_DB_PASSWORD` 等与应用无关的变量)一股脑注入容器,违背最小权限;显式映射配合 **D-4 的 CI 校验**(`config.ts` 读取的每个环境变量,要么出现在 compose 映射里,要么在"不映射"清单里),既满足最小权限又杜绝漏映射。
- **验收(三层)**:① `docker compose config` 输出里能看到 `HD_CONCURRENCY` 等;② **运行中的容器**里 `docker exec <c> printenv | grep -E 'HD_|COOKIE_SECURE|THUMB_'` 与 `.env` 一致(分别测试在 `.env` 设无前缀 `THUMB_CONCURRENCY=2`、旧名 `PGS_THUMB_CONCURRENCY=2`、以及两者都不设时 2 核容器内 `/status` 的 `thumbConcurrency` 是否自适应为 2);③ `GET /status` 的有效配置随 `.env` 变化,且**不设置时回落到 `config.ts` 默认**。最后用此方法把 README 的 1C1G 配方端到端复测一次。
- **风险**:白名单漏项 = 静默失效(靠 D-4 校验兜底);`COOKIE_SECURE`/`S3_FORCE_PATH_STYLE` 改用 `flag()` 属于向后兼容的规范化。
- **工作量**:S~M(1~1.5h,含校验清单与容器内复测)。**这是 M1 的第一件事:它决定其余所有调参是否真的生效。**

#### ⬜ P0-2 观测补全(F5、F18)
- **做什么**:`/status` 的 `memory` 扩展为 `{rss, heapUsed, heapTotal, external, arrayBuffers, maxRss, cgroup:{current, max, anon, inactiveFile}}`;新增 `sharp:{cache: sharp.cache(), counters: sharp.counters(), concurrency: sharp.concurrency()}`;`queue` 增加各闸门(`heic/video/hd`)的 `active/waiting`;记录一个"最近 10 分钟 RSS 最大值"滑动窗口。`SystemTab.tsx` 展示这些字段。
- **验收**:压测(批量上传 + HD 并发)后能从 `/status` 一眼看出峰值时刻、各闸门排队长度、external 与 RSS 的差;`limiter()` 需要暴露 `{active, waiting}` 的只读统计。
- **风险**:`/status` 有 5 秒缓存,峰值窗口要独立采样(`setInterval(...).unref()`,每秒一次即可)。
- **工作量**:S~M(2h)。
- **r2/r3 追加**:
  1. **cgroup 精确读取规则(F18)**:
     - **cgroup v2**:读 `/sys/fs/cgroup/memory.current`、`memory.max`("max" 表示无限制 → `null`),并解析 `/sys/fs/cgroup/memory.stat` 中的 `anon <bytes>` 与 `inactive_file <bytes>`。`memory.current` 含可回收 page cache,会随读写大文件虚高,P1-6 的压力水位必须以 **`anon`**(若无则回落 `current - inactiveFile`)为准;
     - **cgroup v1 回落**:读 `/sys/fs/cgroup/memory/memory.usage_in_bytes`、`memory.limit_in_bytes`(≥ `1 << 60` 视为 `null`),并解析 `memory.stat` 中的 `total_rss`(对应 `anon`)与 `total_inactive_file`。
  2. 采样 `perf_hooks.monitorEventLoopDelay({ resolution: 20 })` 并在 `/status` 暴露 `{p99Ms, maxMs}`(作为 P3-1 拆独立 Worker 的量化触发条件之一);
  3. 为 P1-1 预留 `admission:{usedMB, budgetMB, waiting, exclusive, lowConfidenceCount, pressureState}` 字段(M1 先返回占位值)。

#### ⬜ P0-3 用真实素材建立基线,脚本正式入库(原 P0-3 + T-2 合并;r2 扩充)
- **做什么**:把附录 A 的微基准整理成**入库的基准套件**(入库属于代码改动,放在实施阶段):
  ```text
  scripts/bench/
    generate-images.mjs   # 合成素材(隔行/非隔行 PNG、渐进/基线 JPEG、TIFF、16-bit PNG…)
    bench-memory.mjs      # 派生图 / HD convert:×1、×4 并发,每场景独立进程取 VmHWM
    bench-hd.mjs          # HD 水印 ×1/×3/×24,以及混合 HD 请求(大小图混合、命中/未命中缓存、游客/登录用户)
    bench-queue.mjs       # 队列与闸门:100 HEIC + 100 JPEG、1 大图 + 20 小图 的完成时间分布
    README.md             # 如何运行、如何解读、基线 JSON 的更新规则
  ```
- **素材清单(硬性要求,缺一项就不算完成)**:NASA 素材(`fetch-samples.mjs`);**HEIC**(iPhone 12MP、48MP,含竖拍/方向标记);BMP;**16-bit PNG**;CMYK TIFF;**渐进 JPEG**;**隔行 PNG**;外加一组真实相机 JPEG(24MP+)。
- **环境**:**容器内**运行(带 jemalloc、`MALLOC_ARENA_MAX=2`),并同时记录 CPU/内存/Node/sharp/libvips 版本。
- **每个场景记录**(r2:不只看峰值):单任务峰值、N 并发峰值、**静置 20s 后回落值**、**总耗时与单任务 p50/p95**、`/status` 里的 `external/arrayBuffers/cgroup.anon`。输出 Markdown 表 + JSON;JSON 与上一次基线比对,**同时报告内存与耗时的变化**,防止"峰值降了、时间翻倍"和"只盯隔行 PNG、普通 JPEG 变慢"。
- **验收**:`project.md` §17.4 的"未测"清单清零;能解释 README 里"24 并发 HD 1897MB"由哪几个并发任务构成;基线 JSON 入库,之后每次改媒体处理逻辑都能一键对比。
- **Gate**:**本项完成之前,P1-1 的估算系数与 `MEDIA_BUDGET_MB` 默认值只能标记为"临时",不得定稿。**
- **工作量**:M(0.5~1 天,含素材准备)。

### P1 — 核心优化(预期收益最大)

#### ⬜ P1-1 像素加权的统一内存预算 + 单点准入控制(`MediaBudget` / `admit()`)— r2/r3 重写
- **问题**:并发只按"任务个数"限制,而单任务工作集差 5~9 倍(F3);派生槽、`heicGate`、`videoGate`、HD `gate` 互不感知(`project.md` §17.1-5)。
- **设计原则(r2 + r3 源码对齐)**:

  **① 预算是准入条件,不是第二个队列。** `queue.ts` 继续负责"任务清单 / 去重 / 重试 / dirty";**"何时可以开跑"只由一个 `admit()` 决定,所有等待只发生在这一处**。判定顺序固定:`类别并发上限(image/heic/video/hd 的 CPU 并发)→ 内存预算(含 P1-6 的压力折扣)→ 优先级 + aging`(交互式 HD > 后台派生;等待超过 N 秒的大任务开始阻塞后来的小任务,防饥饿)。HD 请求与后台队列共用同一张等待表,取代各自独立的 gate。

  **② 估算是可校准的策略,不是固定映射。** 新文件 `server/media/budget.ts`(准入) + `server/media/estimate.ts`(估算) + 系数表(独立文件):
  ```ts
  interface MediaMemoryEstimate {
    estMB: number; format: string; width: number; height: number;
    confidence: "high" | "medium" | "low"; reason: string;   // reason 用于日志/UI/调试
  }
  function estimateMemory(meta: ProbeMeta, stage: "derive" | "hd-miss" | "hd-hit-wm" | "heic" | "bmp" | "video"): MediaMemoryEstimate
  ```
  系数表按 `格式 × 渐进/隔行 × 位深 × 色彩空间` 索引,**每格记录来源**:`measured`(P0-3 实测,high)/`extrapolated`(相邻格外推,medium)/`guess`(无数据如 HEIC、CMYK、16-bit,low)。**`low` 置信度的估算自动 ×1.5**(宁可保守),`/status` 暴露 `lowConfidenceCount`,提示该补测哪一格。新增 RAW/AVIF 只需加一行。初值(仅起点):流式(基线 JPEG / 非隔行 PNG / TIFF)≈ 1.5 B/px;渐进 JPEG / 隔行 PNG ≈ 3.6 B/px;16-bit ×2;HD 水印合成 ≈ 15 B/px × W×H;统一再乘 1.25。
  > 估算只考虑"像素与格式",真实峰值还受解码器内部工作区、resize 中间图、色彩空间转换、输入输出同时存活、libvips 线程数影响——这就是需要 P0-3 校准、且需要 P1-6 兜底的原因。

  **③ 软预算 / 硬限制,语义分开。**

  | 参数 | 语义 | 默认(起点,待校准) |
  |---|---|---|
  | `MEDIA_BUDGET_MB` | **软预算**:并发任务的估算总和上限。单个任务估算超过它时,**仅当当前没有其他任务持有预算时才独占启动**,期间其他任务等待;`/status` 标记 `exclusive` | 见 ④;`0` = 关闭预算(行为回到现状) |
  | `MEDIA_MAX_EST_MB` | **硬限制**:单任务估算上限。超过则**拒绝**,`error` 带固定前缀 `[LIMIT] 超出内存上限:…`,UI 与"疑似损坏文件"区分展示,且**绝不被 `corrupt.ts` 自动清理删除原图**(见 F12) | `MEDIA_BUDGET_MB × 1.5`,且不超过"可用上限"(见 ④) |

  **④ 预算基数先扣基础开销。** `可用 = limit × (1 − margin) − baseRss`;`MEDIA_BUDGET_MB = clamp(可用 × f, 256, 2048)`。`margin` 初值 0.15(安全余量);`baseRss` = 空载 RSS + 常驻增量(Next 约 250MB,以 P0-2 观测为准);`f` 初值 0.7(libvips 之外还有 Next、DB 连接池、wasm、页缓存)。PostgreSQL 在**独立容器**时不计入;SQLite 模式或同容器部署需把其缓存计入 `baseRss`。无 cgroup 限制时取 `os.totalmem() × 0.4`。示例:1GB 容器 ≈ (1024×0.85−250)×0.7 ≈ 434MB。**`/status` 展示推导过程**(limit、baseRss、margin、f、结果),方便排错。

  **⑤ 预算覆盖完整资源生命周期 + HD 三路分流(r2 修正 + r3 补齐 F14 `inflight`/缓存命中细节)。**
  - r1 写的"HD `convert` 与水印是两次独立 `run`"**有缺陷**:convert 释放预算后,它产出的 WebP Buffer 仍然活着,水印阶段若只按自身申请就会漏计。
  - **r3 关键修正(F14)**:`hd/service.ts#serveHd` 有 `getCached` 与 `inflight` 并发合并。**绝不能在查缓存和 `inflight` 之前无条件申请未命中全量预算**,否则同一张图并发请求时 coalesced 请求会重复占满双倍预算,缓存命中也会被重任务阻塞。正确流程:
    1. 先完成 token 校验、限流(`guardHd`)、`loadVisibleImage`(补上 `if (row.missingAt) return null`)与 `versionOf(row)`;
    2. 先查 `getCached(row.id, ver, width)`:
       - **路径 A(缓存命中 `hit`)**:只需申请轻量 `hd-hit-wm` reservation(基图 Buffer + 水印阶段,按目标输出宽高估算,无需读原文件头),执行 `applyWatermark` 并写出响应后释放;
    3. 若缓存未命中,查 `inflight.get(key)`:
       - **路径 B(并发合并 `coalesced`)**:当前已有另一个请求正在持有 `hd-miss` 预算做 `convert`,本请求**先 `await running` 拿到基图 Buffer**(期间不重复申请 `convert` 预算),拿到后再申请轻量 `hd-hit-wm` reservation 执行 `applyWatermark`;
       - **路径 C(缓存未命中 `miss`)**:申请一次覆盖 `convert + applyWatermark + 响应写出` 的完整 `hd-miss` reservation(估算值 = `max(convert 阶段, convert 产物 + 水印阶段)`,该 max 假设须用 P0-3 验证;或者在 `convert` 产生产物并写入缓存后调用 `reservation.adjust(wmEstMB)` 释放解码工作集差额)。
    4. **HD 估算的数据来源(避免 S3 额外下载)**:DB 的 `media` 行在入库处理后已有 `row.width`、`row.height`、`row.size`、`row.mime`;HD `miss` 估算优先直接使用 `row.width × row.height`(若 `row.width` 为空或需要 `isProgressive` 且原图在本地/ext,才轻量调 `sharp(file).metadata()`;S3 原图绝不为估算提前 `materialize`)。
  - **禁止嵌套申请**(防死锁):同一异步调用链内不得二次调 `admit()`;开发/测试模式用 `AsyncLocalStorage` 检测嵌套并直接抛错。
  - HEIC/BMP 后台派生同理:整个 `processMedia`(解码 + 派生)是一次 reservation,不拆。

  **⑥ 后台队列的轻量 `probe` 与调用序前移(r3 修正 F16)。**
  - 现状矛盾:`derive.ts#processMedia` 是在 `materialize()`(S3 会下载整文件)和 `heicToJpeg`/`bmpToPng`(已把整图解码进内存)**之后**才调用 `sharp(input).metadata()`,而 `queue.ts#enqueue(id)` 只传 `id`。
  - **r3 修正后的流程**:
    1. 入队时允许附带已知轻量提示 `enqueue(id, { priority, cls, sizeHint })`(上传/扫描时已知文件名与大小);
    2. `pump()` 挑选候选任务前,对队首窗口(如前 K 个未 probe 任务)执行轻量 `probeMedia(id)`(独立小并发 `probeLimiter(4)`,不占内存预算,**绝不解码整图,也绝不触发 S3 下载**):
       - 本地/`ext` 常规图片(或有 `localHints` 的 S3 上传图):`sharp(file).metadata()` 只读文件头(KB 级),取 `width, height, format, isProgressive, depth, space`;
       - 本地/`ext` BMP:直接读取文件头前 26 字节(复用 `bmp.ts` 的 `width = buf.readUInt32LE(18)`, `height = Math.abs(buf.readInt32LE(22))`),**零解码**拿到精确宽高;
       - 本地/`ext` HEIC:解析文件头 `ispe` box 取宽高(复用 `metadata.ts` 已有的 HEIC 容器读取逻辑),失败则按 `fileSize × 系数` 估算(`confidence: "low"`);
       - 视频:不读像素,直接归类 `cls = "video"`,按固定经验内存估算;
       - **无 `localHints` 的 S3 远程文件**:不调 `materialize()`,直接用 DB `row.size + row.mime` 估算(`confidence: "low"`),进入 reservation 并 `materialize` 落地后,在实际解码前可用 `metadata()` 二次校验硬限制 `MEDIA_MAX_EST_MB`。

- **接入顺序(r2,每一步单独提交、单独跑基准,以便归因)**:**a.** 普通派生图(`processMedia` 的 sharp 路径)→ 对比"估算 vs 实测 ΔRSS" → **b.** HD 整条流水线(含 `hit`/`coalesced`/`miss` 三路)→ **c.** HEIC / BMP → **d.** 视频(ffmpeg 子进程,不走 libvips,按固定权重)。每步门禁:`high` 置信度的格子,实测峰值增量 / 估算值落在合理区间(不低估;高估不超过约 1.6 倍),否则先修系数再进下一步。
- **验收**(用 `scripts/bench/` 回归):① 4×100MP 隔行 PNG 峰值 ≤ 550MB(现 1430MB;**合成素材结论,以 P0-3 真实素材复测为准**);② 1×大图 + 20×24MP JPEG:总耗时劣化 < 50%、p95 不显著变差、峰值不高于现状;③ 24 路 HD 并发(含大图、含混合尺寸、含同图并发 `coalesced` 与缓存 `hit`)峰值显著低于现状且命中响应不被未命中大图堵死;④ `MEDIA_BUDGET_MB=0` 时行为与现状一致;⑤ 输出"估算 vs 实测"偏差表;⑥ **纯逻辑单测**(`node --test`,不依赖 sharp/DB):放行 / FIFO / aging / 独占 / 硬限制拒绝 / 不嵌套 / 类别上限与预算联合判定 / 低置信度加成 / 请求断开(AbortSignal)从等待表摘除。
- **风险**:估算偏低 → 预算形同虚设(靠 P0-3 校准 + `/status` 的 `external` 对照 + **P1-6 兜底**);估算偏高 → 吞吐下降(只影响极端输入);死锁(靠"不嵌套"规则与检测);`admit()` 成为单点——必须有单测与超时/取消路径(HD 客户端断开连接时通过 `req.signal` 从等待表摘除)。
- **工作量**:L(2~3 天,分 a~d 四步,含校准)。**这是整份计划的核心。**

#### ⬜ P1-2 把硬编码阈值变成配置,并按估算拒绝极端输入(r2 拆两步 + r3 防误删保护 F12)
- **第一步(M2,不依赖预算器)**:新增 `SHARP_CONCURRENCY`(默认 2,低内存机器设 1)与 `MEDIA_MAX_INPUT_MP`(默认保持 268 以兼容现有数据;低配机器建议 100),**只按像素**判断。同步 `project.md` §10.2(这两项从"硬编码"移到"环境变量")、`.env.example`、compose 映射(D-2 的校验会强制这一点)。
- **第二步(M3,依赖 P1-1 的估算器)**:启用 `MEDIA_MAX_EST_MB` 的**硬限制**——估算超限时**失败并给出明确原因**(`[LIMIT] 图片 12000×9000 渐进编码,估算需要 ~380MB,超过上限 300MB`)。
- **(r3 硬性要求,解决 F12)防止 `corrupt.ts` 自动物理删除超限原图**:
  - `src/server/media/corrupt.ts` 的 `sweep()` 默认 5 小时后自动物理删除所有 `status='failed'` 的受管原文件(`local`/`s3`)!
  - 必须在 `corrupt.ts` 中定义非损坏类错误排除条件(如 `error NOT LIKE '[LIMIT]%' AND error NOT LIKE '[INTERRUPTED]%'`),在 `corruptSummary()`、`purgeCorrupt()`(未显式传 `ids` 时)与 `sweep()` 中统一过滤,确保因 `MEDIA_MAX_INPUT_MP` / `MEDIA_MAX_EST_MB` 拒绝的文件**绝不会出现在"疑似损坏文件"清理列表里,更不会被定时任务删掉原文件**(用户调大内存配置后点击"重新处理"即可恢复)。
- **不做**:不把默认上限一刀切降到 60~100MP(见 §1 第 6 行)。
- **验收**:设 `SHARP_CONCURRENCY=1` 后 `/status` 反映;`MEDIA_MAX_INPUT_MP=50` 时 100MP PNG 得到明确 `[LIMIT]` 失败原因且不进入解码;**调 `corruptSummary()` 与触发 `sweep()` 验证该文件不被计入损坏文件、原文件完好保留**。
- **工作量**:S(第一步 1h;第二步 1h)。

#### ⬜ P1-3 队列分池,消除嵌套闸门的队首阻塞(F2)
- **问题**:见 F2。典型:缩略图槽位 4、`heicGate` 1,队列里 `HEIC-1/2/3, JPEG-1`——前三个先占槽再等 gate,JPEG 明明能跑却被堵住。
- **做什么**:让 `pump()` 取下一个任务时就知道它的类别(`image` / `heic` / `video`),按类别各自的容量选取"下一个可运行"的任务(跳过暂时无容量类别的队首),而不是先占槽再排队。类别在入队处就有(`ingest.ts`/`albums.ts`/`reprocess` 都知道文件名/kind):`enqueue(id, {priority, cls})`,缺省根据文件名后缀/DB 补全。
- **r2 约束:按 `admit()` 的形状实现**。把"能不能启动这个任务"写成一个独立的、可单测的判定函数(M2 只含**类别并发**这一条),并预留"预算"与"优先级/aging"两个判定位。**M3 把预算并入同一个 `admit()`,而不是再加一个队列**(见 P1-1 ①)。否则会得到"分池消除了 HEIC 队首阻塞,却又被大图长期占预算堵住小图"的新问题。
- **HD 的 HEIC 转换**:现与后台队列共用 `heicGate`,交互式请求要排在后台任务之后。M2 先给 HD 路径独立的容量或更高优先级;M3 统一进 `admit()`(交互式优先)。
- **先写测试(T-3)**:"100 个 HEIC + 100 个 JPEG 同时入队":JPEG 完成时间不被 HEIC 拖到最后,**且 HEIC 在持续到来的 JPEG 流中也不被饿死(aging)**;重试、`dirty`、优先级插队路径保留类别。
- **验收**:上述用例通过;`/status/queue` 增加按类别的 `running/waiting`;批量 HEIC 导入期间 JPEG 吞吐接近无 HEIC 时。
- **风险**:`enqueue` 调用点多(上传、扫描、重处理、黑名单恢复、启动恢复 `ready.ts`),`ready.ts` 启动恢复需同时 `select({ id: media.id, kind: media.kind, filename: media.filename })` 以便直接得出 `cls`;`dirty`/重试路径要保留类别。
- **工作量**:M(0.5~1 天)。

#### ⬜ P1-4 降低 HD 水印的重复成本(F4、F15)— r2 写清安全边界 + r3 消除 `buildLayer` 内部二次 PNG 编解码
- **先测量**(依赖 P0-2、P0-3):同一张 2560px 图,缓存命中时 `serveHd` 的 CPU 耗时与瞬时内存(分别测 `layerCache` 命中与未命中、游客与登录用户);确认水印合成与 `buildLayer` 各自占比。**测量结果不支持就不做。**
- **核心原则(写进代码注释与测试名)**:**缓存的是"图片处理结果",不是"访问权限"。** 命中缓存**不能**跳过任何权限检查。
- **候选方案**(按收益/风险排序,逐个验证):
  1. **(r3 新增,零缓存风险、对登录用户同样生效,解决 F15)消除 `watermark.ts#buildLayer` 的双重 PNG 编解码與过度画布**:
     - 现状:`buildLayer` 先建 `(W + 2*pad) × (H + 2*pad)` 画布(2560×1707 时 `pad≈450`,画布达 `3460×2607 ≈ 9.0MP`,是目标图面积的 2 倍以上),`.composite(parts).png().toBuffer()` 编码成 PNG 后,紧接着又 `sharp(canvas).extract({ left: pad, top: pad, width: W, height: H }).png({ compressionLevel: 6 }).toBuffer()` **二次解码再编码 PNG**!
     - 改进:① 在生成 `parts` 时只保留与 `[pad, pad, W, H]` 相交的瓦片,或直接把 `composite(parts)` 与 `.extract(...)` 串在同一条 sharp 管线里(若 libvips 顺序限制需中间缓冲,则用 `.raw().toBuffer()` 配合 `sharp(raw, {raw}).extract().png({compressionLevel: 1})`,避免 9MP PNG 的 deflate 压缩再解压);② 登录用户因带 `U-XXXXXX` 无法享受下方的游客磁盘缓存,此项优化对登录用户和首次分辨率均直接生效。
  2. **游客水印结果磁盘缓存**(游客水印不含用户标识,结果确定):
     - **Key 必须包含**:`图片 id + 版本(ver/内容 hash)+ 输出宽度 + 水印配置指纹(wmVer:enabled/text/opacity/fontSize/angle/density/fontFile 的 sha1 前 8 位)+ 规范化 host`。
     - **host 校验与 `baseUrl(req)` 对齐(r3 核对)**:复用 `media/service.ts#baseUrl(req)` 的白名单逻辑,但额外返回一个布尔标记 `hostTrusted`(当配置了 `PUBLIC_BASE_URL` 或请求 `host` 命中 `ALLOWED_HOSTS` / 等于 `new URL(req.url).host` 且未被不可信 `x-forwarded-host` 污染时为 `true`);**未通过校验的 host 不写缓存**(仍可正常出图),防止伪造 Host 撑爆缓存。
     - **容量与过期**:落 `cache/hd/wm/`,与基图共用同一套 LRU/TTL 管理器(`hd/cache.ts`),容量统一计入 `HD_CACHE_MAX_MB`;另设水印缓存条目数上限。
     - **每次请求仍重新校验**:令牌(`checkHdToken`)、限流(`guardHd`)、图片是否存在且 `missingAt IS NULL`、可见性、相册权限——**全部先于任何缓存读取**。响应头保持 `private, no-store, max-age=0`。
     - **失效点(缺一不可)**:原图替换/重新处理(`ver` 变化)、可见性/相册变更、**水印配置或 `PUBLIC_BASE_URL` 变更**(因 Key 含 `wmVer` 与 `host`,配置变化自动 miss 旧缓存)、删除/黑名单、`invalidateHd(id)`(同步清理该 `id` 的基图与 `wm` 缓存)。
     - 登录用户因带 `U-XXXXXX`(`userMark=true` 时)不写/不读游客水印缓存。
  3. **存放介质**:**默认磁盘**(复用现有缓存基础设施,OS 页缓存可自动回收)。内存 LRU 会直接抬高常驻 RSS,与降内存目标冲突,不选。
  4. `loadVisibleImage` 只 select 必要列(P2-3)并补齐 `if (row.missingAt) return null`(F14)。
- **验收**:同一张图第二次打开,服务端 CPU 耗时与瞬时内存显著下降(游客);登录用户首次生成水印层峰值较现状下降(受益于候选 1);`scripts/test-hd.mjs` 的 49 条安全测试全部通过;**新增 T-4**(权限每次重校验、各失效点、Key 隔离、伪造 Host 不撑爆缓存、水印配置变更后不命中旧缓存、登录用户不串用游客缓存)。
- **与 P1-1 的关系**:游客水印磁盘缓存命中时,连 `applyWatermark` 都无需执行,直接流式/Buffer 返回,不占 `hd-hit-wm` 像素合成预算!
- **工作量**:M。

#### ⬜ P1-5 HEIC:评估原生解码子进程(文件进、文件出)
- **背景**:`heic-convert` = libheif 的 wasm 版 + 纯 JS JPEG 编码,整文件进 Buffer、整图 RGBA 在 wasm 堆里;wasm 线性内存【推断】只增不减。HEIC 又占派生槽位(F2)。
- **候选**:Debian bookworm 的 `libheif-examples`(`heif-convert`,原生)通过 `execFile` 把 `x.heic` 转成临时 JPEG 文件,再交给 sharp;子进程结束即把内存还给系统,Node 侧不再持有大 Buffer;保留 `heic-convert` 作回退(与 ffmpeg 可选的现有模式一致)。镜像 +约 20~30MB。
- **必须先验证**:方向与镜像/翻转(`irot/imir`)是否被正确应用且不与 sharp `.rotate()` 重复旋转;ICC 与 10-bit HEIC;HEIF 网格/多帧/Live Photo;HEVC 解码器的许可与专利立场(个人自托管通常可接受,但应写进 README);EXIF 仍从原文件读取(`extractImageMeta(file)` 已如此,不受影响)。
- **验收**:iPhone 12MP 与 48MP 样张,对比 `heic-convert` 的峰值 RSS、耗时、画面一致性(PSNR/肉眼)、方向正确性;批量 50 张后静置 RSS 是否回落。
- **工作量**:M。若验证不通过(许可/兼容),保留现状并把 HEIC 权重在 P1-1 中调高、`HEIC_CONCURRENCY` 默认保持 1。
- **r2 追加**:① HEIC 的**内存估算**:原生子进程的内存在 Node 之外,不占 Node 堆但仍占容器 cgroup 内存——预算里要计入(按子进程实测峰值),不能因为"在子进程里"就不计;② 必须验证并记录结果的清单保持不变(方向/镜像、ICC、10-bit、网格/多帧/Live Photo、许可),**内存下降但 iPhone 照片方向错或颜色变了,视为失败**;③ 子进程要有**超时 + 输出临时文件清理(`finally`)+ 失败回落**(回落到 `heic-convert` 时按其更高的内存估算申请预算)。

#### ⬜ P1-6 动态内存压力保护(r2 新增,ChatGPT 建议)
- **为什么**:P1-1 是"预测后准入",预测必有误差(附录 B 的局限、未覆盖的格式)。需要一个**运行时兜底**:预测错了,系统也不应走到 OOM kill。
- **状态机**(初始阈值只是参考,须结合 `baseRss`、cgroup 与 P0-3 压测调整):

  | 水位(`anon / limit`) | 状态 | 调度行为 |
  |---|---|---|
  | < 70% | `normal`(正常) | 正常准入 |
  | 70%–85% | `elevated`(偏高) | 有效预算 × 0.7(降低新任务准入) |
  | 85%–93% | `high`(高) | 暂停**重型**任务(估算 > 阈值的、HEIC、视频、大图 HD miss);轻任务(如 HD 缓存命中、小图)继续;交互式 HD 等待超时返回 `503 + Retry-After`,而不是排到被 OOM |
  | > 93% | `critical`(紧急) | 暂停全部新的媒体准入;`sharp.cache(false)` 确认关闭;日志告警 |

- **关键技术点**:
  - 水位以 **`anon`**(P0-2 从 `/sys/fs/cgroup/memory.stat` 导出)为准,**不要**直接用 `memory.current`——它含可回收页缓存,会因读大文件而误触发。无 cgroup 限制时用 `RSS / os.totalmem()`。
  - **迟滞**:进入某状态后,需水位回落到阈值以下 5 个百分点并**连续 N 次(如 3 次)**采样才降级,避免抖动。
  - **永不死锁**:任何状态下,只要当前没有运行中的媒体任务(`running === 0`),就必须放行一个(紧急状态下优先放行等待表中估算最小的任务)。
  - 采样沿用 P0-2 的每秒采样器(`unref()`),状态机本身写成**纯函数**(输入水位序列 → 输出状态),便于单测。
  - 与 `admit()` 的关系:压力状态只是 `admit()` 的一个输入(预算折扣 / 重型任务暂停),**不新增第二处等待**。
- **验收**:① 状态机纯逻辑单测(升降级、迟滞、永不死锁);② 故意把估算系数调成实际的 0.3 倍(模拟严重低估),跑 `bench-queue`/`bench-hd` 混合负载,**RSS 不越过容器上限**,吞吐下降但全部任务最终完成;③ `/status` 展示当前状态与最近一次状态切换原因。
- **依赖**:P0-2(anon)、P1-1(`admit()`)。**放 M4 开头,不与预算器同批上线**(否则无法判断改善来自哪一个)。
- **工作量**:M(1 天)。

### P2 — 次要优化与卫生项

| ID | 状态 | 内容 | 验收 / 说明 |
|---|---|---|---|
| P2-1 | ⬜ | **BMP 与 HD 对齐**(F14):① `bmpToPng` 整文件 + RGBA + PNG Buffer:在 P1-1 `probe` 阶段直接读 BMP 前 26 字节文件头取宽高做像素/内存上限拦截;若 ffmpeg 可用,改用 `ffmpeg -i x.bmp -frames:v 1 out.png` 文件进文件出(回退保留 `decodeBmp`);② **补齐 `hd/service.ts#convert` 对 BMP 的支持与 `storage==='ext'` 的 `COPYFILE_FICLONE` 私有副本**(防止挂载目录外部截断引发 `SIGBUS`) | 验收:50MP BMP 不再产生数百 MB 的 Node Buffer;HD 预览打开 BMP 正常出图不再 500;挂载目录图片在 HD 转换时使用私有副本 |
| P2-2 | ⬜ | **`.toBuffer()` → `.toFile()`**(`makeDerived`、`convert`、水印输出):仅作代码卫生,**预期内存收益 ≈ 0**(见 §1 第 1 行) | 保持原子写(先写 `.tmp` 再 `rename`) |
| P2-3 | ⬜ | **列投影**:`processMedia` 与 `hd/service.ts#loadVisibleImage` 都 `select()` 整行(含 `meta` jsonb、`search_text`);改成 `files.ts#FILE_COLS` 那样只取必要列,同时在 `loadVisibleImage` 补上 `if (row.missingAt) return null`(F14) | HD 取图每次请求少拉一次大 jsonb;`processMedia` 只需要 `id/albumId/kind/filename/mime/size/storage/storageKey` |
| P2-4 | ⬜ | **前端窗口化**:`Gallery.tsx` 的 `items` 只增不减,无 `content-visibility`。先量化(5k/20k 项时 DOM 节点数与标签页内存);再做"按列累计高度只渲染视口 ±N 屏、其余用占位高度"的窗口化(列高可由 `aspect-ratio` 精确得到);同时评估为网格增加更小的缩略档(如 360px)或 `srcset`,当前 `THUMB_WIDTH=720` 对 6 列桌面网格偏大 | 验收:2 万项滚动到底,DOM 节点数与内存近似常数;滚动/回顶无闪烁;`pgs:changed` 刷新后保持位置 |
| P2-5 | ⬜ | **部署指引**(含 F18):README/compose 给出"容器内存 → 推荐 `PGS_NODE_HEAP_MB`/`THUMB_CONCURRENCY`/`HD_CONCURRENCY`/`MEDIA_BUDGET_MB`/`SHARP_CONCURRENCY`/`UV_THREADPOOL_SIZE`"对照表(堆 ≈ 容器上限的 25%~35%,默认 1024 不适合 1GB 机器;1C1G 建议 `UV_THREADPOOL_SIZE=4`);`docker-compose.yml` 提供可直接取消注释的 `mem_limit`;`/status` 展示 cgroup 上限(P0-2) | 1GB/2GB/4GB 三档各跑一次 P0-3 的基准,写入文档 |
| P2-6 | ⬜ | **扫描内存**:用 10 万文件平铺目录实测 `scanAlbum` 的堆峰值与耗时;若 > 200MB 再改成 `opendir` 流式 + 1000 条一批查库 | 先测再决定,**默认不改** |
| P2-7 | ⬜ | **`files.ts` 密钥限流 IP**(F6):改用 `router.ts#clientIp(req)`(r2:它改变运行行为,**归 M2,不放 M1**) | 单元/e2e 增加"带 `TRUST_PROXY` 时按 XFF 倒数第 n 段限流" |
| P2-8 | ⬜ | `.env.example`/README 补 `SCAN_MAX_DEPTH`、`MEDIA_BUDGET_MB`、`MEDIA_MAX_EST_MB`、`SHARP_CONCURRENCY`、`MEDIA_MAX_INPUT_MP`(随 P1 落地;D-4 校验会强制) | 与 `project.md` §10 对齐 |
| P2-9 | ⬜ | **作业生命周期、崩溃回路保护与启动清理竞态修复**(F9、F12、F13、F17,轻量版,**不引入 Worker**):① **先修启动竞态(F13)**:`ready.ts` 中 `await cleanTmp(0)` **必须移到 `setRunner(processMedia)` 和 `pending.forEach(enqueue)` 之前**,防止刚启动的任务临时文件被删;② **崩溃回路保护(F9)**:给 `pgs_media` 增加 `attempts integer DEFAULT 0 NOT NULL` 与 `processing_started_ms bigint`(毫秒时间戳,与 `mtime_ms` 类型一致)。任务开始执行时写 `processing_started_ms = Date.now()`,完成/失败时清 `null`;启动恢复 `pending` 时若 `processing_started_ms` 非空 → 视为上次进程崩溃中断,`attempts + 1`,若 `attempts >= 3` 则置 `status = 'failed'`、`error = '[INTERRUPTED] 处理多次中断(疑似导致进程崩溃),已停止自动重试'`,不再入队;用户手动点"重新处理"时重置 `attempts = 0`;③ **双数据库自举同步(F17)**:除 `src/db/schema.ts` 外,**必须同步修改 `src/db/bootstrap.ts` 的 `PG_DDL` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 以及 SQLite 的 `LITE_DDL` + `LITE_UPGRADE` 数组**(项目运行期不用 Drizzle 迁移文件);④ **防误删保护(F12)**:`corrupt.ts` 排除 `[INTERRUPTED]` 前缀,严禁自动清理物理删除受管原文件 | 验收:PostgreSQL 与 SQLite 双驱动下老库无缝升级;人为在某文件处理时 `kill -9` 进程,重启 3 次后该文件进入 `failed`(`[INTERRUPTED]`)且不被 `corrupt.ts` 自动物理删除;其余 `pending` 文件正常恢复且无 `tmp/` 文件丢失竞态 |

### P3 — 架构演进(只在触发条件成立时做)

#### ⏸ P3-1 独立的 Node 媒体 worker 进程(不是 Rust)
- **价值**:① 崩溃隔离——挂载目录的 `SIGBUS`(已用私有副本规避)与 OOM 不再拖垮 Web/API;② **可回收**——worker 的 RSS 超阈值或处理 N 个任务后优雅重启,同时解决 glibc 碎片与 wasm 内存不回落;③ 独立的 `--max-old-space-size`、`MALLOC_ARENA_MAX`、cgroup 配额;④ Web 事件循环不再被媒体任务影响。
- **形状**:`child_process.fork()` 同一份 TS/JS(`derive.ts`、`hd` 的 convert/水印),父子之间只传 JSON({jobId, 输入路径, 输出路径, 参数}),**绝不传图片 Buffer**;预算器(P1-1)放在父进程做准入,worker 内只负责执行;DB 写回仍由父进程做(或 worker 持有自己的连接,二选一,倾向父进程以保持单点,尤其 SQLite 模式必须单进程写库)。
- **触发条件**(任一):`/status` 观察到事件循环延迟(`p99Ms`)被媒体任务显著拖高(P0-2 采样);出现容器 OOM kill 或 `SIGBUS` 崩溃;P1-5 验证后仍需回收 wasm 内存。
- **工作量**:L。
- **前置条件(r2 新增,ChatGPT 建议:拆 Worker 之前先把这些设计好)**:
  1. **作业生命周期**:`PENDING → RUNNING(租约:worker id + processing_started_ms + attempts)→ SUCCESS | FAILED | INTERRUPTED`;`INTERRUPTED` 在 attempts 未超限时可安全重新执行,超限转 `FAILED`(`[INTERRUPTED]`)。P2-9 是它的轻量前身——先做 P2-9,再扩展。
  2. **Worker 意外退出**:父进程监听 `exit`,把该 worker 持有的 `RUNNING` 作业转 `INTERRUPTED` 并重启 worker(带指数退避,防止崩溃风暴)。
  3. **幂等**:同一作业重复执行结果相同(输出走 tmp+rename、以 `id + ver` 为键);父进程重启后,`RUNNING` 超租约的作业按 2 处理。
  4. **临时文件**:约定统一 tmp 子目录(如 `tmp/worker-<pid>/`),worker 退出或重启时精准清理该子目录,不影响其他正在运行的任务;数据库状态与磁盘文件不一致(库里 `ready` 但文件缺失,或反之)有对账/自愈路径。
  5. **准入仍在父进程**(`admit()`),worker 只执行;预算 reservation 的释放要覆盖"worker 崩溃"这条路径(父进程在 `exit` 事件里强制释放)。

#### ⏸ P3-2 Rust —— 暂不做
- **理由**:图像解码/缩放/编码已经在原生库里(sharp = libvips);Rust 重写调用层不会减少像素工作集;"文件路径进、JSON 出"的拆分用 P3-1 的 Node worker 就能得到,且零重写成本。
- **重新评估的触发条件**(需同时满足 ①②,或满足 ③):① 需要 libvips 做不到的能力(自定义 RAW/HEIC 解码、严格的分块内存上限管线);② P3-1 之后瓶颈仍在 JS 侧的 CPU(例如超大库的目录遍历 + 哈希)而不是 libvips;③ 你愿意长期维护第二套工具链与多架构镜像。若要尝试,**从目录扫描/哈希 worker 开始**,而不是图像管线。

#### ⏸ P3-3 持久化队列 / 多实例
- 只在确有横向扩展需求时做(`project.md` §2.1 列出了全部进程内状态)。需要:数据库任务表 + 租约、HD 缓存索引共享或各自独立、限流计数外置(Redis)。当前个人自托管场景**不建议**(注意 SQLite 模式天然只支持单进程)。

#### ⏸ P3-4 视频转码预览(720p / HLS)
- 原"明确未做"项,与内存无关;有需求再做。

### D — 文档与一致性

| ID | 状态 | 内容 |
|---|---|---|
| D-1 | ⬜ | **README**:缩略图并发默认值写的是 15(第 14 行),实际 `min(4, CPU)`;内存实测表标注测试条件(NASA 素材/容器/版本);1C1G 等配方在 D-2 修复后再核对 |
| D-2 | ⬜ | 见 P0 的 D-2(compose 变量传递 + 双变量兼容回落)——放在 P0 因为它决定其余调优是否生效 |
| D-3 | ⬜ | `.env.example` 与 compose 的 `PGS_TAG` 对齐当前版本(`1.4.3`);补 `SCAN_MAX_DEPTH`(并入 D-2) |
| D-4 | ⬜ | **防止文档与配置再次漂移**:加一个 `scripts/check-docs.mjs`(零依赖),CI 里比对 ① 路由清单 ↔ `project.md` §8、② `config.ts` 环境变量 ↔ §10/`.env.example`、③ `find src` 文件清单 ↔ §3、④ `package.json` 版本 ↔ compose/`.env.example` 的 `PGS_TAG`、**⑤(r2/r3,配合 D-2)`config.ts` 读取的每个环境变量 ↔ compose `app.environment` 映射,或登记在"显式不映射"白名单(含理由)——漏映射即失败**、**⑥(r3 新增)`src/db/schema.ts` 的表/列定义 ↔ `src/db/bootstrap.ts` 的 `PG_DDL` 与 `LITE_DDL` 列名集合一致**(防止双驱动漏加列)。`project.md` §0 已列出人工核对命令,这一步把它们自动化 |
| D-5 | ⬜ | `project.md` §8 中仍有少量参数描述未逐条核对(如各接口的取值范围),下次碰到相应接口时顺带校对 |
| D-6 | ✅ | `project.md` 表格里未转义的 `\|`(渲染错位)——本次已修 |

### T — 测试

| ID | 状态 | 内容 |
|---|---|---|
| T-1 | ⬜ | **性能/内存回归**:`test.yml` 增加手动/夜间触发的 job:合成素材(含隔行 PNG、渐进 JPEG)+ 读取 `/status` 的 `maxRss` 与各闸门排队长度,**宽松断言**(例如 4×隔行 PNG 峰值 < 阈值),避免 CI 机器差异造成抖动;PR 默认不跑 |
| T-2 | ⬜ | **基准脚本入库** = P0-3 的 `scripts/bench/*`(r2:已合并,目录结构见 P0-3),输出 Markdown 表 + JSON,可直接贴进 `project.md` §17.3 |
| T-3 | ⬜ | 队列分池(P1-3)、`admit()` 与预算器(P1-1)、压力状态机(P1-6)的**纯逻辑单测**(`node --test`,不依赖 sharp/DB)。**先于实现编写**(P1-3 的"HEIC 不堵 JPEG / 不饿死"用例是 M2 的验收标准;M3 增加 HD `hit`/`coalesced`/`miss` 预算分流与 `AbortSignal` 取消用例) |
| T-4 | ⬜ | **HD 水印缓存安全测试**(P1-4,r2/r3),并入 `scripts/test-hd.mjs`:① 缓存命中仍每次重新校验权限(可见性变更或 `missingAt` 设置后立即 404);② 原图替换 / 水印配置变更 / 删除 / 黑名单后不命中旧缓存;③ Key 隔离(不同宽度、不同 host、不同 ver 互不串);④ 伪造 Host 不写缓存、不撑爆容量;⑤ 登录用户请求不命中游客缓存;⑥ BMP 原图在 HD 预览下正常生成带水印 WebP |

---

## 4. 建议的执行顺序(r2/r3:分阶段 + 出口门禁)

> **规则**:一次只做一个里程碑。**每个里程碑结束 = 提交 + 复核 + 人工确认门禁,通过后才进入下一个。** 里程碑内的子项尽量各自提交、各自跑基准,避免把"队列 + 闸门 + 预算 + HD"混在一起改,否则无法归因性能变化。

| 里程碑 | 内容 | 出口门禁(未满足不得进入下一阶段) |
|---|---|---|
| **M1 先让配置生效、能看见、有基线**(1.5~2 天) | **D-2**(含 D-3、F11 双变量回落与 `flag()` 修正)→ **D-4 的 ⑤⑥ 项**(配置映射与双驱动 DDL 校验脚本)→ D-1 → **P0-2**(含 cgroup `anon` 与 eventLoopDelay)→ **P0-3**(含 T-2 基准套件) | ① 运行中容器 `printenv` 与 `/status` 有效配置都与 `.env` 一致(含无前缀 `THUMB_CONCURRENCY`、`PGS_*` 兼容及不设时的 CPU 自适应);② `/status` 能显示 `external/arrayBuffers/cgroup(anon)/sharp/各闸门排队/eventLoopDelay`;③ 基线 JSON 入库,素材覆盖 HEIC / BMP / 16-bit PNG / 渐进 JPEG / 隔行 PNG / 混合 HD;④ **人工复核基线数据,据此确认或修正 M2/M3 的参数与优先级**;⑤ 本里程碑**不改变媒体解码与队列调度行为** |
| **M2 修调度与启动竞态**(1 天) | **T-3(先写分池单测)** → **P1-3**(`admit()` 仅类别并发)→ **P1-2 第一步**(`SHARP_CONCURRENCY`、`MEDIA_MAX_INPUT_MP` + `corrupt.ts` 排除 `[LIMIT]`)→ **F13 修复**(`ready.ts` 中 `await cleanTmp(0)` 移到 `enqueue` 之前)→ P2-7 | ① "100 HEIC + 100 JPEG"用例通过(不堵、不饿死);② `MEDIA_MAX_INPUT_MP` 拒绝的文件不被 `corrupt.ts` 当作损坏文件清理;③ `bench-queue` 与 M1 基线对比:耗时不劣化;④ 本阶段**不引入内存预算逻辑** |
| **M3 统一内存预算**(2~3 天) | **P1-1**,按 **a 普通派生(含解码前轻量 `probe`)→ b HD 流水线(`hit`/`coalesced`/`miss` 三路分流)→ c HEIC/BMP(含 BMP 26B 头探测)→ d 视频** 分四次提交;每步后重跑基准;**P1-2 第二步**(`MEDIA_MAX_EST_MB` 硬限制) | ① 每步"估算 vs 实测"偏差表达标;② 混合负载(大图 + 小图、混合 HD、同图并发 `coalesced` 与缓存 `hit`)峰值下降且耗时/p95 可接受;③ `MEDIA_BUDGET_MB=0` 可回退到现状;④ 系数表中 `low` 置信度项(除无本地副本的 S3 外)清零或有明确说明 |
| **M4 兜底与专项优化**(按需) | **P1-6 压力保护(开头)** → **P2-9**(崩溃回路保护 + PG/SQLite 双驱动 `bootstrap.ts` 升级 + `corrupt.ts` 排除 `[INTERRUPTED]`)→ **P1-4(+T-4)**(`buildLayer` 去二次 PNG + 游客水印磁盘缓存)→ **P1-5**(HEIC 原生子进程评估)→ **P2-1**(BMP/HD 对齐)→ P2-3 | 各项自带验收;P1-4 的磁盘缓存与 P1-5 **先看测量数据,数据不支持就不做**(但 P1-4 候选 1 消除 `buildLayer` 二次 PNG 与 P2-1 修复 HD BMP/ext 私有副本可直接做) |
| **M5 前端与架构**(按需) | P2-4、P2-5、P2-6、P2-8、D-4 剩余项(①~④) | — |
| **观察期** | P3-*(含 P3-1 前置条件) | 仅在触发条件成立时启动 |

> 注:D-4 的 ⑤(compose 变量映射校验)与 ⑥(`schema.ts` ↔ `bootstrap.ts` 双驱动 DDL 校验)成本低且能直接兜底 F1/F11/F17,因此在 M1 随 D-2 一并落地;其余文档检查项(①~④)随 M5 完成。

**为什么 P0-3(基线)提前到 M1**(采纳 ChatGPT 的调整):没有真实基线,M2 的"耗时不劣化"、M3 的"估算校准"都没有参照物;而 M1 已经让配置真正生效,此时测得的基线才是用户真实部署的样子。**代价**:M1 从半天变成约 2 天(素材准备占大头)。

## 5. 明确暂不做 / 不建议做

- ❌ 把 `toFile` 当作内存优化项(实测无收益,仅 P2-2 卫生)。
- ❌ 下调 `THUMB_WIDTH`/`PREVIEW_WIDTH`/`HD_WIDTH` 来"省内存"(输出尺寸不是主因,只损失画质)。
- ❌ 一刀切把输入像素上限降到 60~100MP(按格式加权才合理,见 P1-1/P1-2)。
- ❌ 整体或部分改写成 Rust(见 P3-2)。
- ❌ 把 `HD_CACHE_MAX_MB` 当作内存手段(它只是磁盘上限)。
- ❌ **整份 `env_file: [.env]` 注入容器**(r1 曾推荐,r2 撤回):违背最小权限;改用显式映射 + 双变量兼容回落 + D-4 校验。
- ❌ **在 `docker-compose.yml` 里保留硬编码默认 `${PGS_THUMB_CONCURRENCY:-4}`**(r3 明确禁止,见 F11):既屏蔽了无前缀 `THUMB_CONCURRENCY`,又破坏了 `config.ts` 的 `Math.min(4, cpu)`。
- ❌ **在 P0-3 完成前把估算系数 / `MEDIA_BUDGET_MB` 默认值定稿**:合成素材数据不能直接当生产参数。
- ❌ **把 `MediaBudget` 做成与 `queue.ts` 各自排队的第二个队列**:所有等待只发生在 `admit()`。
- ❌ **在 HD 查缓存与 `inflight` 之前无条件申请未命中全量预算或对 S3 原图提前 `materialize` 做 `probe`**(r3 明确禁止,见 F14/F16)。
- ❌ **让 `MEDIA_MAX_INPUT_MP` / `MEDIA_MAX_EST_MB` 超限或 P2-9 崩溃中断的记录进入 `corrupt.ts` 自动物理删除流程**(r3 明确禁止,见 F12)。
- ❌ **直接用 cgroup `memory.current` 做压力判据**:含可回收页缓存,会误触发,须用 `memory.stat` 的 `anon`。
- ❌ **一次性执行整个 todo**:按 §4 的门禁分阶段推进。

## 6. 度量与验收的统一口径

- **峰值**:进程 `VmHWM`(`/proc/self/status`)或 P0-2 的 `maxRss` 与 `cgroup.anon`;**回落**:任务结束后静置 20 秒的 RSS。
- **基线**:启动后空载 RSS(Next 约 250MB;裸 sharp 进程 61MB)。
- **场景**:派生图 ×1/×4;HD convert ×1/×3;HD 水印 ×1/×3/×24(分游客与登录用户、首次与命中);混合负载(1 大图 + 20 小图);HEIC 批量 50 张。
- **报告**:每次改动后把结果追加到 `project.md` §17.3,并注明环境(CPU/内存/Node/sharp/libvips、是否容器、是否 jemalloc、素材来源)。
- **r2/r3 追加**:① 每次报告除峰值与回落外,必须同时给出**总耗时与 p50/p95**,并与上一次基线 JSON 对比;② 预算相关改动必须附"**估算 vs 实测**"偏差表(每个素材一行);③ 混合场景(大小图混合、混合 HD、同图并发 `coalesced`、HEIC + JPEG 混合)与单一场景同等重要;④ 合成素材的结论要标注"合成",真实素材结果出来后以后者为准。

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
  const m = await sharp(f, INPUT).metadata();                           // 正式实现中须位于解码前(见 P1-1 ⑥ / F16)
  const w = Math.ceil(m.width * m.height / 1e6 * (m.isProgressive ? 1.5 : 1));
  await acquire(w);
  try { await sharp(f, INPUT).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toBuffer(); }
  finally { release(w); }
}
```

注意:演示里的 `acquire/release` 带有自己的等待队列,**仅用于演示峰值内存的变化**——正式实现不要照搬这种"独立队列"形态(见 P1-1 ①,等待只能发生在 `admit()`);演示里的 `1.5` 只是让隔行/渐进更"重"的粗糙系数;正式实现请按 P1-1 的"字节/像素"表估算 MB,并用 P0-3 的真实素材校准。此外演示里的 `wm` 场景跳过了 `watermark.ts#buildLayer` 首次构建水印层的成本(见 F15),`scripts/bench/bench-hd.mjs` 应同时测量 `layerCache` 冷启动与命中两种情况。

## 附录 B:本次评估的局限(重申)

合成素材、glibc 默认 malloc、非容器、Node 22;未测 HEIC/BMP/视频/16-bit/CMYK;未复现 README 的 1897MB;F1 基于 Compose 语义判断,尚未在真实容器内验证。上述项目在 P0-3 中补齐,**在此之前请把 §1~§2 的结论当作"高置信的方向判断",而不是精确的容量规划**。

**r2/r3 补充**:
1. 1434MB → 500MB 是**合成图片、特定环境**下的微基准,**不等于真实用户负载会得到同样的改善**;
2. 估算公式里的每个系数,在 P0-3 给出真实素材数据之前,都只是"起点"。P0-3 必须补齐 HEIC、BMP、16-bit PNG、渐进 JPEG 与混合 HD 请求,再确定最终参数;
3. F9 的"崩溃回路"与 F13 的"`cleanTmp(0)` 启动清理竞态"均由源码审查得出,在 M2 / M4 的 P2-9 验收时一并实测验证;
4. F12 的"`corrupt.ts` 5 小时后物理删除 `status='failed'` 受管原文件"是源码中已存在的确定行为,M2/M3/M4 凡是将非损坏文件标记为 `failed` 的改动,都**必须同步更新 `corrupt.ts` 的过滤条件**。
