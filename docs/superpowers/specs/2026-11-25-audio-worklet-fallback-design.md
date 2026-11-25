# 音频 Worklet 兜底与启动竞态修复

## 意图

首次连接常协商到 `248x512`，被判定为降级后页面立即 `stop()` 并在 1.2 秒后重连。第一次的 `AudioPlayer.start()` 还在 `await audioWorklet.addModule()` 时，`stop()` 关闭了 AudioContext，`addModule` 以 `Unable to load a worklet's module` 中止并被打成 error。真实 Chrome 第二次连接能成功，但 OpenCode 内置浏览器的 `addModule` 会一直挂起，导致完全没声音。

需要消掉首次降级的误报，并在 AudioWorklet 不可用时仍能出声。

## 目标 / 非目标

- 目标：`start()` 在 `stop()` 后静默退出，不产生未捕获 rejection；AudioWorklet 加载失败或超时 1.5 秒时降级到 `ScriptProcessorNode`；opus / aac / flac / raw 四种音频路径都可用；音量、`resume()`、重复 `stop()` 语义不变。
- 非目标：不改传输协议、WebCodecs `AudioDecoder`、页面 UI 或聊天功能；不替换 worklet 的混音算法。

## 方案

采用方案 B：竞态保护 + ScriptProcessor 兜底，全部通过 `scripts/setup.mjs` 的引擎补丁实现。

- 新增 `AUDIO_WORKLET_FALLBACK_PATCHES`，锚定 `engine/src/app/audio/AudioPlayer.ts`；`applyEnginePatches()` 中应用。
- `start()` 捕获当前 `AudioContext`；每次 `await` 后检查 `started` 与 context 引用，已停止则关闭 context 并 `return`。
- `addModule` 用 1500ms `Promise.race`；失败或超时调用 `startScriptProcessor()`。迟到的 `addModule` rejection 用 `.catch(() => {})` 吞掉。
- 新增统一 `enqueue(channels, numFrames)`：worklet 走 `port.postMessage`，兜底走队列；`onaudioprocess` 从队列填充 `outputBuffer`，不足补静音。
- 兜底节点 `createScriptProcessor(2048, 1, 2)`，接同一个 `gainNode`；队列上限 50 块，超出丢最旧，避免延迟累积。
- `stop()` 断开并清空 `scriptNode` 与队列；保留 `workletReady` 字段名，语义改为“输出端已就绪”，减少补丁面积。
- 已构建的 `engine/` 手动应用补丁并 `npm run build`；新安装由 `npm run setup` 自动应用。

否决的方案：

- 只修竞态：内置浏览器仍无声。
- 只加兜底：首次降级仍会白建一个兜底节点并打日志。
- 页面层 monkey-patch：跨 bundle、不可靠，难维护。

## 约束 / 风险

- 引擎是外部依赖，补丁锚点可能随上游漂移；`setup.mjs` 已有“锚点失配即报错”的保护。
- `ScriptProcessorNode` 已废弃，但 Chrome / Electron 仍支持；只作为兜底，不替代 worklet。
- 超时后迟到的 worklet 不再使用；队列丢帧会造成音频卡顿，但优先保证低延迟。
- 兜底节点创建失败时只记录一次可读错误，视频、触摸、按键不受影响。

## 验证

- `npm test` 全绿；`tests/setup.test.mjs` 增加补丁锚点与关键构造（超时、`createScriptProcessor`、竞态检查）断言。
- 真实 Chrome 实测：首次 `248x512 → 522x1080` 降级重连后不再出现音频 error，状态为已连接。
- 模拟 worklet 失败：页面内让 `addModule` 拒绝后重连，出现 fallback 警告、无未捕获错误、`AudioContext` 保持 running。
- 连续停止/重连多次，无未捕获 rejection。
