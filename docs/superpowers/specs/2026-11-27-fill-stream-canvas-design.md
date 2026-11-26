# 让浮动模式画面填满大容器 — 设计

**Approved:** 2026-11-27（用户选择方案 1：让画面随容器放大）
**Problem:** `#stream` 盒子本身在浮动模式下始终等于父容器 `.stage`（800×600 到 3840×2160 实测一致）。但里面的 `canvas.video-layer` / `canvas.touch-layer` 只在引擎 CSS 里有 `max-width/max-height`，只能缩小不能放大；协商分辨率（如 620×1280）远小于大屏容器时，留下大片黑边，看起来像画面不填充。

## Goals

- 浮动模式下，画面按容器可用空间等比放大或缩小，铺满可用区域（保留上下各 2px 呼吸间距和右侧工具轨）。
- 放大不拉伸比例；触摸层与视频层保持**完全相同的 CSS 盒子**，触摸坐标映射不被破坏。
- 窗口 resize、连接建立、画面尺寸变化后都会重算。

## Non-goals / 不采用的方案

- 不改 `fitToScreen`：它会让服务端按容器尺寸重新编码，窗口变化还需要重连，代价大。
- 不单独给 canvas 加 `object-fit:contain` + `width:100%`：元素盒子会大于实际画面，触摸坐标会错位。
- 不改并排模式的固定列宽（那是分栏设计）。

## Approach

1. `shared/device-ui.mjs` 新增纯函数 `fitCanvasSize({ width, height, availableWidth, availableHeight })`：
   - `scale = min(availableWidth / width, availableHeight / height)`；
   - 返回 `{ width: round(width * scale), height: round(height * scale) }`；
   - 尺寸非法（≤0 / 非有限数）时返回 `null`。
2. `web/app.js` 新增 `fitStreamCanvas()`：取 `canvas.video-layer` 的 intrinsic `width/height` 与 `.video` 的可用 rect（高度扣掉 4px margin），调用纯函数，把结果写成两个 canvas 的 `style.width/style.height`。
3. 调用点：`onConnect`、`onResize`、现有 `window.resize` 监听、以及标签页重新可见（`visibilitychange`）时。
4. i18n/设置/后端都不动。

## Verification

- `tests/device-ui.test.mjs`：纯函数放大/缩小/比例/非法输入。
- `tests/ui-layout.test.mjs`：静态检查调用点存在。
- `npm test` 全绿；本机浏览器在大视口下实测 canvas rect 接近 `.video` 可用区域，且触摸层与视频层 rect 相等。
