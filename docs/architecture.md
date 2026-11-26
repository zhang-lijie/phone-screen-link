# Phone Screen Link 架构解析：把整台安卓手机投进浏览器，再让大模型替你操作

> 项目地址：<https://github.com/zhang-lijie/phone-screen-link>
> 本文基于 `master` 分支 `7206e7b` 的代码与 README / 需求文档整理。

## 引子：它解决的是什么问题

Phone Screen Link 做的事可以一句话概括：**在本机浏览器里实时看到一台安卓手机的整块屏幕，反向操作它，并且允许用一句自然语言让大模型通过白名单工具操作它。**

它有三个很具体的边界，理解这些边界才能理解架构为什么长成现在这样：

- **不自研投屏协议栈**。视频、音频、触摸、滚轮、剪贴板全部来自成熟的开源引擎 `ws-scrcpy-web` v0.5.13；本项目只做启动编排、页面封装、控制桥和聊天编排。
- **只在本机回环地址运行**：页面 `http://127.0.0.1:8000`，控制桥 `http://127.0.0.1:8100`。不 root、不在手机装 App、不绕锁屏、不采集 `FLAG_SECURE` / DRM 内容。
- **聊天只是加法**。模型不接触设备权限，只输出"工具名 + 参数"；真正操作手机的是 ghost-in-the-droid 的 MCP 工具，且必须先过后端白名单。ghost 起不来、模型超时，最坏结果只是聊天气泡报错，投屏和按键照常。

因此整个系统看起来像一条"窄腰"：**上面是浏览器页面，下面是手机，中间只有两个本地端口**，所有跨进程、跨语言的交互都被压到这两个 HTTP/WebSocket 接口上。

---

## 一、总览：四个世界，两层共享代码

```
浏览器 (127.0.0.1:8000)
├── web/index.html + app.js + styles.css   自定义页面：设置 / 无线双模式 / 聊天 / 状态栏 / 工具栏包装
├── engine/                                 ws-scrcpy-web v0.5.13（setup 拉取，不入库）
│   ├── HTTP :8000  + WebSocket            页面、视频/音频流、触摸/滚轮/剪贴板控制通道
│   └── scrcpy-server                      由引擎在手机上拉起的投屏端
└── control bridge (127.0.0.1:8100)         自研 Node HTTP 服务
    ├── /health, /keyevent                  设备状态与六个系统按键
    ├── /api/wireless*                      配对 / 传统 tcpip / 切回 USB / USB 辅助发现
    ├── /chat, /api/chat-command            聊天与预设命令入口
    └── /api/chat-config                    聊天配置（API Key 只写不回）

shared/                                     浏览器与 Node 共用
├── keys.mjs        按键码、设置校验、分辨率阶梯、中英文语言包、localStorage 辅助、请求 guard
├── chat-tools.mjs  工具白名单 / 拒绝清单 / 发给模型的 tool 定义与参数校验
└── chat-commands.mjs  预设斜杠命令（不走模型，直接调工具）

server/（Node 侧）
├── start.mjs / stop.mjs   启动编排与停止
├── setup.mjs              引擎克隆、打补丁、构建
├── adb.mjs                ADB 包装：动态序列号、pair/connect/tcpip、状态探测
├── connection-config.mjs  state/connection.json 持久化与环境变量解析
├── connection-service.mjs 连接切换的串行事务、失败原子性、后台监督
├── bridge.mjs             控制桥路由与安全校验
├── chat-agent.mjs         agent 循环：锁屏门禁、模型调用、白名单执行、结果回灌
├── model-client.mjs       OpenAI 兼容 /v1/chat/completions 客户端
├── ghost-client.mjs       ghost 的 stdio MCP client
└── chat-config.mjs        state/chat.json 读写（Key 不出后端）
```

职责切分很干净：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 引擎 | 视频解码、控制协议、WebCodecs | 项目自己的 UI 与安全策略 |
| 页面 | 交互、设置、分辨率策略、语言、聊天/无线面板 | 设备权限、模型调用 |
| 控制桥 | 写操作的唯一入口、CORS/Origin 校验 | 视频流 |
| agent 循环 | 锁屏门禁、白名单、工具调用编排 | 设备直连（交给 ghost） |
| ghost | 把操作翻译成 adb 动作 | 模型调用、权限判断 |

`shared/` 是刻意设计的"跨端单一事实来源"：按键码、语言包、设置校验、工具白名单同时被浏览器和 Node 使用，避免两边漂移。因为引擎的静态服务器没有 `.mjs` 的 MIME 类型且设置了 `nosniff`，启动时 `copyWeb()` 会把 `shared/*.mjs` 复制成 `keys.js` / `chat-commands.js` 再交给引擎的静态服务（`scripts/start.mjs:51-61`）。

---

## 二、从安装到运行：三条启动路径

### 2.1 一键安装：自举 → 向导 → 启动

`install.sh` 是一段 POSIX `sh`，只做三件事：判断平台（Linux x64 或 macOS arm64；明确拒绝 Intel Mac 与 Windows）、从 GitHub Release 下载 `phone-screen-link-<ver>.tar.gz` 到临时目录、把内容复制到固定目录 `~/.local/share/phone-screen-link` 并执行 `python3 installer/server.py`。重复运行只启动向导，不覆盖已有配置。

`installer/server.py` 是一个**纯标准库**的本地 HTTP 向导，绑定 `127.0.0.1` 上的**随机端口**，四步流程：环境检测 → `npm install` + `npm run setup` → 可选聊天配置 → 启动应用并打开浏览器。它的安全模型和主桥如出一辙，甚至更严格：

- `Host` 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，带 `Origin` 时必须是精确白名单——防 DNS rebinding 和跨站伪造。
- 一次性会话 token 放在 **URL fragment**（`#token=…`），前端用 `X-Token` 头回传；**绝不接受 query string**，避免 token 进日志和历史记录。
- 请求日志不记录 body（配置写包含 API Key）；响应 `Cache-Control: no-store`；API Key 只写 `state/chat.json`（0600），接口只回 `hasApiKey`。
- 配置合并按默认值逐字段做类型校验，`maxSteps` 收敛到 1–100，临时文件 + `os.replace()` 原子落盘。

### 2.2 setup：把第三方引擎"钉死"并打补丁

`scripts/setup.mjs` 把 `ws-scrcpy-web` 的仓库地址和 tag 写死（`ENGINE_REPO` / `ENGINE_TAG = v0.5.13`），流程是：`git clone --depth 1 --branch <tag>` → `npm install` → 应用补丁 → `npm run stage-seed` → `npm run build`。`engine/dist/index.js` 已存在时直接跳过，保证幂等。

补丁全部是源码字符串替换（`from → to`），并由 `applyPatch()` 检测：如果目标已经包含 `to` 就跳过；连 `from` 锚点都找不到就抛 `upstream drifted`，**宁可失败也不静默漏补丁**。其中几类尤其关键：

- `LOOPBACK_PATCH`：把引擎 `server.listen(port, …)` 改成 `server.listen(port, '127.0.0.1', …)`——整个项目的安全前提。
- `AUDIO_WORKLET_FALLBACK_PATCHES`：AudioWorklet 加载超时（1500ms）或失败时回退 `ScriptProcessorNode`，并修掉 `stop()` 竞态和未处理 rejection。这是用补丁方式修上游，而不是 fork 一份引擎。
- `WHEEL_SCALE`、`KEYBOARD_FOCUS` / `UHID_KEYBOARD_FOCUS`：滚轮倍率、输入框获得焦点时不把按键转发给手机。
- 一组 darwin 补丁：为 Node / adb / node-pty 增加 darwin-arm64 下载映射，支撑 Apple Silicon（Intel Mac 因上游缺 node-pty 预编译仍不支持）。

`checkGhostToolchain()` 对 `uvx`/`uv` 缺失只打印提示、不阻断构建——这体现了项目的核心容错哲学：**可选能力缺失只降级对应功能，不拖垮主链路**。

### 2.3 start：进程编排与"先连接后启动"

`scripts/start.mjs` 是整个运行时的装配中心，几个顺序值得注意：

1. **连接模式在所有进程启动之前解析**（`resolveInitialConnection`）：环境变量 `PHONE_SERIAL`（`host:port` 视为无线）> `PHONE_USB_SERIAL` > `state/connection.json` > 默认 USB。解析结果立刻 `adb.setConnection()`，这样后续桥、锁屏检测、ghost 都从一开始就指向正确设备。
2. **缺 adb 不致命**：首次安装时引擎会在后台下载自带 adb，`isMissingAdbError()` 只打印 `ADB_MISSING_HINT`，由每 5 秒的监督任务重试。
3. 复制 web 资源 → 启动引擎子进程 → 以 25 秒超时启动 ghost MCP → 装配 `chat` 对象 → 启动控制桥 → 最多 30 秒等待引擎就绪。
4. 就绪后挂上 5 秒一次的 `supervise()` 定时器；USB 模式做唯一性检查，无线模式只检查/重连保存的地址。
5. `cleanup()` 是可重入、串行化的：桥 → ghost → 引擎子进程依次释放，`SIGINT`/`SIGTERM`、失败路径和 `finally` 都调用它，且被超时包裹，保证"卡住的 ghost 不能卡住退出"。

对应的 `scripts/stop.mjs` 通过 `ps` + 进程 cwd 精确匹配**本项目**的 `scripts/start.mjs` 与 `node dist/index.js`，先 `SIGTERM`、最多等 5 秒，再对幸存者 `SIGKILL`；不会误杀其他 checkout。

---

## 三、页面层：在别人的引擎上做"外壳"

引擎提供 HTTP/WebSocket 和一套自带工具栏，`web/app.js`（1930 行）的任务是把这些能力包装成产品。它自己不建 WebSocket：只调用 `window.WsScrcpy.startStream()` 拿到句柄，四个回调 `onConnect / onDisconnect / onError / onResize` 全部由引擎驱动；每条回调第一行都用 `generation` 计数过滤过期事件，这样"切换设备/重启流"过程中的旧回调不会污染新流。

在这个底座上叠了这些界面能力：

- **工具栏与状态栏**：引擎自己是运行时创建工具栏 DOM 的，页面用 `MutationObserver` 持续给按钮补文字标签、调顺序（`swapStatsAndDpad`），并注入齿轮与无线按钮。六个系统按键走 `POST /keyevent`，状态栏则每 3 秒轮询引擎的 screen-state，把锁屏/休眠提示前置显示。动态文案统一存为"i18n key + 变量"，语言切换时重新渲染而不是固化英文串。
- **设置面板**：分辨率、帧率、码率、音频、浏览器播放音量、语言、界面字体、统计字体、导航条/状态条倍数等，存 `localStorage`，改动立即生效并自动重启画面流。分辨率策略（`1280 → 1080 → 720` 阶梯与降级检测）集中在 `shared/keys.mjs`，由页面驱动引擎：协商尺寸被大幅降级时用 `generation` + `stop()` + 延时重启自动降档。
- **多语言**：`translate(lang, key)` + `MESSAGES` 语言包覆盖按钮、状态、tooltip。引擎画在 canvas 上的画质统计文字没有 DOM 可改，页面就用 `WeakSet` 只包装一次 `ctx.fillText`，闭包按绘制时的语言取词——换语言无需重新 patch 引擎；引擎自身 DOM 的 tooltip 则用 `WeakMap` 保存原文，避免反复翻译把原文覆盖掉。
- **画面外观与双全屏**：圆角矩形 + 2px 白色描边 + 上下 2px 间隔。"伪全屏"是 CSS 铺满视口并隐藏工具栏（`Esc` 退出）；另有一个调用 Fullscreen API 的"浏览器全屏"，让聊天面板在浮动/并排模式下都可见。横竖屏变化时按可用宽高的 90% 与编码宽高比推算窗口尺寸，并在 `resizeTo` 被浏览器忽略时只提示一次。
- **聊天面板**：右下角圆形按钮（仅在后端 `enabled` 时渲染），气泡 + `工具 ✓/✗` 步骤标签，浮动态可拖动、标题栏开关可切到并排模式，分隔条可拖动（画面最小 400px、聊天最小 240px），位置与比例都持久化到 `localStorage`。窗口变窄会自动退出并排；打开面板时还会临时关闭引擎的键盘/UHID 输入模式，避免打字被转发给手机。所有用户文本与工具输出都用 `textContent` 写入，只有硬编码 SVG 用 `innerHTML`。
- **无线面板**：顶部选择"Android 11+ 配对码"或"传统 5555（无需配对码）"，隐藏的表单输入会被显式禁用（`hidden` 不移除 `required` 校验，否则隐藏字段会阻塞另一模式的提交）。USB 自动获取最多等 8 秒读 Wi-Fi IP / TLS 端口 / mDNS 配对端口；请求期间模式选择器、提交、USB 与清除按钮一并锁定，`try/finally` 保证任何结果都复位。

这里有一个被专门修过的安全细节：**传统模式的安全警告以后端返回的 `method` 为准，而不是浏览器 `localStorage` 里的选项**。浏览器存储只是"回填表单的便利"，不是连接状态的真相源。即使两个浏览器配置不一致、或用户清空存储后后端仍在传统模式，警告也一定显示；后端首次报告 legacy 时会单向把选择器纠正到 legacy，但 pair 状态不会反向覆盖用户选择；同时传统模式下会隐藏"配对码已明文保存"的提示。

音频是另一个"页面 — 引擎"分工的例子：`app.js` 只把设置的音量换算成 0–1 调 `setAudioVolume()`；真正的播放器在 setup 阶段被打了可重放补丁——AudioWorklet 加载 1500ms 超时或失败时退回 `ScriptProcessorNode`，队列有上限，`stop()` 竞态与未处理 rejection 都被吸收。这样没有系统 adb、没有 worklet 的机器上，投屏和声音仍能工作。

---

## 四、控制桥：所有写操作的单一入口

`server/bridge.mjs` 是一个约 490 行的原生 `node:http` 服务，接口面很小：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | `{ ok, online, serial, mode }` |
| POST | `/keyevent` | 六个系统按键 → `adb input keyevent` |
| GET | `/api/wireless` | `{ mode, method, serial, online, usbOnline }` |
| POST | `/api/wireless/auto` | USB 辅助只读发现：Wi-Fi IP、TLS 端口、mDNS 配对端口 |
| POST | `/api/wireless/pair` | `adb pair` → `adb connect` → 在线确认 → 持久化 |
| POST | `/api/wireless/legacy` | 可选 `adb tcpip` → `adb connect` → 在线确认 → 持久化 |
| POST | `/api/wireless/usb` | 切回 USB |
| POST | `/chat` / `/api/chat-command` | 模型 agent / 预设命令 |
| GET/POST | `/api/chat-config` | 聊天配置（Key 不回传） |

安全设计集中在几个点：

- **只绑 `127.0.0.1`**，CORS 只允许 `http://127.0.0.1:8000` 与 `http://localhost:8000`。
- **所有 POST 强制校验 Origin**。CORS 只拦"读响应"，恶意网页仍可用 `text/plain` 发免预检的简单请求改配置、驱动手机；所以带 Origin 且不在白名单的 POST 一律 403，body 根本不读。不带 Origin 的 curl 等非浏览器客户端不受影响。
- **64KB body 上限**、JSON 解析错误 400、配对码 6 位数字、端口 1–65535、错误响应里把配对码替换成 `[redacted]`。
- `/chat` **只读 `message` 和 `lang`**：请求体里的开关、模型、Key 一律忽略，配置从后端 store 读一次并直接交给 agent，避免 TOCTOU 竞态。

视频/音频/触摸走引擎的 WebSocket，按键/连接/聊天走控制桥——两条通道互不依赖，这是"聊天坏了不影响投屏"的物理保证。

---

## 五、连接层：USB 与两种无线模式

### 5.1 状态模型

`state/connection.json` 只有三个字段：`mode`（usb/wifi）、`method`（pair/legacy）、`address`。读取时做归一化（非法值回退默认 usb；USB 模式清空地址），写入时临时文件 + `rename` 原子替换，权限 `0600`。配对码不写盘、不进日志。

`server/adb.mjs` 维护一组可变状态：活动 `serial`、`mode`、`method` 和"上次选中的 USB serial"。这样投屏重启、按键、锁屏检测、ghost 都跟随当前设备序列；ghost 还会在每次聊天开始时**捕获一次** serial，让同一轮里的锁屏检查和所有工具调用指向同一台设备，哪怕中途发生 USB↔无线切换。

### 5.2 两种模式，一条事务队列

`connection-service.mjs` 把 `pairAndConnect`、`connectLegacy`、`switchToUsb` 全部塞进 `serializeMutation()` 串行队列，遵循同一套事务语义：

1. **先证明目标在线**（`adb get-state` 返回 `device`），再 `store.save()` 写盘；
2. **磁盘是提交记录**：`save()` 成功后才 `adb.setConnection()` 切换活动设备；失败则运行时和磁盘都不变；
3. 并发切换请求排队，不会交错。

`connectLegacy` 有一个用户主动触发的开关 `enableTcpip`：为 `true` 时先用**目标 USB serial 的 `get-state`** 确认 USB 在线（离线直接 409，不做任何网络变更），再执行 `adb tcpip <port>`；为 `false` 时只 `adb connect`。传统模式有明确的"未加密、无认证、仅限可信局域网"警告，且警告以后端 `method` 渲染。

### 5.3 后台监督：无线时不碰 USB

每 5 秒的 `supervise()` 是连接层的另一个关键设计：

- USB 模式：沿用既有的 `ensureUsbOnly()`（枚举并断开 Wi-Fi ADB）。
- 无线模式：**不调用 `adb devices`**，只对保存的无线地址做 `get-state`；离线时重连该地址。
- 传统模式若需要重启 adbd（如手机重启导致 TCP 监听消失），用 `legacyBootstrapKey = [address, usbSerial, port]` 做一次性引导，并通过 `250/500/1000/1000 ms` 的有界退避等待 EMUI 的 adbd 重启；一次引导键防止重叠 tick 反复 `tcpip`；连续失败按地址节流告警，避免每 5 秒刷日志。

`discoverWirelessConfig()` 是只读发现，刻意放在事务队列外：用 `AbortSignal` + 8 秒硬超时轮询 mDNS，缺项返回 `null` 与稳定警告码（`WIFI_IP_UNAVAILABLE` 等）由前端做双语映射；部分成功也保留已发现的 IP/端口。

---

## 六、Chat Agent：模型只"出主意"，ghost 来"动手"

这是项目里最像"真正 AI Agent"的一层，流水线如下：

```
用户一句话
  → POST /chat（后端读配置、检查 enabled）
  → agent 循环：锁屏门禁（fail closed）
      → ghost tools/list → 白名单过滤 15 个工具 → OpenAI 兼容模型 tool calling
      → 名单外/参数非法：拒绝并回显可读错误
      → 合法：ghost.callTool(name, args, 固定的本轮 serial) → adb → 手机
      → 截图以 vision image_url 回灌给模型
  → 气泡回复 + 工具 ✓/✗ 步骤标签
```

几个刻意做出的安全取舍：

- **ghost 只是工具层**：通过 `uvx --from ghost-in-the-droid android-agent-mcp` 以 stdio MCP 子进程启动，用 `DEFAULT_DEVICE` 选中设备；`listTools()` 从 MCP 拉真实 schema，`callTool()` 强制注入/覆盖 `device` 字段，让模型无法把操作指向别的设备。
- **白名单是后端权威**：`dump_ui`、`tap`、`swipe`、`type_text`、`launch_app`、`screenshot` 等 15 个工具；显式拒绝 `shell`、`install`、`uninstall`、`push`、`pull`、`clipboard_get`、`unlock_device`。参数只做必需字段与基本类型浅校验——ghost 包版本不固定，不尝试完整 JSON Schema 校验。
- **锁屏真相源在后端**：每次请求用 ADB 的 `dumpsys power` / `dumpsys trust` 判断，读不到就按锁定处理（fail closed），锁定时模型和动作工具都不调用。前端 3 秒轮询只用于界面显示。
- **隔离与限界**：模型调用 60 秒超时（AbortSignal + Promise.race 双保险），单次最多 `maxSteps` 轮；`screenshot` 默认开启，会把屏幕文字和截图发给用户自填的模型地址，界面和 README 都明确提示；API Key 只出现在请求头，接口只回 `hasApiKey`。
- **不假装有多轮上下文**：每轮 `/chat` 无状态，只拼 `[system, 当前句]`；气泡仅供阅读。预设斜杠命令（如 `/desktop`）直接调工具，不经过模型。

---

## 七、状态与配置：谁是真相源

| 数据 | 位置 | 真相源 | 说明 |
| --- | --- | --- | --- |
| 活动连接模式 / 地址 / 方法 | `state/connection.json`（0600） | 后端 | `mode` / `method` / `address`，重启恢复无线与原模式 |
| 聊天配置（含 Key） | `state/chat.json`（0600） | 后端 | Key 只写不回，空串表示保留原值 |
| 向导设备序列号 | `state/installer.json` | 后端 | 生成 `start.sh` 时注入 `PHONE_SERIAL` |
| 界面设置 / 聊天面板位置 / 并排比例 | `localStorage` | 浏览器 | 纯 UI 偏好 |
| 配对表单 / 配对码 / 传统模式地址 | `localStorage`（`phone-link-wireless-pairing`） | 浏览器（仅回填） | 明文保存，面板有明确提示与清除按钮 |

这套划分回答了一个容易踩坑的问题：**刷新后表单里的 IP 和后端正在用的地址可能不同**。项目明确以后端为连接真相源、浏览器为回填便利；安全警告也以后端为准。明文保存配对码是用户明确要求的取舍，代价是共享电脑上 risks 由用户自行管理，界面用加粗提示和"清除"按钮补偿。

---

## 八、安全边界与隐私

把各处的安全措施串起来看，形成了一条完整的防线：

1. **网络层**：引擎和桥都只绑回环；向导随机端口 + Host/Origin 双白名单 + fragment token。
2. **应用层**：所有写路由强制 Origin 校验；body 限长；错误脱敏；配置原子写 + 0600。
3. **设备层**：不 root、不装 App、不绕锁屏；无线模式不枚举 USB；锁屏 fail closed。
4. **模型层**：工具白名单 + 参数校验 + 设备 serial 注入 + 60 秒超时 + 最大步数；API Key 只进不出。
5. **界面层**：传统模式未加密/无认证/仅可信局域网警告以后端 `method` 为准；配对码明文保存有明确提示与清除入口。

隐私上最该被用户知道的是：**截图默认开启并会发往用户自己填的模型地址**。这被写在 README 和界面文案里；关闭开关或把模型地址限制在可信局域网即可避免外发。

---

## 九、工程实践：可注入依赖、TDD 与分层验证

项目把几乎所有外部依赖都做成可注入：ADB runner、fetch、spawn、计时器、MCP Client/Transport、存储读写、日志、信号处理器等。因此：

- `npm test` 的 **400 个 Node 用例**不碰真机、不起 ghost、不发真实模型请求，覆盖 ADB 动态序列号与竞态、无线事务失败原子性、桥路由与安全门禁、agent 循环、i18n 完整性、UI harness 等。
- `installer_test.py` 的 **22 个 Python 用例**覆盖向导 token、环境检测、配置合并、发布包内容。
- 行为改动走 RED→GREEN：例如最后fix波中"安全警告以后端 method 渲染"先写了 3 个失败的前端用例再实现；无线 settle 修复同时有 ADB 层和 service 层的回归测试。

验证的诚实边界也写得很清楚：ghost 的真实返回结构和模型 tool calling 驱动手机的完整真机冒烟**尚未执行**，不能当成已通过；已有的真机证据是传统 5555 模式手动连接成功、页面显示 `已连接 — 522x1080` 且安全警告可见。

---

## 十、设计取舍与遗留

**做对了什么**

- 复用成熟引擎并用**最小补丁**改写安全边界，而不是 fork 一套投屏协议栈；上游升级只需改 `ENGINE_TAG`。
- 把"浏览器里存的选项"和"后端正在用的连接"分开，安全警告只信后者——一个看似小、实则保护核心安全承诺的决定。
- 连接切换串行化、失败原子化、磁盘为提交记录；后台监督用一次引导键 + 有界退避处理设备重启时序。
- 可选能力（adb、ghost、模型、系统包）缺失只降级功能，不阻塞主流程。

**明确保留的代价 / 后续方向**

- `master` 上直接开发、无 worktree 隔离；引擎与状态目录不入库。
- 聊天每轮无状态、无流式输出、历史不跨刷新；API Key 无法从面板清除（空串语义是"保持原值"）。
- 远程访问未实现；WebCodecs 在普通 HTTP 下需要回环安全上下文，若要 LAN 访问需自行加 HTTPS 并放宽绑定/CORS。
- 参数校验是浅校验；ghost 版本由 `uvx` 运行时解析，上游改名会影响聊天。
- Intel Mac 不支持；macOS arm64 支持尚无实机验证结果。

整体来看，Phone Screen Link 的架构价值不在某个算法，而在**边界感**：把第三方大块能力关在各自的进程里，用两个本地端口串起来，凡涉及设备权限、模型输出和安全提示的决定都收拢到后端，并让"降级"成为默认容错策略。这让一个由多个开源组件拼起来的系统，仍然能被 400 多个注入式单元测试稳稳锁住。
