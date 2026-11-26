# Android 11+ 无线 ADB 应用内配对

## 意图

在右侧工具栏增加独立的“无线调试”入口，让用户在应用内完成 Android 11+ 的 ADB 配对与连接；切换到无线模式后，停止 USB 设备探测和强制断开 Wi‑Fi ADB 的循环。

## 目标 / 非目标

- 目标：应用内输入配对 IP/端口、6 位配对码、连接 IP/端口，完成 `adb pair` → `adb connect`；投屏、按键、锁屏检测和 ghost 聊天都跟随当前活动设备；无线掉线只重连指定地址。
- 非目标：不实现 mDNS 自动发现；不修改 scrcpy 引擎；不改变现有 USB 默认行为；不实现跨设备配对码同步。

## 约束

- 桥接继续只绑定 `127.0.0.1`，沿用现有 CORS/Origin 防护。
- 后端不记录配对码日志、不把配对码写入配置文件。
- 按用户要求，前端把完整配对表单（含配对码）以明文存入浏览器 `localStorage`，键为 `phone-link-wireless-pairing`，并提供清除按钮和明确安全提示。
- 配对失败或连接失败不得切换当前活动设备或保存新的无线地址。
- 无线模式下不得调用 `ensureUsbOnly()` 或通过 `adb devices` 枚举 USB 设备。
- `PHONE_SERIAL=IP:端口` 自动识别为无线模式，兼容现有环境变量。

## 方案

### 入口与界面

在右侧工具栏齿轮按钮旁注入 `.wireless-button`，点击打开独立 `#wireless-overlay` 模态面板：

- 当前模式、当前地址、在线状态。
- 配对 IP、配对端口、6 位配对码。
- 连接 IP、连接端口。
- “配对并连接”和“切回 USB”。
- “清除已保存配对信息”。
- 配对码明文持久化提示。

前端使用 `localStorage` 自动保存/回填表单；配对成功后更新 `DEVICE_ID`、`window.__PHONE_SERIAL` 并重启投屏。

### 后端

- `server/connection-config.mjs`：持久化 `{ mode, address }`，提供启动模式解析。
- `server/adb.mjs`：增加动态活动序列号、模式、`pair`、`connect`、`getState`、`ensureWirelessConnected`。
- `server/connection-service.mjs`：校验输入，执行配对/连接，确认在线后原子切换并保存配置。
- `server/bridge.mjs`：新增 `GET /api/wireless`、`POST /api/wireless/pair`、`POST /api/wireless/usb`；`/health` 返回动态设备与模式。
- `server/ghost-client.mjs`：接受 `getSerial()`，工具调用时动态注入当前设备。

### USB / 无线策略

- USB 模式：保持启动检查和每 5 秒 `ensureUsbOnly()`。
- 无线模式：启动时跳过 USB 检查；周期任务只对指定地址执行状态检查/重连。
- `ensureUsbOnly()` 在列表返回后再次检查模式，避免切换竞态导致迟到 `disconnect`。
- 无线状态检查使用 `adb -s <address> get-state`，不调用 `adb devices`。

## 考虑过但未采用

- 只支持已配对地址：不满足应用内完成 Android 11+ 配对的要求。
- 安装向导内配对：后续换手机/网络不方便。
- 配对面板放进设置页：设置页过长，独立工具栏入口更清晰。
- 后端持久化配对码：无必要且扩大泄露面；仅按用户要求保存在浏览器。

## 验证

- Node 单测覆盖配置、ADB 命令、失败回滚、动态 serial、启动模式、桥接 API、校验与安全。
- 前端源码契约测试覆盖工具栏入口、localStorage、API 调用、成功重连和清除行为。
- Android 11+ 真机验证配对、连接、投屏、触摸、按键、ghost 聊天、拔 USB、浏览器重开、断线重连和切回 USB。
