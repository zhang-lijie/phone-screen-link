# 手机屏幕联动 Web 应用 — 设计文档

日期：2026-11-22

## 1. 意图与原因

用户想要一个 Web 应用，把当前连接的华为 Mate 40 Pro 的**整个屏幕**实时显示在浏览器里，并且网页与手机之间双向「联动」：网页上的点击/滑动/键盘作用到真机，真机画面与状态回传到网页。

手机已通过 ADB 连接（USB `2FD0221C09004177` 与 Wi‑Fi `192.168.3.123:5555` 同时在线），无 root。用户明确选择**复用成熟的开源项目做二次开发**，而不是从零实现投屏协议栈。

一次性 spike 已验证该路线可行：设备发现、H.264 投屏解码、网页反控手机（Home 键）三项均通过。

## 2. 目标 / 非目标 / 反目标

### 目标
1. 浏览器实时显示手机整屏，目标 30 fps、端到端延迟 < 150 ms。
2. 双向联动：触摸、滚动、键盘从网页注入手机；手机画面与亮屏/锁屏状态回传网页。
3. 以 ws-scrcpy-web 为引擎，使用其公开 `startStream()` API，不 fork 整个应用。
4. 自建 Web 应用外壳（布局、主题、控制条、状态面板），引擎作为底座。
5. 双 ADB 通道下设备选择确定、可重现。
6. 第一版本机安全部署（`http://127.0.0.1`），控制面不裸露到局域网；架构上预留远程访问扩展（TLS/认证作为可插拔层），但本期不实现。

### 非目标
- 华为原生协议（HiCar / Cast+ / 多屏协同）接入——已查证为车企/电视厂商封闭生态，浏览器无法作为接收端。
- root、绕过锁屏、采集 FLAG_SECURE/DRM 内容。
- iOS 设备支持。
- 多设备群控、账号体系、互联网中继（后续可另立项目）。
- 重新实现 scrcpy 协议。

### 反目标（技术上成功也算失败的情况）
- 只是定时截图刷新，不是实时视频流。
- 需要在手机上安装额外App并授予「远程协助/无障碍」等特殊权限。
- ADB 重连或服务重启后联动失效、需要人工反复干预。
- 默认把设备控制接口开放在局域网且无认证。

## 3. 约束

- **设备**：HUAWEI NOH-AN01，HarmonyOS 4.2 / Android 12（API 31），Kirin 9000，8 核，ADB shell `uid=2000`，无 `su`。
- **双通道**：USB + Wi‑Fi 同时在线；ws-scrcpy-web 对同一设备只选一条通道，spike 中优先 Wi‑Fi，断开 Wi‑Fi ADB 后自动切 USB。
- **浏览器**：WebCodecs 只在安全上下文可用——必须 `http://127.0.0.1` / `http://localhost` 或 HTTPS。
- **锁屏**：Android 不允许采集 keyguard，锁屏时画面为黑；需先唤醒并解锁。
- **主机**：Node v26.13.1（项目要求 >=24，首次启动会自行下载 Node 24 自举包）；`npm install` 约 10 分钟；`velopack` 对 Node 26 有引擎警告，spike 中未造成故障。
- **许可证**：ws-scrcpy-web 为 GPL-3.0-only；二次开发产物若分发需遵守 copyleft。本项目为本地自用，接受该约束（设计者决定）。
- **设备负载**：spike 时 load average ≈ 45，帧率上限设为 30 以避免进一步加重负担（设计者决定）。
- **现场状态**：spike 期间临时改过 `screen_off_timeout` 并已恢复为 30000；Wi‑Fi ADB 已重连。

## 4. 方案取舍（Approaches）

| 方案 | 做法 | 优点 | 代价 | 结论 |
|---|---|---|---|---|
| A 自研 MJPEG-over-WebSocket | `screencap` → ffmpeg → JPEG → WS；输入走 `adb input` | 零额外原生依赖，代码量小 | 3–10 fps、延迟 200–500 ms，手感差 | 放弃，仅适合一次性验证 |
| B 自研 scrcpy + WebRTC | 自己实现 H.264 流转发与输入通道 | 30–60 fps、低延迟，架构最正确 | 工作量大，重复造轮子 | 暂缓；若 C 的许可/性能不满足再升级 |
| C 复用成熟开源项目 | 以现成 Web scrcpy 项目为引擎二次开发 | 最快得到完整能力，保持与上游 scrcpy 同步 | 受上游结构与许可证约束 | **采用** |

C 内部候选：

- NetrisTV/ws-scrcpy：2.6k stars、MIT，但绑死改过的 scrcpy 1.19（2021）、社区反馈停更 → 放弃
- tiann/tango-mirror：新项目、WebRTC、信令走公共 MQTT broker → 太新且安全上多一层顾虑，放弃
- mahdicpy：Python 零依赖但仅个位数 star → 放弃
- **bilbospocketses/ws-scrcpy-web**：活跃（v0.5.13 / 2026-11-04）、原版 scrcpy-server、多编码、WebCodecs、公开 `startStream()` API → **选用**

## 5. 已决定的实现方式

### 5.1 引擎
- 项目：`bilbospocketses/ws-scrcpy-web` v0.5.13，作为独立的自托管服务在本机运行。
- 构建/启动：`npm install` → `npm run start:no-supervisor`（spike 中 `npm start` 的 supervisor 会异常退出，改用 no-supervisor）。
- 引擎保持原样或仅最小补丁；优先通过公开 API 集成，而不是改内部代码。

### 5.2 嵌入方式
- 自建页面放在引擎的 `dist/public/` 下，或由反向代理把 `/ws-scrcpy.umd.js`、`/api/*`、`/ws` 与自建页同源暴露。
- 用 `WsScrcpy.startStream(container, deviceId, options)` 把画面渲染进自建页面的容器：
  - `codec` 不指定，让库按 H.265 → H.264 → AV1 → VP8 → VP9 自动选择
  - `keyboard: true`，`fitToScreen: true`
  - `maxFps: 30`（设计者决定，降低手机负载）
  - `audio: true`（可配置关闭）
  - `onConnect/onDisconnect/onError` 驱动自建状态面板
- `startStream()` 只提供视频面与触摸/键盘输入，**不含** Home/Back/Power 工具栏；自建应用需自己实现控制条。
- 不采用 iframe / `embed.html`：直接调库更可控，也省去 postMessage 主题同步。

### 5.3 设备与通道
- 默认设备 ID 用 USB 序列号 `2FD0221C09004177`；若只有 Wi‑Fi 通道则用 `192.168.3.123:5555`。
- **由应用自动强制 USB**（用户决定）：启动时检测 ADB 设备列表，若 Wi‑Fi 通道 `192.168.3.123:5555` 在线则先执行 `adb disconnect 192.168.3.123:5555`，再启动引擎；ADB 重连后重新检查并再次断开 Wi‑Fi 通道。Wi‑Fi 中途恢复时保持现有 USB 会话，在下次重连周期纠正。
- 引擎自带的 `GET /api/devices/screen-state` 与 `POST /api/devices/sleep-wake` 直接复用；其余 Home/Back/Power 用自建的轻量 ADB 桥（固定 `-s <serial>`）发送 `input keyevent 3/4/26`。

### 5.4 联动能力边界
- 支持：整屏视频、多点触控、滚动、键盘输入、剪贴板（引擎已有）、Home/Back/Power、亮屏/锁屏状态显示。
- 不支持：锁屏画面、DRM/支付等受保护内容、root 级操作、华为原生投屏协议。

### 5.5 安全与部署
- 第一版仅监听 `127.0.0.1`；引擎默认无认证、admin 操作仅限本机，自建应用不开放远程 admin。
- 架构上把「传输/认证」做成可替换层：后续若启用远程访问，在该层加入 TLS 反向代理、主机白名单与登录认证，不改业务代码（用户决定）。
- 自建 ADB 桥只接受本机请求，设备序列号写死在配置中。

### 5.6 Spike 证据（2026-11-22）
- 浏览器识别到 `HUAWEI NOH-AN01`，Device ID 先为 Wi‑Fi `192.168.3.123:5555`，断开 Wi‑Fi 后变为 USB `2FD0221C09004177`。
- 点击 connect 后 canvas 渲染出画面，中心像素采样为 `#bf3320`（非黑），证明 H.264 解码与上屏成功。
- 用 ADB 打开「设置」后，在网页点 Home 键，手机焦点回到 launcher，证明网页 → 手机反控成功。
- 现场已恢复：Wi‑Fi ADB 重连、屏幕超时 30000、spike 服务停止。

## 6. 留给实现者的部分

以下由实现阶段自行决定，不阻塞计划：

- 自建 Web 页的具体视觉设计、布局与主题。
- 轻量 ADB 桥的实现语言与框架（Node/Python 均可），只要固定 `-s` 并限制为本机访问。
- 状态面板展示哪些附加信息（分辨率、编码、码率、连接时长、电量等）。
- 是否把引擎作为系统服务常驻，以及日志与崩溃恢复策略。
- 未来是否升级到方案 B（自研 WebRTC）或引入账号/多设备管理。

## 7. 验收标准

1. 打开自建页面即可看到手机实时画面，无需点击引擎自带的首页。
2. 网页上触摸/键盘/Home/Back 均可操作真机。
3. 手机画面、亮屏/锁屏状态在网页正确反映；锁屏时给出明确提示而不是空白。
4. 只用 USB 通道即可完整工作；ADB 重连后页面能恢复或明确报错。
5. 不改动手机系统设置、不安装额外 App、不需要 root。
6. 应用启动时自动断开 Wi‑Fi ADB 并走 USB；ADB 重连后自动重新纠正。
7. 仅监听 `127.0.0.1`；远程访问层为预留，不在本期验收。
