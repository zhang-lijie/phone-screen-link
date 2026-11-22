# 窗口自适应与浏览器全屏 设计

日期：2026-11-22
状态：待用户确认

## 意图与原因

用户要"浏览器窗口大小根据视频流分辨率自适应调整"。经排查确认三点事实：

1. **画面区域已自适应填充窗口**：`#stream` 用 `flex:1; height:100%`，`.video` 用确定 grid track，canvas 用 `max-width/max-height:100%` 等比缩放。实测窗口从 983×482 改成 1280×720，画布从 879×426 自动变成 1208×585。此项无需改动。
2. **普通标签页 `window.resizeTo()` 不生效**：实测调用后 `outerWidth` 变了但 `innerWidth` 不变，浏览器禁止脚本调整标签页尺寸。因此"自动调整窗口"仅在允许 resizeTo 的环境（Chrome `--app` 模式、脚本弹出的窗口、Electron 壳）真正生效，普通标签页需降级提示。
3. **手机横竖屏切换会带来分辨率方向变化**：`onConnect(info.resolution)` 给出编码分辨率（竖屏 `522x1080`、横屏 `1280x620` 等），可作为方向切换的信号源。

## 目标 / 非目标 / 反目标

**目标**

- 视频流方向从竖变横（或反之）时，尝试调整浏览器窗口尺寸以匹配新方向。
- 设置面板提供开关「画面方向变化时调整窗口」，默认开，可关闭。
- `#stream` 右上角新增按钮，调用浏览器全屏 API（`requestFullscreen`/`exitFullscreen`），与左上角现有 CSS 伪全屏按钮并存、功能不同。
- 普通标签页 resizeTo 无效时，状态栏显示一次提示，引导用户用右上角全屏按钮。

**非目标**

- 不改画面区自适应逻辑（已具备）。
- 不做 Electron 壳 / app 模式封装；只在能 resizeTo 的环境生效，其余降级。
- 不在每次连接都调整窗口——只在方向变化时调整（首次连接记录基线，不调整）。

**反目标**

- 窗口尺寸不得超过物理屏幕；不得因 resizeTo 报错影响投屏和控制。
- 提示不得刷屏（同一状态只提示一次）。

## 约束

- 浏览器安全上下文：页面在 `http://127.0.0.1:8000`（secure context），`requestFullscreen` 需用户手势（点击按钮满足）。
- 屏幕物理尺寸 `screen.width/height`（实测 1536×864），窗口目标需 clamp 到可用范围。
- 设备编码分辨率随设备状态变化（竖屏约 522×1080，横屏约 1280×620），以 `info.resolution` 为唯一来源，不用硬编码。
- 现有 i18n 机制：`data-i18n` 属性 + `shared/keys.mjs` 的 MESSAGES + 语言包 parity 测试。

## 设计

### 1. 方向检测与窗口调整（web/app.js）

- 在 `onConnect(info)` 里解析 `info.resolution` → `{w, h}`，算方向 `landscape = w >= h`。
- 模块级状态 `let lastOrientation = null`。
  - 若 `lastOrientation === null`：仅记录 `lastOrientation = orientation`，**不调整窗口**（首次连接保持用户当前窗口）。
  - 若方向与 `lastOrientation` 不同：更新 `lastOrientation`，若设置开关开启，调用 `autoResizeWindow(w, h, orientation)`。
- `autoResizeWindow(w, h, orientation)`：
  - **自适应填满屏幕高度**（用户选定）：
    - 竖屏：目标窗口高 `= round(screen.availHeight * 0.9)`，宽 `= round(targetH * (w/h))`；再加右侧工具栏宽（约 60px）和上下 padding（约 40px）补偿。
    - 横屏：目标窗口宽 `= round(screen.availWidth * 0.9)`，高 `= round(targetW * (h/w))`；再加状态栏高（约 40px）和 padding 补偿。
  - 用 `Math.min(..., screen.availWidth/Height)` clamp，避免超出屏幕。
  - 调 `window.resizeTo(targetW, targetH)`（普通标签页会被浏览器忽略）。
  - 检测有效性：下一帧读 `innerWidth/innerHeight`，若与预期不符且开关开启，触发一次降级提示。
- 降级提示：`setStatus('status.windowResizeUnsupported')`，文案中英文；用标志位确保每次方向切换只提示一次。

### 2. 设置面板开关（web/index.html + shared/keys.mjs）

- 新增设置项 `autoResizeWindow: true`（默认开），加入 `DEFAULT_SETTINGS`、`normalizeSettings`（布尔校验）、i18n key。
- 设置面板「控制设置」组加一个复选框 `data-i18n="settings.autoResizeWindow"`。
- 测试：normalizeSettings 默认值/布尔校验、i18n parity。

### 3. 右上角全屏按钮（web/index.html + web/styles.css + web/app.js）

- 在 `#stream` 内右上角（与左上角 `.fullscreen-toggle` 对称）新增按钮 `#browser-fullscreen-toggle`，带全屏图标。
- 样式类似 `.fullscreen-toggle`，`top:10px; right: calc(工具栏宽 + 10px)` 避免压住工具栏；在 CSS 伪全屏时工具栏隐藏，right 相应调整。
- 点击处理：
  - 若 `!document.fullscreenElement` → `await streamEl.requestFullscreen()`
  - 否则 → `await document.exitFullscreen()`
- 监听 `document.addEventListener('fullscreenchange', ...)`：按 `document.fullscreenElement` 更新按钮 title/图标（进入/退出文案）。
- i18n keys：`fullscreen.browserEnter` / `fullscreen.browserExit`，中英文。
- 与左上角按钮独立：左上角仍切 `body.screen-fullscreen` class（CSS 伪全屏），右上角走浏览器 API。两者可分别使用，互不干扰。

### 4. 画面区自适应（不改）

保持现有 CSS。设计文档记录"已验证具备"，避免未来重复实现。

## 文件清单

- `web/index.html`：设置项复选框 + 右上角按钮
- `web/styles.css`：右上角按钮样式 + 伪全屏下的位置适配
- `web/app.js`：方向检测、autoResizeWindow、降级提示、全屏 API 按钮逻辑、i18n 更新
- `shared/keys.mjs`：`autoResizeWindow` 设置 + i18n keys
- `tests/shared-keys.test.mjs`：设置校验 + i18n parity
- `README.md`：说明窗口自适应的限制与全屏按钮用法

## 风险与缓解

- 普通标签页 resizeTo 无效 → 降级提示 + 画面 CSS 自适应兜底，不影响投屏。
- resizeTo 尺寸超出屏幕 → clamp 到 screen.availWidth/Height。
- 横竖屏频繁切换导致窗口反复调整 → 只在方向真正变化时调，且用标志位防抖。
- 浏览器全屏 API 被拒绝 → 点击按钮本身即手势，正常可用；catch 错误并回显。

## 验收

- 普通标签页：连上流后窗口不变；横竖屏切换时状态栏出现一次提示；画面始终填满窗口。
- app 模式（如可用）：横竖屏切换时窗口按屏幕高度自适应调整。
- 设置开关关闭后，横竖屏切换不再尝试调整、也不提示。
- 右上角按钮点后进入浏览器全屏（地址栏消失），再点退出；与左上角按钮互不干扰。
- `npm test` 全绿。
