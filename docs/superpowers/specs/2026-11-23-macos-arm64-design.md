# macOS arm64 安装适配设计

日期：2026-11-23

## 意图

让 Apple Silicon Mac（arm64）用户能用同一套一键安装向导部署本项目。基于只读调研 spike（`/tmp/opencode/macos-spike-findings.md`）：障碍全在引擎把平台写死成 `win32`/`linux` 的发布脚本层，投屏核心（`scrcpy-server` 是 Android APK）与浏览器解码跨平台。

## 目标 / 非目标

- 目标：arm64 Mac 上 `./install.sh` → 向导 → `npm run setup` 成功拉取/构建引擎 → 投屏页可用。
- 非目标：**Intel Mac（darwin-x64）不支持**——上游没有 node-pty 的 darwin-x64 预编译（实测 404），给明确提示而非半途失败；不做 .pkg/.dmg 原生包与签名公证。
- 非目标：不改投屏协议、不改 GPL 边界（引擎仍由 setup 联网拉取、不入库）。

## 约束

- 引擎是外部依赖、gitignored；所有引擎源码改动必须通过 `scripts/setup.mjs` 的补丁可复现（与 loopback/音量/滚轮补丁同一机制）；上游漂移时补丁锚点失配要显式报错。
- 在线探测事实：Node v24.19.0（引擎固定版本）的 `darwin-arm64` 归档存在；Google platform-tools `darwin` 包存在；node-pty 预编译 `abi137/139-darwin-arm64` 存在（ABI 137 覆盖 v24）。
- Linux x64 行为必须完全不变。

## 方案（5 处改动）

1. **`scripts/setup.mjs`** 新增补丁（在 `applyEnginePatches()` 调用）：
   - `FETCH_NODE_DARWIN_PATCH`：`fetch-node.mjs` 的 `platformConfig()` 在 `linux` 分支后增加 `darwin` 分支，返回 `node-v24.19.0-darwin-arm64.tar.xz`、SHA256（从 nodejs.org SHASUMS256 取）、`innerRel = node-v24.19.0-darwin-arm64/bin/node`。仅 arm64；x64 走原有"unsupported"路径。
   - `ADB_DARWIN_PATCH`：`DependencyDefinitions.ts` 的 `adbArchiveName()` 增加 `darwin` 分支（`platform-tools_r<ver>-darwin.zip`）。
   - `PREBUILT_DARWIN_PATCH`：`fetch-prebuilts.mjs` 的 `getHostInfo()` 把 `darwin` 与 `win32` 并列，不再错标为 linux（这样 composePrebuiltKey 生成 `...-darwin-arm64`）。
2. **`install.sh`**：去掉 `uname -s != Linux` 硬拒；允许 `Darwin`，但 `uname -m` 只放行 `arm64`（Intel 明确提示不支持）。
3. **`installer/server.py`**：`detect_environment()` 接受 `darwin` 且 `machine == "arm64"`；`reason` 文案更新；adb 路径展示保持。
4. **`README.md` / release notes**：平台声明从"仅 Linux x64"改为"Linux x64 + macOS arm64（Apple Silicon）"，明确 Intel Mac 不支持。
5. **测试**：`tests/setup.test.mjs` 增加 3 个补丁常量的锚点断言；`tests/installer_test.py` 增加 darwin-arm64 被接受、darwin-x64 被拒的用例。

## 验证

- 本机是 Linux x64、无 Mac 实机：只能验证补丁常量形状/锚点、安装器平台判断（mock platform）、Linux 回归（全量测试绿）。
- **真正的 Mac 实机验证（setup 成功、投屏、音频）无法在本环境执行**，须在 release notes 与交付说明中明确此限制，列为遗留项。

## 风险 / 遗留

- 上游 Node 版本从 v24.19.0 升级时，darwin 补丁的归档名/SHA256 需同步更新（补丁锚点失配会显式报错）。
- node-pty darwin-arm64 预编译由上游提供，上游移除或换 ABI 会影响 shell 功能（投屏不受影响）。
- Safari 音频（WebCodecs/AudioWorklet）未实机验证，作为后续小项。
