# 媒体处理基准(scripts/bench)

> 回答三个问题:**哪种素材最吃内存?并发 ×N 时峰值是多少?改动之后内存和耗时各变了多少?**
> 全部脚本零额外依赖(只用项目已有的 `sharp` / `heic-convert`),**不需要 root、不联网、不需要数据库和 Docker**。

## 文件

| 文件 | 作用 |
|---|---|
| `generate-images.mjs` | 合成素材:基线/渐进 JPEG、非隔行/隔行 PNG、16-bit PNG、TIFF、CMYK TIFF、BMP;`real/` 目录里的真实素材(HEIC、相机原图)自动纳入 |
| `bench-memory.mjs` | 每个「素材 × 场景(derive/hd)× 并发」**单独起子进程**取 `VmHWM` 峰值,另记静置后 RSS、总耗时、单任务 p50/p95;可 `--save` / `--compare` |
| `baseline-synthetic-quick.json` | 入库的基线(**合成素材、`--quick` 缩小到 1/4 像素、无 jemalloc、沙箱 4 vCPU**,仅作相对比较与估算系数的起点) |

## 用法

```bash
node scripts/bench/generate-images.mjs --out /tmp/pgs-bench [--quick]        # --quick:像素量 1/4,小机器/CI 冒烟用
node scripts/bench/bench-memory.mjs --dir /tmp/pgs-bench                     # 全量,输出 Markdown 表
node scripts/bench/bench-memory.mjs --dir /tmp/pgs-bench --only progressive --conc 1,4,8
node scripts/bench/bench-memory.mjs --dir /tmp/pgs-bench --save /tmp/new.json
node scripts/bench/bench-memory.mjs --dir /tmp/pgs-bench --compare scripts/bench/baseline-synthetic-quick.json
```

可调参数:`--sharp-concurrency`(默认 2,与项目一致)、`--settle`(静置秒数,默认 3;想看「回落值」建议 20)、`--limit-mp`(输入像素上限,默认 268)、`--scen derive,hd`。

### 在容器里跑(最接近线上)

镜像是以非 root 用户(uid 1000)运行应用的,基准脚本同样不需要 root,但**素材目录必须对 uid 1000 可写**:

```bash
docker run --rm -v "$PWD/bench-data:/bench" --entrypoint '' \
  --user 1000:1000 -e LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 -e MALLOC_ARENA_MAX=2 \
  --memory 1g --cpus 1 ghcr.io/dming623/picgalleryserver:<tag> \
  sh -c 'cd /app && node scripts/bench/generate-images.mjs --out /bench && node scripts/bench/bench-memory.mjs --dir /bench --settle 20 --save /bench/result.json'
```

> 注意:生产镜像里 `scripts/` 是否存在取决于 `.dockerignore`;若不在镜像内,把仓库挂进去(`-v "$PWD:/repo:ro"`,`cd /repo`)即可,脚本只读 `node_modules`。
> 结果表头里的 `jemalloc` / `mallocArenaMax` 字段会如实记录是否生效,**对比基线时必须环境一致**。

## 怎么解读

- **峰值 RSS** = 该场景子进程的 `VmHWM`(含 ≈60MB 的裸 sharp 进程基线)。要看「单任务增量」用 `(×4 峰值 − ×1 峰值) / 3`。
- **静置 RSS** 反映内存是否归还(jemalloc 生效时应明显回落)。
- **总耗时 / p50 / p95**:改动后必须与内存**一起**对比,避免「峰值降了、时间翻倍」。
- 合成素材只是**起点**;`real/` 里放真实 HEIC / 24MP+ 相机 JPEG 后重新生成基线,以真实结果为准。

## 本次基线给出的观察(合成素材,`--quick`,单任务工作集 = 并发增量)

| 类别 | derive 单任务 | HD 单任务 | 备注 |
|---|---:|---:|---|
| 基线 JPEG / 非隔行 PNG / TIFF / 16-bit PNG | ≈ 15 + 2.2×MP MB | ≈ 30 + 1.3×MP MB | 流式解码 |
| 渐进 JPEG / 隔行 PNG | ≈ 19 + 3.8×MP MB | ≈ 37 + 3.2×MP MB | 需要整图缓冲;**同像素量约为流式的 1.5~2.5 倍** |
| **CMYK TIFF** | ≈ 15 + 15×MP MB | ≈ 30 + 30×MP MB | **色彩空间转换极贵**,是最重的一类(约为流式的 7~25 倍) |

这些数字就是 `src/server/media/estimate.ts` 里系数表的来源(标注为 `measured-synthetic`,置信度 `medium`)。
HEIC / BMP / 视频没有合成素材可测,系数是 `guess`(置信度 `low`,估算自动 ×1.5)——**有真实样张后请补测并更新系数表**。

## 更新基线的规则

1. 只在「媒体处理逻辑」或「环境/依赖版本」变化后更新;
2. 提交基线 JSON 时在提交信息里写明环境(CPU/内存/Node/sharp 版本、是否容器、是否 jemalloc、素材来源);
3. 不要拿不同环境(例如本机 vs 容器)的结果互相对比。
