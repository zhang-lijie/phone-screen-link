# Phone Screen Link

把一台华为 Mate 40 Pro 的**整台屏幕**投到本机浏览器，并在网页上反向控制手机。
视频流和触摸走成熟的开源引擎 [ws-scrcpy-web](https://github.com/bilbospocketses/ws-scrcpy-web)
v0.5.13，Home / Back / 音量 / 电源等按键走一条轻量 ADB 控制桥。
页面右下角另有一个**对话按钮**：用一句自然语言让局域网上的 OpenAI 兼容大模型，
通过开源项目 [Ghost in the Droid](https://github.com/ghost-in-the-droid/android-agent)
的 MCP 工具直接操作手机（点击、输入、启动应用等），现有按钮与投屏完全不受影响。

> **范围**：仅本机 `http://127.0.0.1:8000`；不 root、不在手机安装额外 App、不绕过锁屏、
> 不采集 `FLAG_SECURE` / DRM 内容。远程访问未在本次实现，但架构预留了扩展空间。
> 聊天会把手机屏幕文字（以及默认开启的截图）发给**用户自己配置的**模型地址，见「隐私与边界」。

需求来源、功能/非功能需求、需求追溯、验收结果与遗留项见 [需求分析](docs/requirements-analysis.md)。

## 开源组件声明

本项目的投屏引擎与聊天的设备工具层来自开源项目，在此明确声明：

| 组件 | 版本 | 来源 | 许可证 | 在本项目中的作用 |
| --- | --- | --- | --- | --- |
| [ws-scrcpy-web](https://github.com/bilbospocketses/ws-scrcpy-web) | v0.5.13 | https://github.com/bilbospocketses/ws-scrcpy-web | **GPL-3.0** | HTTP/WebSocket 服务、WebCodecs 解码、投屏画面、触摸/滚轮/剪贴板控制与工具箱 |
| [ghost-in-the-droid](https://pypi.org/project/ghost-in-the-droid/) | 未固定：`uvx` 在运行时解析最新版 | https://github.com/ghost-in-the-droid/android-agent | **MIT** | 聊天 agent 的设备工具层：以 stdio MCP server 暴露手机工具（66 个，本项目只取白名单子集） |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | ^1.32.2 | npm | **MIT** | Node 侧 MCP client（`StdioClientTransport` + `Client`），唯一的运行时 npm 依赖 |

- 引擎代码**不包含在本仓库中**：`npm run setup` 从上述上游仓库克隆到 `engine/`，它独立遵循上游的 GPL-3.0 许可证；本仓库只提交我们自己的封装代码。
- ghost 代码**同样不入库**：`scripts/start.mjs` 用 `uvx --from ghost-in-the-droid android-agent-mcp` 把它作为 stdio 子进程拉起，agent 循环、模型调用与白名单校验全在本仓库的 Node 侧。
- 本项目的改动限于：把 HTTP 服务限制为只监听 `127.0.0.1`（修改 `src/server/services/HttpServer.ts` 的 `server.listen`），以及用自定义的 `index.html` / `app.js` / `styles.css` 替换引擎根页面。投屏协议实现本身没有改动。
- 引擎运行时还依赖上游的 scrcpy-server 等组件，它们的版权与许可证同样属于各自上游项目。
- 致谢：整屏投射与触摸反控能力来自 ws-scrcpy-web 及 scrcpy 社区，聊天所用的手机工具来自 ghost-in-the-droid 社区，本项目只做本机启动编排、控制桥、agent 循环和界面封装。

## 界面预览

**主界面** — 手机「设置」页面投屏，顶部是控制按钮，右侧是窄工具栏：

![主界面：手机设置页面投屏到浏览器](docs/screenshots/01-main.png)

**设置面板** — 点击右侧齿轮打开，可调整分辨率、帧率、码率和音频：

![设置面板](docs/screenshots/02-settings.png)

**手机主屏幕投屏** — 整台手机屏幕实时镜像：

![手机主屏幕投屏](docs/screenshots/03-phone-home.png)

> 聊天面板的实拍截图待补：拍它需要 `uvx` + 局域网 tool-calling 模型 + 真机都到位（见[真机冒烟](#真机冒烟手动尚未在本环境执行)），
> 本机缺的是可用的模型端点，因此不放伪造或占位图。

## 功能

- **全屏镜像**：整台手机画面实时投到浏览器，不是单个 App 的截图。
- **网页反控**：右侧窄工具栏里的 `电源 / 音量+ / 音量− / 返回 / 主页 / 多任务` 六个系统按键；顶部导航栏已隐藏，所有操作集中在右侧。
- **自然交互**：鼠标左键点击和拖拽等价于手指触摸；滚轮上下滚动手机页面；右键映射为手机返回键，浏览器右键菜单已被禁用；手机声音会实时在浏览器播放。
- **屏幕外观**：画面为圆角矩形，带白色描边和上下各 2px 间隔；外侧容器不加边框、圆角或阴影。
- **画面全屏**：画面左上角的图标按钮（悬浮提示「全屏 / 退出全屏」）可让手机画面铺满视口（隐藏工具栏），画面圆角、白色描边和间隔保持不变，按 `Esc` 也可退出。
- **设置面板**：右侧工具栏的齿轮按钮可设置分辨率、帧率、码率、音频、语言、字体与导航条/状态条尺寸，改动立即生效并自动重启画面流。
- **状态联动**：每 3 秒轮询手机锁屏/休眠状态并显示在状态栏，锁屏黑屏时给出明确提示。
- **多语言界面**：中文 / 英文，在设置面板切换，默认跟随浏览器语言，即时生效无需刷新；按钮文字、状态提示、锁屏/剪贴板提示、右侧工具栏的悬浮提示（tooltip），以及引擎直接绘制在画面上的画质统计文字都会一起翻译。
- **分辨率自适应**：自动探测设备编码器能接受的尺寸，画面糊时自动降档，无需手动调参。
- **对话控制手机**（新增）：右下角常驻对话按钮，点开聊天面板，用中英文自然语言让局域网上的 OpenAI 兼容大模型选工具，经白名单校验后由 ghost 执行点击、滑动、输入、启动应用等操作；执行步骤以 `工具 ✓/✗` 标签回显，失败给可读错误，聊天坏了不影响投屏和按钮。详见[聊天控制手机](#聊天控制手机chat-agent)。

## 界面与操作

| 操作 | 方式 | 实现 |
| --- | --- | --- |
| 系统按键 | 右侧工具栏 `电源 / 音量+ / 音量− / 返回 / 主页 / 多任务` | 引擎控制通道 |
| 点击 / 拖拽 / 滑动 | 画面上的鼠标左键 | 引擎触摸层 |
| 屏幕滚动 | 画面上的滚轮 | 引擎 `ScrollControlMessage`（触摸模式下的手指滑动） |
| 返回 | 画面上鼠标右键 | 引擎映射 BACK，浏览器菜单已屏蔽 |
| 截图 / 键盘 / 鼠标 / 统计 / 显示模式 / 刷新 / 剪贴板 | 右侧窄工具栏 | 引擎自带工具，带文字标签 |
| 设置 | 工具栏 `SET` 齿轮 | 自定义面板，见下节 |
| 画面全屏 / 退出 | 画面左上角图标按钮（tooltip），或 `Esc` 退出 | CSS 铺满视口，全屏时隐藏工具栏，保留画面圆角与描边 |
| 打开 / 收起聊天 | 右下角圆形对话按钮（tooltip「聊天助手」），或 `Esc` 收起 | 前端面板；按钮只在后端 `enabled` 为真时出现 |
| 自然语言控制手机 | 聊天面板输入框 + `发送` | `POST /chat` → agent 循环 → ghost MCP → ADB |
| 清空对话 | 聊天面板底部 `清空对话` | 只清前端显示的气泡，后端本就无状态 |
| 聊天配置 | 设置面板「聊天」分组 + `保存聊天设置` | `GET/POST /api/chat-config`，存后端 `state/chat.json` |

右侧工具栏把引擎自带的图标按钮压缩成窄栏并补上文字标签；顶部导航栏已隐藏，系统按键和工具都在同一条栏里，避免重复入口。

### 设置项

| 选项 | 可选项 | 说明 |
| --- | --- | --- |
| 分辨率 | 自动 / 1280 / 1080 / 720 | 「自动」按 `1280 → 1080 → 720` 依次尝试；固定值严格按所选值请求 |
| 帧率 | 15 / 30 / 60 fps | 引擎作为上限使用 |
| 码率 | 2 / 4 / 8 / 16 Mbps | 越高越清晰，占用带宽越大 |
| 音频 | 开 / 关 | 打开后手机声音实时带到浏览器播放（默认开） |
| 浏览器播放音量 | 0% ～ 100% | 控制浏览器里播放手机声音的音量/静音；立即生效、不重启流 |
| 显示语言 | 跟随浏览器 / 中文 / English | 「跟随浏览器」在 `zh` 前缀时用中文，否则用英文；切换后立即生效 |
| 界面字体大小 / 颜色 | 小 / 默认 / 大；任意十六进制颜色 | 同时影响按钮、状态栏、工具栏标签和设置面板 |
| 统计字体大小 / 颜色 | 小 / 默认 / 大；任意十六进制颜色 | 只影响投屏画面上 canvas 绘制的画质统计文字 |
| 导航条最大尺寸 | 0.8× / 1× / 1.25× | 按倍数固定右侧工具栏的宽度、图标和文字；不受「界面字体大小」影响 |
| 状态条最大尺寸 | 0.8× / 1× / 1.25× | 按倍数固定底部状态栏的高度和文字；不受「界面字体大小」影响 |
| 导航按钮显示 | 图标 / 文字 / 图标&文字 | 控制右侧工具栏按钮只显示图标、只显示文字，或两者都显示 |
| 滚轮滚动倍率 | 1× ～ 10×（共 10 档） | 一次鼠标滚轮对应手机屏幕滚动的距离倍率；引擎默认滚动量很小，调大后一次滚轮滚得更远。默认 2×，改后立即生效、无需重启 |

设置面板按功能分为五组：**投屏设置**（分辨率/帧率/码率）、**控制设置**（音频/导航按钮显示/滚轮滚动倍率）、**显示设置**（界面字体/统计字体/导航条/状态条尺寸）、**语言设置**（显示语言）和**聊天设置**。

设置保存在浏览器 `localStorage`，刷新页面后仍然有效；`Reset` 填回默认值，`Esc`、点遮罩或点 `×` 关闭面板。
唯一例外是「聊天」分组：它的值存在 Node 后端，读写都不经过 `localStorage`，`Reset` 也不会清空它，见下一节。

**为什么要做分辨率阶梯**：实测 Mate 40 Pro 屏幕为 1152×2376，但引擎按视口反推请求尺寸时，设备编码器会拒绝请求并抛出
`IllegalArgumentException`，回退到最大边 512 的帧（248×512），被浏览器放大后明显发糊。该编码器能接受的上限还会随设备状态变化，
因此页面在连上后检查协商分辨率，一旦被大幅降级就自动重启并降低一档；实测稳定结果为 **522×1080**（约 4.4 倍像素量）。

## 聊天控制手机（Chat Agent）

页面右下角的对话按钮把「自然语言 → 手机操作」接了进来：模型只负责**选工具和给参数**，
真正碰手机的永远是 ghost 的 MCP 工具，而且要先过后端白名单与参数校验。

### 用法

1. 按「快速开始」装好 ghost 前置条件，`npm start`。
2. 打开设置面板 → 「聊天」分组 → 勾上 `启用聊天`、填 `模型服务地址` 与 `模型名` → `保存聊天设置`。
   图标只跟 `启用聊天` 走：勾上并保存后右下角才出现对话按钮；**模型名留空时图标仍在**，但发送会得到
   「聊天未启用或模型名为空」的提示（后端返回 503，不发模型请求）。
3. 点右下角按钮，输入一句话，例如「回到桌面」「打开设置」「音量调大」「点一下允许」。
4. 面板上方是气泡，助手气泡下方一排 `tap ✓` / `screenshot ✓` 小标签就是这一步真实调过的工具；
   执行期间显示「正在执行…」并锁住输入，越权或参数非法时直接把后端的拒绝说明回显成错误气泡。
5. `清空对话` 只清屏；`Esc` 或 `×` 收起面板。中英文界面下按钮、状态、错误文案与**发给模型的 system prompt** 一起切换。

### 前置条件（ghost 工具层）

聊天不自己写 ADB 动作，而是把 [ghost-in-the-droid](https://github.com/ghost-in-the-droid/android-agent)
的 stdio MCP server 当子进程拉起，启动命令固定为：

```sh
uvx --from ghost-in-the-droid android-agent-mcp
```

因此需要：

- **Python 3.10+**（ghost 的 `requires-python`）；
- **`uv` / `uvx`** 在 `PATH` 中。没有就装：`curl -LsSf https://astral.sh/uv/install.sh | sh`；
- **`adb` 在 `PATH` 中**（**这一条尚未真机验证**，列在冒烟清单第 1 步）：ghost 通过 ADB 操作设备，而本项目自带的那份 adb 在
  `engine/dependencies/` 下、不在系统 `PATH` 里，若 ghost 找不到 adb 就需要自己软链或导出 `PATH`
  （投屏和按钮用的是引擎自带的 adb，所以这一步只有聊天可能用到）；
- 首次运行 `uvx` 会从 PyPI 下载 `ghost-in-the-droid` 并建隔离环境，**需要联网**（或预先 `uv tool install ghost-in-the-droid` / 配置镜像）。
- 手机仍按现有方式用 USB 连着并完成授权；ghost 用环境变量 `DEFAULT_DEVICE` 选设备，`scripts/start.mjs`
  把固定序列号 `2FD0221C09004177` 传给 `server/ghost-client.mjs`，由它注入子进程环境。

`npm run setup` 会顺带探测 `uvx`/`uv`，缺失时只打印安装提示、**不阻断**引擎构建；
`npm start` 时若 ghost 起不来（或 **25 秒**内没起来，例如 `uvx` 卡在下载），会打印
`ghost MCP server failed to start; chat disabled`，投屏、按钮和 `/keyevent` 照常工作，只是 `/chat` 返回 503；
ghost 连接失败时其子进程传输会被立即关闭，不留残余进程。

### 聊天设置（6 项，存在后端）

| 设置项 | 字段 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 启用聊天 | `enabled` | 关 | 关闭时右下角图标不显示，后端 `/chat` 直接返回 503 `chat disabled`，不发任何模型请求 |
| 模型服务地址 | `baseUrl` | `http://127.0.0.1:11434/v1` | OpenAI 兼容 base URL，本项目按 `<baseUrl>/chat/completions` 请求；填自己的局域网地址 |
| 模型名 | `model` | 空 | **留空即禁用**（后端强制，不信任前端开关）；需支持 function/tool calling |
| API Key | `apiKey` | 空 | 可选，局域网模型通常不需要；只在请求里作 `Authorization: Bearer`，**从不回传前端**（前端只看到 `hasApiKey`） |
| 截图发给模型 | `screenshot` | 开 | 关闭时连 `screenshot` 工具都不暴露给模型；开启时截图以 base64 data URI 作视觉消息回灌，模型不支持视觉会报可读错误 |
| 单次最大步数 | `maxSteps` | 8 | agent 一次请求最多调几轮工具（界面 1–32），到了就停并提示「已达到最大步数」。后端强制：整数收敛到 1–32，非整数丢弃 |

后端把有效值写成 JSON 文件 `state/chat.json`（已 gitignore，权限 `0600` 仅本人可读，临时文件 + 重命名原子写入）；`GET /api/chat-config` 返回
`{enabled, baseUrl, model, maxSteps, screenshot, hasApiKey}` —— Key 只以 `hasApiKey` 摘要出现；`POST` 只接受
`enabled / baseUrl / model / maxSteps / screenshot / apiKey` 这 6 个字段，类型与默认值不符的输入一律丢弃、其他键忽略。
两点行为需要知道：**API Key 留空表示「保持不变」**，所以面板上无法删除已存的 Key（要删就改 `state/chat.json`）；
保存聊天设置**不会**重启投屏画面。

### 暴露给模型的工具（白名单）

工具定义在运行时从 ghost 的 `tools/list` 拉取、按白名单过滤，不手写 schema，避免与 ghost 版本漂移。
读：`dump_ui`、`get_screen_tree`、`get_phone_state`、`list_apps`、`find_on_screen`；
操作：`tap`、`tap_element`、`swipe`、`type_text`、`press_key`、`press_back`、`press_home`、`launch_app`、`clipboard_set`；
截图：`screenshot`（跟随上面的开关）。
**明确拒绝**：`shell`、`install`、`uninstall`、`push`、`pull`、`clipboard_get`、`unlock_device` —— 不给任意命令、
不装/卸应用、不读写文件、不读剪贴板、不绕锁屏。名单外的调用一律由后端拒绝并在聊天里说明，模型拿不到设备权限。

### 接口

在既有控制桥（`http://127.0.0.1:8100`，CORS 仍只允许 `http://127.0.0.1:8000` 与 `http://localhost:8000`）上新增两条路由，
`/health`、`/keyevent` 的既有语义未变（`/keyevent` 与其他 POST 一样新增了 Origin 强制校验，见下）：

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| `POST` | `/chat` | `{ message, lang }` | 成功 `200 { reply, steps }`；`400 message required`；`403 origin not allowed`；`502` 模型/工具失败（带可读错误信息）；`503 chat disabled / chat unavailable` |
| `GET` | `/api/chat-config` | — | `200` 公开展示的配置（不含 Key） |
| `POST` | `/api/chat-config` | 上面 6 个字段的任意子集 | `200` 保存后的公开配置；`403 origin not allowed` |

`/chat` 只读 `message` 和 `lang`，**请求体里任何开关/模型字段都被忽略**；超过 64KB 的请求体返回 413。

**所有写路由（`POST /keyevent`、`POST /chat`、`POST /api/chat-config`）强制校验 Origin**：
CORS 只拦「读响应」，恶意网页仍能发出免预检的简单请求（如 `content-type: text/plain`）来改配置或驱动手机，
所以桥对带 Origin 且不在白名单内的 POST 一律返回 `403 origin not allowed`，请求体不会被处理。
不带 Origin 的请求（`curl` 等非浏览器客户端）不受影响；页面自身携带的是白名单内的同源 Origin。

### 隐私与边界

- **默认会把截图发给模型**（`截图发给模型` 勾选着），连同屏幕文字和指令文本一起离开本机、发往你填的模型地址；
  不想外发就关掉该开关，或先把 `模型服务地址` 收到自己的局域网内。剪贴板只读（`clipboard_get`）不在名单里，不会被发出去。
- API Key 只写不读：存 `state/chat.json`、只出现在模型请求头里，接口响应不回传，页面 `input` 是 `type="password"`。
- 锁屏真相源是后端：每一步请求前，后端调 ghost 的 `get_phone_state` 自行判断，读不到状态就**按锁定处理**（fail closed），
  锁定时只回一句「请先解锁」，模型和动作工具都不会被调用；前端 3 秒轮询的状态只用于界面显示。
- 聊天是**新增**入口：自研桥的 `/keyevent` 和右侧按钮、投屏、触摸、滚动全部照旧，两条路径互不依赖；
  ghost 起不来或模型超时，最多是聊天气泡报错。每次模型调用限时 **60 秒**（超时中断请求），
  模型/工具失败以 `502` 返回可读错误信息，前端直接显示在气泡里。

### 本版本没有做的

- **真正的多轮上下文**：面板会保留最近的气泡供阅读，但 `/chat` 契约是**每条消息无状态**的 ——
  后端每次只拼 `[system, 当前这句]`，模型看不到之前的对话。要让上下文延续，得给 `/chat` 加历史字段（后续方向）。
- 模型侧不做能力预探测（是否支持视觉靠模型自己报错），不做流式输出，历史不跨刷新保存。
- 远程访问仍不提供：页面只绑回环，模型地址由用户自己填局域网端点。

### 真机冒烟（手动，尚未在本环境执行）

单元测试覆盖的是逻辑（白名单、配置读写、模型响应解析、agent 循环、路由、启动编排、i18n）；
**ghost 真实返回的消息结构和模型 tool calling 行为必须在配好工具链的环境里手工验收**。
本机开发环境有 `uvx`、有 `adb`、手机也连着，但**没有任何可用且开启 function/tool calling 的模型端点**
（默认 `http://127.0.0.1:11434/v1` 无服务），因此下面的清单**未执行、不得当成已通过**：

1. `which uvx adb` 都有输出；`uvx --from ghost-in-the-droid android-agent-mcp` 能手工起来（stdio，等待输入）。
2. `npm run setup && npm start`，日志出现 `control bridge listening at http://127.0.0.1:8100`，且**没有** `ghost MCP server failed to start`。
3. `curl -s http://127.0.0.1:8100/api/chat-config` 返回公开配置；`curl -s -X POST -d '{"enabled":true,"baseUrl":"http://<局域网模型>/v1","model":"<模型名>"}' http://127.0.0.1:8100/api/chat-config`
   之后**刷新页面**（页面只在加载时读一次配置），右下角图标出现。
4. 手机解锁，发「回到桌面」→ 期望手机真的回桌面，气泡里出现 `press_home ✓` 之类的步骤标签。
5. 发「截图看看现在是什么」→ 期望 `screenshot ✓`；若模型不支持视觉，期望是可读错误而不是静默。
6. 发一个越权请求（诱导模型调用 `shell`）→ 期望后端拒绝并回显「不在允许列表中」，手机无动作。
7. 锁屏后再发一句 → 期望只回「请先在手机上解锁」，且日志里模型请求不发生。
8. 点回右侧工具栏的 `电源 / 音量+ / 音量− / 主页` → 期望仍走 `POST /keyevent` 正常生效（回归检查，本功能不碰这条路径）。

## 架构

```
浏览器 (http://127.0.0.1:8000)
├── web/               自定义页面：设置面板、聊天面板、状态栏、对引擎工具栏的包装
│   └── shared/keys.mjs  浏览器与 Node 共用的按键码、设置校验、分辨率策略、语言包
├── engine/             ws-scrcpy-web v0.5.13（由 npm run setup 拉取，不入库）
│   ├── HTTP :8000     仅绑定 127.0.0.1，提供页面与 WebSocket
│   └── scrcpy-server  视频/音频流 + 触摸/滚轮/剪贴板控制通道
└── control bridge     http://127.0.0.1:8100
    ├── POST /keyevent → adb input keyevent → 手机
    ├── POST /chat     → agent 循环 → 局域网模型 /v1/chat/completions
    │                    └→ 白名单校验 → ghost MCP (stdio 子进程) → adb → 手机
    └── GET/POST /api/chat-config → state/chat.json（Key 不出后端）
```

四个部分各司其职：**引擎**负责视频解码和控制协议，**桥**做按键转发与聊天编排，
**agent 循环**负责模型调用、白名单与锁屏门禁，**页面**负责交互层和分辨率/设置策略。
`scripts/start.mjs` 负责资源复制、进程启动、ghost 子进程与聊天配置存储的装配、就绪等待和信号清理。

安全边界：引擎与桥都只绑定回环地址；桥的 CORS 白名单仅允许
`http://127.0.0.1:8000` 与 `http://localhost:8000` 两个精确来源，且**所有 POST 路由都强制 Origin 校验**
（白名单外的 Origin 直接 403，堵住免预检的跨站简单请求）；启动时强制断开 Wi‑Fi ADB，只允许固定 USB 设备。
聊天不新增端口、不放宽 CORS，模型出口只有后端一处，且工具受白名单约束。

## 快速开始

### 环境

- Node.js（开发验证于 v26）与 npm
- 可用的 `adb`（引擎会自带一份）
- 通过 USB 连接、已授权 USB 调试的华为 Mate 40 Pro
- **仅聊天功能还需要**：Python 3.10+、`uv`/`uvx`、`PATH` 里可直接调用的 `adb`，以及一个局域网内支持
  function/tool calling 的 OpenAI 兼容模型端点。缺这些只是聊天不可用，投屏与按钮照常（详见[前置条件](#前置条件ghost-工具层)）。

### 安装与运行

```sh
npm run setup   # 首次运行：克隆并构建固定版本引擎，打上仅监听 127.0.0.1 的补丁（已构建则跳过）
npm start       # 复制 web/ 资源、启动引擎、控制桥与 ghost MCP 子进程
npm test        # 运行 115 个单元测试
```

浏览器打开 <http://127.0.0.1:8000/>。按 `Ctrl-C` 或发送 `SIGTERM` 即可干净停止引擎、桥和 ghost 子进程，无需进程守护工具。

> 修改 `web/` 或 `shared/` 后必须**重启 `npm start`**：自定义页面只在启动时复制到引擎目录。
> 修改 `server/` 后同样需要重启桥。聊天设置改完不用重启，`state/chat.json` 每次请求都重新读。

## 引擎安装（ws-scrcpy-web）

### 自动安装（推荐）

```sh
npm run setup
```

`scripts/setup.mjs` 会依次执行以下步骤，全部在项目根目录完成：

1. 用 `git clone --depth 1 --branch v0.5.13` 把上游仓库克隆到 `engine/`；
2. 在 `engine/` 中运行 `npm install` 安装依赖；
3. 打上 loopback 补丁：把 `src/server/services/HttpServer.ts` 中的 `server.listen(port, () => {`
   改为 `server.listen(port, '127.0.0.1', () => {`，保证 HTTP 只监听本机；若上游代码结构变化导致匹配不到，脚本会直接报错而不是静默跳过；
4. 运行 `npm run stage-seed`，把运行期需要的 `adb`、`scrcpy-server`、node-pty 等依赖落到 `engine/dependencies/`；
5. 运行 `npm run build` 生成 `engine/dist/index.js`。

该命令是**幂等**的：检测到 `engine/dist/index.js` 已存在就跳过，不会重复克隆或覆盖已有构建。

### 手动安装 / 调试引擎

需要自定义引擎版本或排查安装问题时，可按上面的顺序手工执行：

```sh
git clone --depth 1 --branch v0.5.13 \
  https://github.com/bilbospocketses/ws-scrcpy-web.git engine
cd engine
npm install
# 编辑 src/server/services/HttpServer.ts：server.listen(port, '127.0.0.1', () => {
npm run stage-seed
npm run build
```

注意：

- 若跳过 loopback 补丁，引擎会监听所有网卡，不符合本项目的本机安全边界；`scripts/start.mjs` 仍按 `127.0.0.1:8000` 访问。
- 升级引擎版本时修改 `scripts/setup.mjs` 中的 `ENGINE_TAG`，删除 `engine/` 后重新运行 `npm run setup`，再重启 `npm start`。
- 引擎启动时会尝试下载**可选**的 node-pty 预编译包。在需要代理的网络环境中，Node 的 `fetch` 默认不读取 `HTTP(S)_PROXY`，`scripts/start.mjs` 检测到代理变量后会自动传入 `NODE_USE_ENV_PROXY=1` 和 `--use-system-ca`，避免因此卡住启动。

### 自定义页面如何进入引擎

`npm start` 会把：

- `web/index.html`、`web/app.js`、`web/styles.css` 原样复制到 `engine/dist/public/`；
- `shared/keys.mjs` 复制为 `engine/dist/public/keys.js`（引擎静态服务器不支持 `.mjs` 的 MIME 类型且设置了 `nosniff`，所以浏览器侧必须用 `.js` 扩展名）。

因此每次修改 `web/` 或 `shared/` 都要重新运行 `npm start` 才能看到效果。

## 配置

- **设备序列号**：固定为 `2FD0221C09004177`，定义在 `server/adb.mjs`（`DEFAULT_USB_SERIAL`）和 `web/app.js`（`DEVICE_ID`）。换设备需同时改这两处；聊天不用另改，`scripts/start.mjs` 会把同一个序列号作为 `DEFAULT_DEVICE` 环境变量注入 ghost 子进程。
- **端口**：引擎 `8000`，控制桥 `8100`（`/keyevent`、`/chat`、`/api/chat-config` 共用），在 `scripts/start.mjs` 中配置。
- **USB 限制**：`scripts/start.mjs` 启动时及每 5 秒断开 Wi‑Fi ADB `192.168.3.123:5555`；无线连接不会被接受。
- **聊天配置**：存在 `state/chat.json`（gitignore），由设置面板的「聊天」分组写；想直接改（例如删掉 `apiKey`）就编辑这个文件，字段见[聊天设置](#聊天设置6-项存在后端)。
- **ghost 启动方式**：`uvx --from ghost-in-the-droid android-agent-mcp` 固定在 `server/ghost-client.mjs` 的 `DEFAULT_GHOST_COMMAND` / `DEFAULT_GHOST_ARGS`，不读环境变量；换启动方式（例如 `uv tool run` 或本地克隆的 `python3 -m gitd.mcp_server`）改这两个常量。

## 已知限制

- **锁屏黑屏**：Android 的 keyguard 只向 scrcpy 提供黑色画面，这是系统限制，不是流坏了。解锁手机即可，状态栏会显示锁屏提示。
- **安全上下文**：WebCodecs 解码要求 secure context，普通 HTTP 只能在 `127.0.0.1` / `localhost` 上使用；局域网地址（如 `192.168.x.x:8000`）无法解码视频，远程访问需自行加 HTTPS 并放宽 CORS/绑定地址。
- **USB Only**：只允许上述 USB 设备，不实现无线投屏。
- **无守护进程**：刻意不引入 supervisor，由启动脚本自己处理清理。
- **引擎许可**：`engine/` 是 GPLv3 的第三方项目，由 `npm run setup` 单独拉取，未提交到本仓库；详见「开源组件声明」与「引擎安装」。
- **聊天每条消息无状态**：面板保留历史气泡，但模型只看到当前这句（`/chat` 契约里没有历史字段），所以「再点一下它左边的」这类追问不会被理解成上一轮的延续，见[本版本没有做的](#本版本没有做的)。
- **聊天依赖外部两端**：`uvx` + ghost + 支持 tool calling 的模型端点，任一缺失聊天就不可用；参数校验只做必需字段与基本类型（浅校验），不是完整 JSON Schema 校验。
- **ghost 版本未固定**：工具名与返回结构来自上游，上游改名或换结构会影响聊天（投屏不受影响）；真机冒烟清单见[上一节](#真机冒烟手动尚未在本环境执行)。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 状态栏显示 `Engine unavailable` | 按「引擎安装」完成 `npm run setup`，再运行 `npm start` |
| 启动报 `engine did not become ready` | 代理环境下 Node 的 `fetch` 不走系统代理，引擎可选依赖下载会超时；启动脚本检测到代理时已自动注入 `NODE_USE_ENV_PROXY=1` 与 `--use-system-ca`，可检查代理/NO_PROXY 设置后重试 |
| 画面糊、状态栏显示 `248x512` | 在设置里选「自动」或 `1080`；日志中会出现编码器 `IllegalArgumentException` |
| 画面全黑但显示已连接 | 手机处于锁屏状态，解锁后恢复；不绕过锁屏 |
| 引擎首次运行弹出安装范围对话框 | 选 “no, me only”；自定义页面通常会替换掉该首页 |
| `npm run setup` 出现 `velopack` 的 `EBADENGINE` 警告 | 可忽略，不影响安装和运行 |
| **右下角没有对话图标** | 图标只看 `GET /api/chat-config` 的 `enabled`：设置里勾了「启用聊天」并点过 `保存聊天设置` 才会出现（模型名留空时图标会出现，但发送会报「聊天未启用或模型名为空」）。桥没起来（`curl http://127.0.0.1:8100/health` 不通）时前端拿不到配置，图标也不显示；重启 `npm start` 后刷新页面 |
| **聊天报「聊天服务不可用」（503 `chat unavailable`）** | ghost 子进程没起来，日志里是 `ghost MCP server failed to start; chat disabled`。依次确认 `which uvx`、`which adb`、`uvx --from ghost-in-the-droid android-agent-mcp` 能否手工启动（首次需要联网下载包），Python 需 3.10+；补齐后重启 `npm start` |
| **模型只回文字、从不动手机**（没有 `工具 ✓` 标签） | 该端点多半不支持或没开启 function/tool calling（或模型太小/太旧）。换支持 tool calling 的模型，或按所用推理服务打开工具调用能力；system prompt 已要求「只调用给出的工具列表」，正常模型会以 `tool_calls` 应答 |
| **手机锁着时聊天只回「请先解锁」** | 设计如此：后端每步都调 `get_phone_state` 自行判断，读不到状态按锁定处理（fail closed），绝不尝试解锁。解锁手机再重发；投屏此刻是黑屏，两者同源 |
| **`screenshot` 报错 / 模型看不懂截图** | 关掉设置里的「截图发给模型」，或换成支持视觉输入的模型；本项目不预先探测模型是否支持视觉 |

## 目录结构

```
scripts/setup.mjs        克隆/构建/打补丁固定版本引擎，附带检测 uvx/uv
scripts/start.mjs        启动编排：USB 检查、资源复制、进程管理、装配聊天后端、就绪等待
server/adb.mjs           ADB 可用性检查与设备发现
server/bridge.mjs        回环 HTTP 控制桥（/health、/keyevent、/chat、/api/chat-config，含 CORS 白名单）
server/chat-config.mjs   聊天配置的读写与持久化（state/chat.json，Key 不回传）
server/chat-agent.mjs    agent 循环：锁屏门禁、模型调用、白名单执行、结果回灌
server/model-client.mjs  OpenAI 兼容 /chat/completions 客户端（解析 tool_calls）
server/ghost-client.mjs  ghost 的 stdio MCP client（uvx 子进程、tools/list、callTool）
shared/keys.mjs          共用按键码、设置校验、分辨率策略与中英文语言包
shared/chat-tools.mjs    工具白名单、拒绝清单与发给模型的 tool 定义/参数校验
web/index.html           页面结构、设置面板与聊天面板
web/app.js               状态栏、按钮处理、设置持久化、聊天前端、工具栏包装
web/styles.css           紧凑暗色主题、聊天面板与布局覆盖
tests/*.test.mjs         115 个 node:test 用例
docs/requirements-analysis.md  需求分析（需求来源、追溯、验收、遗留）
docs/screenshots/        README 中使用的界面截图
docs/superpowers/        设计规格、实施计划与开发台账
state/chat.json          聊天配置（本地生成，已 gitignore）
engine/                  GPLv3 第三方引擎，由 setup 生成，已加入 .gitignore
```

## 测试

```sh
npm test
```

覆盖 ADB 设备筛选、桥的 CORS/按键/聊天/配置接口、引擎安装与启动编排（含 ghost 起不来时不影响桥）、
按键码、设置校验与持久化、聊天配置存储与公开视图、工具白名单与参数校验、模型响应与 `tool_calls` 解析、
MCP client 的命令与调用形状、agent 循环（锁定门禁、越权拒绝、截图回灌顺序、最大步数）、
分辨率阶梯与降级检测、中英文语言包完整性等，共 115 个用例。

全部用注入的假依赖跑，**不碰真机、不起 ghost、不发真实模型请求**。
因此 ghost 工具的真实返回形状和模型 tool calling 行为属于手工验收范围，见
[真机冒烟](#真机冒烟手动尚未在本环境执行)；本机虽有 `uvx`/`adb` 和连着的手机，但**没有可用的局域网 tool-calling 模型端点**，
该清单**尚未执行**，不应被当成已通过。
