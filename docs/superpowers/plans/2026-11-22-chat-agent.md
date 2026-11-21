# Chat Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在页面右下角加对话图标，用户用自然语言控制手机；模型走局域网 OpenAI 兼容接口，设备动作经 ghost MCP 工具层，自研 agent 循环和白名单由本项目掌握。

**Architecture:** Node 侧复用现有 8100 服务进程（bridge）新增 `/chat`、`/api/chat-config` 路由；后端持有配置（API Key 不进前端）并负责模型调用、tool_calls 白名单校验、agent 循环；ghost 作为 stdio MCP 子进程提供设备工具；现有按钮的 `/keyevent` 链路完全不动。

**Tech Stack:** Node 内置 http/fetch、`@modelcontextprotocol/sdk`（Client + StdioClientTransport）、ghost-in-the-droid（uvx 启动）、现有 node:test。

**Spec:** `docs/superpowers/specs/2026-11-22-chat-agent-design.md`

## Global Constraints

- 设备 USB 序列号固定 `2FD0221C09004177`；不 root、不在手机装 App、不绕锁屏。
- 配置持久化在 Node 后端，API Key 不进前端；「启用聊天 / 模型名为空则禁用」由后端强制。
- 模型接口：OpenAI 兼容 `/v1/chat/completions`，支持 tool calling；默认 base URL `http://127.0.0.1:11434/v1`。
- ghost 启动命令：`uvx --from ghost-in-the-droid android-agent-mcp`，stdio MCP，66 工具。
- 截图默认发给模型（用户确认），按 OpenAI vision 的 `image_url` base64 data URI 回灌。
- 白名单外的工具名一律拒绝；明确排除 `shell`/`install`/`uninstall`/`clipboard_get`/`unlock_device` 等。
- 工具 schema 运行时从 MCP `tools/list` 拉取并按白名单过滤；不手写固定 schema。
- 锁屏/休眠以 ghost `get_phone_state` 为真相源，后端自己判断，不信任前端。
- 引擎 `8000` 与桥 `8100` 的现有绑定/CORS 不变；`web/` 修改需重启 `npm start`。

## Review Focus

- 模型返回白名单外的工具名（如 `shell`）→ 必须拒绝执行并在聊天里说明，测试在 Task 4。
- 工具调用参数畸形（缺必填字段 / 类型不对）→ 必须校验失败并回显，不传给 ghost，测试在 Task 4。
- 手机锁定/休眠时用户发消息 → agent 不得下发任何点击/按键，只回解锁提示，测试在 Task 5。
- API Key 与「启用」开关被前端伪造 → 后端忽略客户端传入的启用状态，只读后端配置，测试在 Task 3。
- MCP `tools/list` 失败或 ghost 未启动 → 聊天返回可读错误，不改变投屏/按钮，测试在 Task 6 与 Task 7。

---

### Task 1: 配置持久化模块

**Files:**
- Create: `server/chat-config.mjs`
- Test: `tests/chat-config.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `DEFAULT_CHAT_CONFIG` — 默认配置对象
  - `createChatConfigStore({ file })` → `{ load(): object, save(patch: object): object, publicConfig(): object }`
  - `publicConfig` 不返回 `apiKey`，改返回 `hasApiKey: boolean`

- [ ] **Step 1: 写失败测试**

`tests/chat-config.test.mjs`：在临时目录里用 `join(tmp, 'chat.json')` 创建 store，断言：
- `load()` 首次返回 `DEFAULT_CHAT_CONFIG`（`enabled:false`、`baseUrl:'http://127.0.0.1:11434/v1'`、`model:''`、`maxSteps:8`、`screenshot:true`、`apiKey:''`）
- `save({ model:'qwen3', apiKey:'sk-x' })` 后 `load().model === 'qwen3'`、`load().apiKey === 'sk-x'`
- `publicConfig()` 不含 `apiKey` 字段且 `hasApiKey === true`
- `load()` 对损坏 JSON 回退默认；对缺字段的旧文件与默认合并

- [ ] **Step 2: 跑测试确认失败**
Run: `npm test -- --test-name-pattern="chat config"`（或直接 `node --test tests/chat-config.test.mjs`）
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `server/chat-config.mjs`**
用 `node:fs` 同步读写 JSON；`save` 做白名单字段过滤后合并写盘；`publicConfig` 显式挑字段。

- [ ] **Step 4: 跑测试确认通过**
Run: `node --test tests/chat-config.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**
`git add server/chat-config.mjs tests/chat-config.test.mjs && git commit -m "feat: backend-persisted chat config"`

---

### Task 2: 工具白名单与定义过滤

**Files:**
- Create: `shared/chat-tools.mjs`
- Test: `tests/chat-tools.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `publicConfig()` 形状（`screenshot` 布尔）
- Produces:
  - `ALLOWED_TOOLS` — 允许的工具名数组
  - `DENIED_TOOLS` — 明确拒绝的工具名数组（用于测试与文档一致性）
  - `filterToolDefinitions(tools, config)` — 输入 MCP `tools/list` 的 `{name, description, inputSchema}[]`，输出 OpenAI tools 格式数组
  - `isAllowedTool(name, config)` — 布尔
  - `validateToolArgs(name, args, definitions)` — 返回 `{ ok:boolean, error?:string }`

- [ ] **Step 1: 写失败测试**

`tests/chat-tools.test.mjs`：
- `ALLOWED_TOOLS` 精确等于 `['dump_ui','get_screen_tree','get_phone_state','list_apps','find_on_screen','tap','tap_element','swipe','type_text','press_back','press_home','press_key','launch_app','clipboard_set','screenshot']`
- `DENIED_TOOLS` 含 `shell`、`install`、`uninstall`、`clipboard_get`、`unlock_device`
- `isAllowedTool('shell', {}) === false`；`isAllowedTool('tap', {}) === true`
- `isAllowedTool('screenshot', { screenshot:false }) === false`；`isAllowedTool('screenshot', { screenshot:true }) === true`
- `filterToolDefinitions([{name:'tap',...},{name:'shell',...}], { screenshot:false })` 只保留 `tap`，且输出项含 `type:'function'` 与 `function.name/description/parameters`
- `validateToolArgs('tap', {}, [{name:'tap',inputSchema:{required:['x','y']}}])` 返回 `ok:false`；传 `{x:1,y:2}` 返回 `ok:true`

- [ ] **Step 2: 跑测试确认失败**
Run: `node --test tests/chat-tools.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现 `shared/chat-tools.mjs`**
白名单用 Set；`validateToolArgs` 只校验 `required` 字段存在性与基本类型（string/number/boolean/object），不做完整 JSON Schema。

- [ ] **Step 4: 跑测试确认通过**
Expected: PASS

- [ ] **Step 5: 提交**
`git add shared/chat-tools.mjs tests/chat-tools.test.mjs && git commit -m "feat: tool whitelist for chat agent"`

---

### Task 3: 后端聊天配置 HTTP 路由

**Files:**
- Modify: `server/bridge.mjs`（新增 `/api/chat-config` GET/POST，复用现有 CORS/OPTIONS/body 读取）
- Test: `tests/bridge.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 1 `createChatConfigStore`
- Produces: `createBridge({ adb, host, port, chatConfig })` 新增可选 `chatConfig` 参数；未提供时新路由返回 404 或 503（测试选一个并固定）

- [ ] **Step 1: 写失败测试（追加到 `tests/bridge.test.mjs`）**

用现有 fake `adb` + 真实 store（临时文件）：
- `GET /api/chat-config` 带合法 Origin → 200，body 不含 `apiKey`，含 `hasApiKey`
- `POST /api/chat-config` body `{"model":"qwen3","apiKey":"sk-x"}` → 200，随后 `GET` 返回 `model:'qwen3'`、`hasApiKey:true`
- `POST` body 里塞 `{"enabled":true}` 而后端配置为 `enabled:false` → 后端配置不变（前端不能通过 config 路由自己启用）
- 非法 JSON → 400；超大 body → 413（复用现有 body 限制）
- 无 Origin 或非白名单 Origin → 不返回 CORS 头（沿用现有断言风格）

- [ ] **Step 2: 跑测试确认失败**
Run: `node --test tests/bridge.test.mjs`
Expected: FAIL（新路由 404）

- [ ] **Step 3: 实现路由**
在 `handleRequest` 的 CORS/OPTIONS 分支把 `/api/chat-config` 纳入；GET 返回 `chatConfig.publicConfig()`；POST 调 `chatConfig.save(body)` 后返回 `publicConfig()`。`enabled` 是可写字段（设置面板开关）；信任边界在后续 Task 7 的 `/chat` 请求体（忽略其中任何 enabled/配置字段，只读后端配置），不在此配置路由。此任务使用最终签名 `createBridge({ adb, host, port, chatConfig, chat })`，`chat` 可选、本任务不实现 `/chat` 路由。

- [ ] **Step 4: 跑测试确认通过**
Expected: PASS

- [ ] **Step 5: 提交**
`git add server/bridge.mjs tests/bridge.test.mjs && git commit -m "feat: chat config HTTP routes"`

---

### Task 4: OpenAI 兼容模型客户端

**Files:**
- Create: `server/model-client.mjs`
- Test: `tests/model-client.test.mjs`

**Interfaces:**
- Consumes: 无（依赖注入 `fetchImpl`）
- Produces:
  - `chatCompletion({ baseUrl, model, apiKey, messages, tools, fetchImpl = fetch, signal })` → `{ content: string|null, toolCalls: Array<{id,name,arguments:object}> }`

- [ ] **Step 1: 写失败测试**

用 fake fetch 断言请求与响应：
- 请求 URL 为 `${baseUrl}/chat/completions`，method POST，`authorization: Bearer <apiKey>`（apiKey 为空时不带该头）
- body 含 `model`、`messages`、`tools`、`tool_choice:'auto'`
- 响应 `choices[0].message` 只有 `content` 时 → `{ content:'已发送', toolCalls:[] }`
- 响应含 `tool_calls`（`function.name='tap'`、`function.arguments='{"x":1,"y":2}'`）→ 解析成 `toolCalls[0].arguments` 为对象
- 非 2xx → 抛出包含状态码与响应片段的错误

- [ ] **Step 2: 跑测试确认失败**
Expected: FAIL

- [ ] **Step 3: 实现 `server/model-client.mjs`**
用全局 fetch（可注入）；手动拼 URL（去掉 baseUrl 末尾 `/`）；解析 JSON 时防御 `tool_calls[].function.arguments` 非法 JSON（当作空对象并记录）。

- [ ] **Step 4: 跑测试确认通过**
Expected: PASS

- [ ] **Step 5: 提交**
`git add server/model-client.mjs tests/model-client.test.mjs && git commit -m "feat: OpenAI-compatible model client"`

---

### Task 5: Ghost MCP 客户端

**Files:**
- Create: `server/ghost-client.mjs`
- Test: `tests/ghost-client.test.mjs`
- Modify: `package.json`（加 `@modelcontextprotocol/sdk` 依赖）

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk/client/index.js`、`.../client/stdio.js`
- Produces:
  - `createGhostClient({ serial, command='uvx', args=['--from','ghost-in-the-droid','android-agent-mcp'], env })` → `{ start(), stop(), listTools(), callTool(name, args) }`
  - `listTools()` → `[{name, description, inputSchema}]`
  - `callTool()` → MCP 调用结果（透传）

- [ ] **Step 1: 写失败测试**

通过注入一个假的 transport/Client 工厂（模块参数化 `deps`）断言：
- `start()` 用给定 command/args  spawn，且 env 含设备序列号（ghost 用 `DEFAULT_DEVICE`）
- `listTools()` 调用 MCP `tools/list` 并返回其 `tools`
- `callTool('get_phone_state', {})` 以 `{ name, arguments:{} }` 调用 MCP `callTool`
- `stop()` 调 client.close() 且可重复调用不抛

- [ ] **Step 2: 跑测试确认失败**
Expected: FAIL

- [ ] **Step 3: 实现 `server/ghost-client.mjs`**
用官方 SDK 的 `Client` + `StdioClientTransport`；把依赖注入做成第三个参数 `deps` 以便测试；真实 env 里设置 `DEFAULT_DEVICE: serial`。

- [ ] **Step 4: 跑测试确认通过**
Expected: PASS

- [ ] **Step 5: 提交**
`git add server/ghost-client.mjs tests/ghost-client.test.mjs package.json && git commit -m "feat: ghost MCP client"`

---

### Task 6: Agent 循环

**Files:**
- Create: `server/chat-agent.mjs`
- Test: `tests/chat-agent.test.mjs`

**Interfaces:**
- Consumes: Task 2 `filterToolDefinitions/isAllowedTool/validateToolArgs`、Task 4 `chatCompletion`、Task 5 ghost client
- Produces:
  - `runAgentTurn({ config, ghost, userText, lang, deps })` → `{ reply: string, steps: Array<{tool, ok}> }`
  - `deps` 含 `listTools`、`callTool`、`chatCompletion` 以便测试

- [ ] **Step 1: 写失败测试**

用 fake ghost/model：
- 手机锁定（`get_phone_state` 返回 `locked:true`）时：不调用模型，返回含"解锁"字样的 `reply`，`steps` 为空
- 模型首轮返回 `tool_calls: [{name:'shell',arguments:{}}]` → 拒绝，`steps` 记 `{tool:'shell',ok:false}`，不调用 ghost 的 callTool，reply 说明拒绝
- 模型先返回 `tap` 调用（参数合法）、再返回纯文本 → 依次调用 ghost.callTool('tap',...)，最终 reply 为文本，`steps` 含 tap 成功
- 参数缺字段的 `tap` → 不调用 ghost，reply 含错误
- 循环超过 `config.maxSteps`（设 2）→ 停止并返回提示，`chatCompletion` 调用次数 ≤ 2
- `screenshot` 工具结果按 vision 格式回灌：消息里出现 `{ type:'image_url', image_url:{ url:/^data:image/ } }`

- [ ] **Step 2: 跑测试确认失败**
Expected: FAIL

- [ ] **Step 3: 实现 `server/chat-agent.mjs`**
system prompt 按 `lang` 生成中/英两版（要求同语言回复、只能用给定工具、锁屏不得操作）；每轮先 `get_phone_state` 判断（首轮一次即可），再模型调用；tool_calls 逐个校验白名单与参数；工具结果拼进 messages（screenshot 用 base64 data URI，其他用文本）；最多 maxSteps 轮。

- [ ] **Step 4: 跑测试确认通过**
Expected: PASS

- [ ] **Step 5: 提交**
`git add server/chat-agent.mjs tests/chat-agent.test.mjs && git commit -m "feat: agent loop with whitelist enforcement"`

---

### Task 7: `/chat` 路由并接入启动编排

**Files:**
- Modify: `server/bridge.mjs`（新增 `/chat` POST 路由）
- Modify: `scripts/start.mjs`（创建 configStore/ghost/agent，传入 bridge，纳入 cleanup）
- Modify: `scripts/setup.mjs`（检测 `uvx`/`uv`，缺失时打印安装提示但不阻断，供 README 引用）
- Test: `tests/bridge.test.mjs`、`tests/start.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1/3/5/6 的产出
- Produces: `createBridge({ adb, host, port, chatConfig, chat })`，其中 `chat` 为 `{ run(userText, lang) }`

- [ ] **Step 1: 写失败测试**

- `POST /chat` body `{"message":"回到桌面","lang":"zh"}` → 200，返回 `{ reply, steps }`
- 后端配置 `enabled:false` 或 `model:''` → 返回 503 且**不调用**模型（fake model 计数为 0）
- body 缺 `message` 或类型不对 → 400
- `start.test.mjs`：`main()` 的 fake deps 增加 ghost 相关，断言 ghost.start 在 bridge.start 前、`cleanup` 里 ghost.stop 被调用

- [ ] **Step 2: 跑测试确认失败**
Expected: FAIL

- [ ] **Step 3: 实现路由与编排**
`/chat` 用注入的 `chat.run`；`start.mjs` 中按顺序：configStore → ghost.start → chatAgent → bridge.start；cleanup 逆序 stop。`setup.mjs` 仅检测并提示。

- [ ] **Step 4: 跑测试确认通过**
Expected: PASS

- [ ] **Step 5: 提交**
`git add server/bridge.mjs scripts/start.mjs scripts/setup.mjs tests/ && git commit -m "feat: wire chat routes into startup"`

---

### Task 8: 聊天 UI 与设置面板

**Files:**
- Modify: `web/index.html`（右下角图标 + 面板 + 设置分组）
- Modify: `web/styles.css`（样式）
- Modify: `web/app.js`（交互 + 调 `/api/chat-config` 与 `/chat`）
- Modify: `shared/keys.mjs`（聊天文案 i18n）
- Test: `tests/shared-keys.test.mjs`（i18n key 完整性已有 parity 测试，追加新 key 即可）；UI 用浏览器手动验收

**Interfaces:**
- Consumes: Task 3 `/api/chat-config`、Task 7 `/chat`
- Produces: 前端不再从 localStorage 读聊天配置；设置面板改动 POST 后端

- [ ] **Step 1: 写失败测试（i18n）**

在 `tests/shared-keys.test.mjs` 的 parity 测试里自然覆盖：为中英文各加 `chat.*` 键（按钮、标题、占位符、状态、错误、设置项标签）；断言两语言 key 集合一致。

- [ ] **Step 2: 跑测试确认失败**
Expected: FAIL（某语言缺 key）

- [ ] **Step 3: 实现 UI**
右下角圆形对话按钮（tooltip 随语言切换）→ 面板；消息气泡、输入框、发送按钮、"清空对话"；启动时 `GET /api/chat-config`，按 `enabled` 决定图标是否显示；设置面板新增聊天分组，读写走后端接口；`/chat` 失败显示 `reply` 或错误。

- [ ] **Step 4: 跑测试 + 浏览器手动验收**
Run: `npm test` → PASS
手动：按 README 启动后，右下角图标出现/消失随设置；发"回到桌面"得到回复且手机回桌面；锁屏时只回解锁提示。

- [ ] **Step 5: 提交**
`git add web/ shared/keys.mjs tests/shared-keys.test.mjs && git commit -m "feat: chat UI and settings integration"`

---

### Task 9: 文档与最终冒烟

**Files:**
- Modify: `README.md`（聊天功能、ghost 前置条件 uv/uvx、配置说明、隐私说明、排错）
- Modify: `docs/requirements-analysis.md`（把聊天列为后续已实现）
- Test: 全量 `npm test` + 真机冒烟

- [ ] **Step 1: 更新文档**
README 增加：聊天用法、ghost 依赖（Python 3.10+、uv/uvx）、模型配置字段、截图默认开启的说明、`/chat` 与 `/api/chat-config` 接口。

- [ ] **Step 2: 全量测试**
Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 3: 真机冒烟**
按 Task 8 手动步骤 + 确认原有按钮（电源/音量/主页）仍走 `/keyevent` 不受影响。

- [ ] **Step 4: 提交**
`git add README.md docs/ && git commit -m "docs: chat feature and ghost setup"`

---

## Self-Review

- **Spec coverage**: 聊天 UI（T8）、模型配置后端持久化（T1/T3）、工具白名单（T2/T6）、agent 循环与截图（T6）、锁屏真相源（T6）、ghost 工具层（T5/T7）、旧桥保留（T7 明确不动 `/keyevent`）、多语言（T8）、安全与隐私（T2/T6/T9）——均有任务覆盖。
- **Step scan**: 每步一个动作；测试步骤给断言值，实现步骤给签名，无"TBD"。
- **Type consistency**: `chatCompletion`、`createGhostClient`、`runAgentTurn`、`createChatConfigStore` 名称在接口块与实现步骤一致。
- **Review Focus**: 5 项均映射到 T4/T3/T5/T6/T7 的具体测试。
- **Proportion**: 计划比规格长，但主要是接口与测试断言，未写出函数体。
