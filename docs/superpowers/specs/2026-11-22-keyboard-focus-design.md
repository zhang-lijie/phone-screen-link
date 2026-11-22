# 键盘焦点自动切换（聊天输入框占用键盘）

## 意图

聊天面板打开后，用户在输入框打字时，按键目前仍被引擎转发到手机（并被 `preventDefault()` 吞掉），导致"打不了字"或"手机跟着输入"。需要让键盘宿主随焦点自动切换：焦点在输入框时归输入框，焦点回到投屏画面时归手机。

## 目标 / 非目标

- 目标：任意文本输入控件（聊天输入框、设置面板输入框等）获得焦点时，按键只由浏览器处理，不控制手机；焦点离开后自动恢复反控。
- 非目标：不做面板级的显式开关（不维护"聊天开/关"状态），不新增前端/后端接口，不改聊天协议。

## 方案

采用引擎补丁（方案 1）。在 `KeyInputHandler.handler` 开头判断事件目标：若 `event.target` 是 `INPUT`/`TEXTAREA`/`SELECT` 或 `isContentEditable`，直接 `return`——既不转发按键，也不调用 `preventDefault()`。

选它的理由：焦点天然就是"宿主"，无需显式状态；一次覆盖所有输入控件；复用项目已有的 `setup.mjs` 引擎补丁机制，与 loopback / 音量 / 滚轮补丁同一套路子。

否决的方案：
- 页面层 `stopPropagation`：只对聊天框有效，设置面板输入仍会控制手机。
- 显式 `setHandleKeyboardEvents(false)`：需把引擎 API 暴露给页面，且面板打开但焦点不在输入框时也会失去反控。

## 实现要点

- `scripts/setup.mjs` 新增 `KEYBOARD_FOCUS_PATCH`，锚定 `KeyInputHandler.ts` 的 `handler` 起始处，加入输入法/文本控件判断。
- `applyEnginePatches()` 中应用该补丁。
- 对现有已构建的 `engine/`（软链到主仓库）手动应用补丁并重新 `npm run build`，使 `dist` 生效。
- 不改 `web/app.js`：聊天面板打开已有 `chatInput.focus()`，焦点切换即可。

## 约束 / 风险

- 引擎是外部依赖、gitignored，源码补丁由 `setup.mjs` 可复现；上游漂移会导致补丁锚点失配（现有补丁同样有此风险）。
- `KeyInputHandler` 在 `document.body` 监听，`event.target` 即实际聚焦元素，判断可靠。
- 需保留 `event.repeat` / 修饰键等原有逻辑不变。

## 验证

- `npm test` 全绿（补丁本身的测试沿用 setup 的锚点检查）。
- 浏览器实测：打开聊天面板后输入框能正常打字、手机无响应；关闭面板/点击画面后，键盘按键正常控制手机（如 Back/Home）。
