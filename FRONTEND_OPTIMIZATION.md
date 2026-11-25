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
- **单独回滚到优化项 1（撤销优化项 2）**：
  ```bash
  git reset --hard 39b0a8f3dc55340733bcc16de4d39bf88e7abb2d
  ```
