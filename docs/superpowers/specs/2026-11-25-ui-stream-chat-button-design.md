# 投屏最小宽度与聊天并排按钮状态

## 意图

统一投屏区域的最小宽度为 400px，并让聊天标题栏的“并排”按钮清楚表达当前模式：浮动且可用时为白色，并排时为绿色，禁用时保持灰色。

## 目标 / 非目标

- 目标：普通布局和并排布局的 `#stream` 最小宽度均为 400px；并排分隔条允许把流画面拖到 400px；按钮颜色与可用/并排状态一致。
- 非目标：不改变聊天浮窗位置、分隔条保存逻辑、手机流分辨率或引擎布局；不新增设置项。

## 约束

- 继续使用现有 CSS 变量、主题色和 `body.chat-docked` 状态类。
- 绿色沿用现有聊天在线色 `#10b981`，白色使用 `#fff`。
- 禁用态沿用现有 `opacity: 0.4` 与灰色。
- `MIN_DOCK_STREAM` 与 CSS 最小值保持一致，避免 JS 拖拽结果被 CSS 悄悄抬到 450px。

## 方案

采用 CSS + shared constant 的统一修改：

- `web/styles.css`：基础 `#stream` 增加 `min-width: 400px`；并排态 `body.chat-docked #stream` 的 `min-width` 改为 `400px`。
- `web/styles.css`：`.chat-head-actions button svg` 增加 `fill: currentColor`；`#chat-dock:not(:disabled)` 为白色；`body.chat-docked #chat-dock` 为绿色。
- `web/index.html`：并排按钮初始 `aria-pressed="false"`。
- `web/app.js`：`setChatDockButton()` 同步 `aria-pressed`。
- `shared/keys.mjs`：`MIN_DOCK_STREAM` 从 450 改为 400。
- `tests/shared-keys.test.mjs`：更新下限断言，并覆盖 400px 边界。

考虑过但未采用：

- 只改 CSS：并排拖拽仍受 JS 450px 下限限制，不满足需求。
- 只在 JS 设置 inline `minWidth`：布局状态分散，难维护，也不符合现有 CSS 模式。

## 验证

- `npm test` 全绿。
- 真实浏览器检查普通与并排布局的 computed `min-width` 均为 400px。
- 分隔条可拖到 400px，聊天侧仍保留 240px。
- 按钮在浮动态可用时为白色、并排态为绿色、禁用态为灰色，`aria-pressed` 与状态一致。
