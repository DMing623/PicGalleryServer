# 前端丝滑流畅度优化记录与回滚指南（一次性说明文档）

> **说明**：本文档仅用于记录本次前端流畅度优化的每一项独立提交、修改文件、性能收益及一键回滚命令。其他任何代码与工程文档均未引用本文件；确认所有优化在线上运行稳定后，可直接删除本文件。
>
> **优化前原始基线 Commit**：`4e0adb1fa4a975c75686a02ce94d6920c9b9c500` (`4e0adb1`)
> **一键彻底回滚到优化前状态**：
> ```bash
> git reset --hard 4e0adb1fa4a975c75686a02ce94d6920c9b9c500
> git push --force-with-lease origin main
> ```

---

## 优化项 1：瀑布流图库 (`Gallery.tsx`) 二分窗口化、瓦片 Memo 化与零回流滚动

- **回滚锚点（上一提交）**：`4e0adb1fa4a975c75686a02ce94d6920c9b9c500`
- **涉及文件**：`src/components/Gallery.tsx`
- **问题根因**：
  1. 滚动每经过一个量化步长（240px），`Gallery` 触发重渲染，由于瓦片内联渲染且每次创建新的 `onClick={() => setOpen(idx)}` 闭包，视口内已存在的 100~200 个瓦片全部跟随重新协调（Reconciliation）；
  2. `segmentsOf(col)` 在每次窗口步进时对每列全部瓦片执行 $O(N)$ 线性扫描，大图库滚动到深处时耗时随加载页数线性增长；
  3. 滚动 `requestAnimationFrame` 中每次调用 `el.getBoundingClientRect().top`，若遇图片解码或尺寸变化易触发同步布局回流（Forced Synchronous Layout）；同时 `ResizeObserver` 在无限滚动追加分页导致容器高度变化时也会频繁触发状态更新；
  4. 存在 `pending` 处理中媒体时，每 3 秒轮询用 `prev.map(...)` 无条件替换前 80 项的对象引用，导致未发生变化的 79 项也触发整页瀑布流 `columns` 重新分列；
  5. 瀑布流内每个视频时长角标均带有 `backdrop-blur`，滚动时产生大量独立 GPU 背景模糊合成层。
- **优化措施（维持原有页面布局不变）**：
  1. 抽离 `React.memo(MasonryTile)` 并配合稳定的 `handleSelect` 回调，使窗口滚动步进时已在视口内的瓦片 0 重渲染；
  2. 利用列内瓦片 `top` 严格单调递增的性质，将 `segmentsOf` 升级为 $O(\log N)$ 二分查找区间切片，并用 `useMemo` 缓存 `columnSegments`；
  3. 在 `ResizeObserver` 中缓存容器文档顶部偏移 `boxDocTop` 并过滤 `<0.5px` 的宽度抖动与纯高度变化，滚动监听直接通过 `window.scrollY - boxDocTop.current` 计算相对位置，实现滚动帧零同步布局读取；
  4. `pending` 轮询增加 `sameMediaRow` 字段级比对与 `document.visibilityState === "hidden"` 暂停，无实质变化时直接返回原数组引用；
  5. 移除滚动瓦片内视频角标的 `backdrop-blur`（改用高对比半透明底色 `bg-black/70`），消除滚动过程中的多图层实时背景采样开销。
- **本项提交 Hash**：`39b0a8f3dc55340733bcc16de4d39bf88e7abb2d` (`39b0a8f`)
- **单独回滚本项优化**：
  ```bash
  git reset --hard 4e0adb1fa4a975c75686a02ce94d6920c9b9c500
  ```

---

## 优化项 2：全屏查看器 (`Viewer.tsx` + `useHd.ts`) 120Hz 手势直写 DOM、HD 异步预解码与详情防竞态缓存

- **回滚锚点（上一提交）**：`39b0a8f3dc55340733bcc16de4d39bf88e7abb2d`
- **涉及文件**：`src/components/Viewer.tsx`、`src/components/useHd.ts`、`project.md`
- **问题根因**：
  1. `ZoomStage` 在滚轮缩放、鼠标拖拽与双指捏合（`pointermove` / `wheel`，高刷屏下 120~240Hz）的每一次事件中都调用 `setView(v)` 和 `setGrabbing(true)`，导致手势期间每秒触发上百次 React 组件树重渲染；
  2. `rel(e)` 在每次滚轮与双指缩放移动事件中同步读取 `stage.current.getBoundingClientRect()`，容易造成高频手势下的布局回流抖动；
  3. `useHd.ts` 下载完成 2560px 高清 WebP 后直接将 Blob URL 塞给 `<img>`，浏览器在首帧上屏与切换下一张时在主线程/光栅线程同步解码 4MP+ 大图，产生 30~80ms 首帧掉帧；
  4. 查看器连续快速切换上/下一张图片时，`/api/v1/media/:id` 请求缺少序号防竞态保护与会话缓存，反复回看已浏览图片会闪烁「加载中…」。
- **优化措施（维持原有页面布局不变）**：
  1. 将 `ZoomStage` 的位移与缩放变换改为直接操作 `contentRef.current.style.transform`（`translate3d + scale`），仅在跨越 `1.001` 缩放阈值或拖拽指针状态真正改变时才触发 React 状态更新，实现手势全程 0 React 重渲染；
  2. 在 `ResizeObserver` 和 `pointerdown` 阶段缓存舞台边界 `rectRef`，手势移动与滚轮缩放过程中零同步布局读取；
  3. 在 `useHd.ts` 的 `fetchHd` 中通过离屏 `Image` + `pre.decode()` 完成异步预解码后再置为 `ready`，相邻预加载图片同样提前解码进位图缓存，左右翻页与滑动切换瞬间上屏；
  4. 在 `Viewer.tsx` 中引入请求序号防竞态（`loadReqId`）与容量为 30 的会话级详情 LRU 缓存（修改备注或重处理时自动穿透刷新）。
- **本项提交 Hash**：`7d09c238e8d143a9699414902ca4ad59b0cb1ccb` (`7d09c23`)
- **单独回滚到优化项 1（撤销优化项 2）**：
  ```bash
  git reset --hard 39b0a8f3dc55340733bcc16de4d39bf88e7abb2d
  ```

---

## 优化项 3：毛玻璃图层合成隔离、顶栏搜索防重渲染与通知面板 `Intl` 缓存 (`globals.css`, `Shell.tsx`, `NoticeBell.tsx`, `lib/format.ts`, `Markdown.tsx`)

- **回滚锚点（上一提交）**：`7d09c238e8d143a9699414902ca4ad59b0cb1ccb`
- **涉及文件**：`src/app/globals.css`、`src/components/Shell.tsx`、`src/components/NoticeBell.tsx`、`src/lib/format.ts`、`src/components/Markdown.tsx`
- **问题根因**：
  1. `body::before` 四重径向渐变背景及固定定位的 `.topbar` / `.dock` 毛玻璃栏缺少 GPU 独立图层提升与 `contain` 边界隔离，瀑布流滚动时易触发大面积重绘；`.mtile` 与 `.tile` 缺少 `contain: layout paint style`，单张图加载或悬停高亮会污染同列相邻节点；
  2. `.notice-date.unread` 的 `@keyframes date-blink` 对 `background` 做无限循环动画，属于非合成层属性，导致通知下拉展开时主线程以 60fps 持续重绘；
  3. `Shell.tsx` 将搜索框受控状态 `text` 放在顶层，用户在搜索栏每输入一个字符都会触发整个 `Shell`（含 `NoticeBell`、`main`、底部 `.dock`）重渲染；
  4. `NoticeBell.tsx` 的 `dateKey`/`timeLabel`/`dayLabel` 在遍历通知数组时每次调用都执行 `new Intl.DateTimeFormat(...)`（同样 `lib/format.ts` 每次调 `toLocaleString`），V8 反复实例化国际化格式化器造成明显主线程卡顿；`Markdown.tsx` 亦未做 `memo` 缓存。
- **优化措施（维持原有页面布局不变）**：
  1. 为 `body::before`、`.topbar`、`.dock` 增加 `transform: translateZ(0)` 与 `contain: layout style`，为 `.mtile`、`.tile` 增加 `contain: layout paint style`；将 `.notice-date.unread` 呼吸动画改为合成器线程执行的 `opacity` 动画；
  2. 在 `Shell.tsx` 中将搜索表单抽离为独立的 `memo(SearchForm)` 组件，搜索框打字时整页外壳零重渲染；
  3. 在 `NoticeBell.tsx` 与 `lib/format.ts` 中按时区/格式缓存 `Intl.DateTimeFormat` 实例，通知分组与时间格式化提速数十倍；通知未读轮询在后台标签页自动暂停；`Markdown.tsx` 增加 `memo` 与 `useMemo` 缓存。
- **本项提交 Hash**：`820cd18c34cdcfa1efbbcb469dabb573d3c4d4fe` (`820cd18`)
- **单独回滚到优化项 2（撤销优化项 3）**：
  ```bash
  git reset --hard 7d09c238e8d143a9699414902ca4ad59b0cb1ccb
  ```

---

## 优化项 4：启动页 (`Splash.tsx`) 粒子网络批量路径绘制与全屏离场去模糊卡顿

- **回滚锚点（上一提交）**：`820cd18c34cdcfa1efbbcb469dabb573d3c4d4fe`
- **涉及文件**：`src/components/Splash.tsx`
- **问题根因**：
  1. `Splash.tsx` 的粒子画布在每一帧（60/120fps）循环中对每个粒子单独执行 `ctx.beginPath() + ctx.arc() + ctx.fill()`（最高 140 次/帧），并对每条距离 `<12000` 的连线单独执行 `ctx.beginPath() + ctx.stroke()`（每帧约 300~500 次独立绘制指令），Canvas 2D 状态切换与命令提交开销高；
  2. 启动页结束或点击「跳过 ›」进入 `leaving` 阶段时，一方面全屏容器执行 `filter: blur(10px)` 的 650ms CSS 过渡（迫使浏览器对包含实时 Canvas + 3D 旋转光环 + 12 层 3D 文字的整屏内容逐帧重光栅化并做高斯模糊），另一方面 Canvas 帧循环仍在继续运行，导致退场露出相册主页的瞬间明显掉帧，且 650ms 内阻断底层点击。
- **优化措施（维持原有页面布局不变）**：
  1. 将全部粒子圆点合并为单次 `beginPath() + fill()` 绘制，粒子连线先通过包络盒快速剪枝（`|dx| > 110 || |dy| > 110`），再按距离归入 3 个透明度桶批量 `stroke()`，每帧 Canvas 绘制调用从 ~500 次降至 4 次；
  2. 在 `leaving` 触发或标签页后台隐藏时立即终止 `requestAnimationFrame` 循环（保留画布最后一帧静态画面平滑淡出）；
  3. 离场过渡改为纯 GPU 合成器属性 `opacity + transform: scale(1.04) translateZ(0)`，并在 `leaving` 开始瞬间设置 `pointerEvents: "none"` 立即释放底层画廊交互。
- **本项提交 Hash**：`2f129dc2f5d5519550593bd63845daa892ca6c78` (`2f129dc`)
- **单独回滚到优化项 3（撤销优化项 4）**：
  ```bash
  git reset --hard 820cd18c34cdcfa1efbbcb469dabb573d3c4d4fe
  ```

---

## 优化项 5：批量上传进度节流、元数据面板 `Memo` 化、相册树 $O(N)$ 索引与设置页可见性感知轮询 (`UploadDialog.tsx`, `MetaPanel.tsx`, `AdminTabs.tsx`, `SystemTab.tsx`)

- **回滚锚点（上一提交）**：`2f129dc2f5d5519550593bd63845daa892ca6c78`
- **涉及文件**：`src/components/UploadDialog.tsx`、`src/components/MetaPanel.tsx`、`src/components/settings/AdminTabs.tsx`、`src/components/settings/SystemTab.tsx`
- **问题根因**：
  1. `UploadDialog.tsx` 在多文件并发上传时，每个文件的 `xhr.upload.onprogress` 每秒触发数十次并调用 `setJobs(js.map(...))`，导致整个文件列表（可能包含上百个带有 `.glass` `backdrop-filter` 的 `<li>` 节点）每秒全量重渲染上百次；同时相册下拉树构建递归执行 `albums.filter` 为 $O(N^2)$ 复杂度；
  2. `MetaPanel.tsx` 未做 `memo` 缓存，在查看器中输入下载密钥或编辑备注时，每次按键都会触发 EXIF/XMP/AI 提示词/原始元数据分组的重新遍历与子组件重渲染；
  3. `AdminTabs.tsx` 的 `AlbumManager` 在渲染每一行相册时都调用 `albums.filter((a) => a.parent === code).length`（$O(N^2)$），且与 `SystemTab.tsx` 的 3s/5s/10s 轮询在浏览器标签页处于后台时仍持续请求并触发状态更新。
- **优化措施（维持原有页面布局不变）**：
  1. 对 `UploadDialog.tsx` 的 `xhr.upload.onprogress` 增加 ≥2% 步长节流，抽离 `React.memo(FileJobRow)` 使单文件进度变化仅重渲染自身行，移除模态框内部列表项重复叠加的 `backdrop-filter`，并将相册树展开算法由 $O(N^2)$ 优化为 $O(N)$ 邻接表遍历；
  2. 为 `MetaPanel.tsx` 增加 `React.memo` 与 `useMemo` 解析结果缓存，使查看器交互（输入密钥、编辑备注、切换全屏）期间元数据侧栏零重算；
  3. 在 `AdminTabs.tsx` 中用 `childCountMap` 预计算子相册数量（$O(1)$ 查询），并在 `AdminTabs.tsx` 与 `SystemTab.tsx` 中增加 `document.visibilityState` 感知与时区 `Intl.DateTimeFormat` 缓存。
- **本项提交 Hash**：`61f03afa12a56f13c8f6346bc2cfd8ee787e7c1e` (`61f03af`)
- **单独回滚到优化项 4（撤销优化项 5）**：
  ```bash
  git reset --hard 2f129dc2f5d5519550593bd63845daa892ca6c78
  ```

---

## 优化项 6：相册卡片 `Memo` 与封面异步解码、免责声明滚动 `rAF` 节流 (`AlbumsView.tsx`, `Disclaimer.tsx`)

- **回滚锚点（上一提交）**：`61f03afa12a56f13c8f6346bc2cfd8ee787e7c1e`
- **涉及文件**：`src/components/AlbumsView.tsx`、`src/components/Disclaimer.tsx`
- **问题根因**：
  1. `AlbumsView.tsx` 中的相册卡片 `Card` 未做 `memo` 包装且内部重复调用 `useApp()`，封面图 `<img>` 缺少 `decoding="async"`，当相册数较多时主线程同步解码封面缩略图并重复渲染卡片；
  2. `Disclaimer.tsx` 的阅读区域 `onScroll={measure}` 在每个滚动事件中同步读取 `scrollHeight / clientHeight / scrollTop` 并直接 `setProgress`，导致访客滚动阅读须知时逐像素重渲染带有全屏 `backdrop-filter: blur(26px)` 的弹窗容器。
- **优化措施（维持原有页面布局不变）**：
  1. 将 `AlbumsView.tsx` 的 `Card` 包装为 `React.memo(Card)`，由父级统一传入 `showManage` 并为封面 `<img>` 增加 `decoding="async"` 与 `draggable={false}`；
  2. 将 `Disclaimer.tsx` 的 `onScroll` 测量放入 `requestAnimationFrame` 节流，且仅在整数百分比实际变化时才触发 `setProgress`。
- **单独回滚到优化项 5（撤销优化项 6）**：
  ```bash
  git reset --hard 61f03afa12a56f13c8f6346bc2cfd8ee787e7c1e
  ```

---

## 附：分步回滚速查表

| 想要回滚到的状态 | 目标 Commit | 执行命令 |
|---|---|---|
| **完全回滚到优化前原始状态** | `4e0adb1` | `git reset --hard 4e0adb1fa4a975c75686a02ce94d6920c9b9c500` |
| 保留优化 1（瀑布流二分窗口化 + Memo 瓦片） | `39b0a8f` | `git reset --hard 39b0a8f3dc55340733bcc16de4d39bf88e7abb2d` |
| 保留优化 1~2（+ 查看器手势直写 DOM + HD 预解码） | `7d09c23` | `git reset --hard 7d09c238e8d143a9699414902ca4ad59b0cb1ccb` |
| 保留优化 1~3（+ 毛玻璃合成层隔离 + 搜索解耦 + Intl 缓存） | `820cd18` | `git reset --hard 820cd18c34cdcfa1efbbcb469dabb573d3c4d4fe` |
| 保留优化 1~4（+ 启动页粒子批量绘制 + 离场优化） | `2f129dc` | `git reset --hard 2f129dc2f5d5519550593bd63845daa892ca6c78` |
| 保留优化 1~5（+ 上传进度节流 + 元数据 Memo + 相册树 O(N)） | `61f03af` | `git reset --hard 61f03afa12a56f13c8f6346bc2cfd8ee787e7c1e` |

> **确认无误后清理本一次性文档**：
> ```bash
> git rm FRONTEND_OPTIMIZATION.md && git commit -m "chore: 移除一次性前端优化说明文档" && git push origin main
> ```
