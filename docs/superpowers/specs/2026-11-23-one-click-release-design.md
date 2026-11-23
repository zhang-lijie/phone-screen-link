# 一键安装向导与 GitHub Release 设计

日期：2026-11-23

## 意图

让普通用户用最少命令完成部署：下载一个安装包 → 解压 → 运行 `install.sh` → 浏览器自动打开**本地网页向导**，在向导里完成环境检测、依赖安装、可选聊天配置、启动应用。并把这个可分发形态作为 GitHub Release `v1.0.0` 发布。

用户已确认：采用方案 A（完整安装包 + 自举脚本）、本地网页向导形态、同意把本地 40 个提交 push 到 `origin/master`。

设计审查后的三项定稿决策（用户拍板）：
- **平台仅 Linux x64**：引擎 v0.5.13 的 `fetch-node.mjs` 只支持 `win32`/`linux`，`node-pty`/`adb` 均为 Linux x64 二进制，macOS 实际不可用。README 与 release notes 明确写 Linux-only，Windows/macOS 不支持。
- **自举安装到固定目录** `~/.local/share/phone-screen-link`：稳定持久化 `engine/`、配置、`start.sh`；重复运行若已安装则直接启动，不覆盖用户数据。
- **项目自身代码采用 MIT 许可证**，新增 `LICENSE` 文件随发布包分发（与 GPL-3.0 引擎独立）。

## 目标 / 非目标

- 目标：普通用户在 Linux x64 上，通过网页向导完成从零到投屏页打开；失败有可读提示和修复建议。
- 目标：Release 可被 `curl .../install.sh | bash` 一行自举，也可下载 tar.gz 手动解压运行。
- 非目标：Windows/macOS 支持（明确不支持）；不打包 `engine/`、`node_modules/`、`state/`；不做 Docker 镜像；不做应用内升级。
- 非目标：不改现有 `npm run setup` / `npm start` 的行为——向导只是调用它们。

## 约束

- 引擎 `engine/` 是 GPL-3.0 外部依赖，仍由 `npm run setup` 联网克隆+构建，安装包**不含**引擎二进制。README 已有的开源声明在 release notes 中重申，附引擎上游与许可证链接。
- 聊天 API Key 只写 `state/chat.json`（0600），向导不回显、不进日志。
- 向导服务只绑 `127.0.0.1`，用一次性 token 防本机其它网页的 CSRF。
- 当前 `master` 领先 `origin/master` 40 提交；发布前必须 push。

## 组件

| 文件 | 职责 |
| --- | --- |
| `install.sh` | POSIX shell 薄引导器。两种用法：在解压后的项目目录里运行（直接起向导）；或用 `curl`/wget 单独下载后运行（从 GitHub Release 下载 tar.gz 到临时目录并自举）。检测 `python3`，拒绝 Windows，最终 `exec python3 installer/server.py`。 |
| `installer/server.py` | Python 标准库本地 HTTP 服务（仅 `http.server`、`subprocess`、`threading`、`secrets`、`webbrowser` 等）。只绑 127.0.0.1，随机端口。生成一次性 token，注入向导页面；所有写操作 API 校验 token。 |
| `installer/web/index.html` | 单文件网页向导（内联 CSS/JS）。四步：环境检测 → 安装依赖/构建引擎 → 可选聊天配置 → 启动并打开投屏页。轮询 `GET /api/state` 显示实时日志与进度；失败显示错误与建议。 |
| `scripts/make-release.sh` | 构建发布包 `phone-screen-link-1.0.0.tar.gz`：排除 `node_modules/`、`engine/`、`state/`、`.git/`、`.superpowers/`、`.worktrees/`、`docs/screenshots/`（截图大且非运行必需，README 图片发 GitHub 后仍可显示——需确认；保守做法保留 screenshots）。 |
| `README.md` | 顶部加「一键安装」章节（两种方式），保留手动安装说明，补充平台范围与 GPL 声明。 |
| `tests/installer_test.py` | Python unittest：token 校验、环境检测结果解析、聊天配置写入格式与 0600、PHONE_SERIAL 注入。 |

## 向导 API（都在 127.0.0.1，写操作带 token）

- `GET /` → 注入 token 的向导页面
- `GET /api/state` → 当前步骤、各检查结果、实时日志尾部
- `POST /api/detect` → 检测 OS/架构、node/npm、python3、adb、uv/uvx、USB 设备、端口占用；Windows 直接返回不支持
- `POST /api/install` → 后台线程执行 `npm install`、`npm run setup`，流式日志写入 state，前端轮询展示
- `POST /api/config` → 可选：写 `state/chat.json`（enabled/baseUrl/model/apiKey/screenshot/maxSteps，0600）与 `state/installer.json`（PHONE_SERIAL）
- `POST /api/start` → 带 PHONE_SERIAL 环境变量后台启动 `npm start`，轮询 `/health` 直到 online 或超时
- `POST /api/open` → 打开 `http://127.0.0.1:8000/`
- `POST /api/quit` → 停止向导服务（不影响已启动的应用）

## 自举流程

1. 仓库里放 `install.sh` 与 `installer/`，tag `v1.0.0` 后 raw URL 才可用。
2. 用户在完整目录里 `./install.sh`：脚本检测到同目录有 `installer/server.py` → 直接启动。
3. 用户 `curl -fsSL https://raw.githubusercontent.com/zhang-lijie/phone-screen-link/v1.0.0/install.sh | bash`：脚本检测不在项目目录 → 检查固定目录 `~/.local/share/phone-screen-link` 是否已装：已装则直接启动向导；未装则用 GitHub Release API 取 `v1.0.0` 的 tar.gz，下载到临时目录解压后移动到固定目录，再启动向导。用户数据（engine/、state/、start.sh）因此持久。
4. 向导服务启动后 `webbrowser.open(url)`，URL 形如 `http://127.0.0.1:<port>/#token=<token>`，token 只在 fragment；JS 从 `location.hash` 读取并以 header 发送，绝不进 query 或日志。无 `DISPLAY`/headless 时打印完整 URL 作为兜底。

## 实现约束（审查补充）

- token 为**每个服务会话一个**，不是每请求一个（向导会发多次写请求）；所有写 API 校验 header token + `Host`/`Origin` 防 DNS rebinding。
- `POST /api/detect` 增加 `git` 检查（`setup.mjs` 用 `git clone`）；系统 `adb` 缺失视为警告——引擎自带 `engine/dependencies/adb`，`POST /api/start` 与 `start.sh` 需把它前置到 `PATH`。
- 日志缓冲用加锁的 `deque(maxlen=200)`；`/api/config` 请求体绝不写日志；`state/installer.json`、`installer-start.log` 也用 0600；失败时清理 `.tmp`。
- 聊天配置写入镜像 `chat-config.mjs`：mkdir `state/`、tmp 文件 0600 + `os.replace`、清理陈旧 `.tmp`；`maxSteps` clamp 到 1..100（README 里 1..32 的说法同步修正）；重跑时合并已有文件，空 `apiKey` 保留旧值。
- 健康检查地址是桥 `http://127.0.0.1:8100/health`；`/api/open` 打开引擎 8000。
- 发布包从 tag 构建（`git archive v1.0.0`）避免工作树脏数据：单一顶层目录、`install.sh` 保留可执行位、排除 `tests/` 与 `*.log`、保留 `package-lock.json` 与 `docs/screenshots/`；发布后实测那行 `curl | bash`。
- 发布流程末尾增加：`gh release create` 后验证资产可下载、tar.gz 可解压、一行命令实际跑通。

## 启动脚本

- 向导 `start` 步骤用 `start_new_session=True` 后台起 `npm start`，把 env `PHONE_SERIAL` 从 `state/installer.json` 注入，stdout/stderr 重定向到 `state/installer-start.log`。
- 同时生成项目根的 `start.sh`（读取 `state/installer.json` 注入 PHONE_SERIAL 后 `exec npm start`），供用户以后一键启动，README 说明。

## 发布流程（实施阶段）

1. `git push origin master`（40 个提交）
2. `git tag v1.0.0 && git push origin v1.0.0`
3. `bash scripts/make-release.sh` 生成 `phone-screen-link-1.0.0.tar.gz`
4. `gh release create v1.0.0 phone-screen-link-1.0.0.tar.gz --title "v1.0.0 — 一键安装向导" --notes <release notes>`
5. 验证：`gh release view v1.0.0`、浏览器打开 release 页、下载 tar.gz 本地试解压并跑一次 `install.sh`（用现有环境，向导会检测到依赖已装）。

## 测试策略

- Python unittest 覆盖可纯逻辑测试部分（token、检测结果解析、配置写入、serial 注入）。
- 端到端：本地起 `installer/server.py`，用 ego-browser 打开向导 URL，走一遍四步（安装步骤在当前环境会快速跳过/成功），确认最终能打开投屏页。
- 发布后验证 release 资产可下载、tar.gz 可解压。

## 待办边界（builder 决定/实施者决定）

- 端口占用处理：向导服务随机端口即可；投屏端口 8000/8100 被占用时检测步骤报 error 并给建议（不自动杀进程）。
- 向导日志缓冲：保留最近 200 行，前端只取尾部，避免内存无限增长。
