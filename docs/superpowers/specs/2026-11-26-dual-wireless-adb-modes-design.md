# 双模式无线 ADB 调试

## 意图

无线调试面板同时支持：

- Android 11+ TLS 配对码模式；
- 传统 `adb tcpip 5555` 无配对码模式，适用于 EMUI 等不提供配对码弹窗的设备。

## 目标 / 非目标

- 目标：用户可在面板选择模式；传统模式可通过 USB 自动读取 IP、开启 TCP 模式并连接；两种模式都复用现有无线监督与切回 USB。
- 非目标：不实现二维码配对、mDNS 自动发现传统端口、跨设备同步；不修改 scrcpy 引擎。

## 约束

- 传统模式明确提示“未加密、无认证，仅可信局域网”。
- 传统模式的开启必须由用户点击按钮触发，不在后台静默执行。
- 无线模式下仍不调用 `adb devices`；USB 存在性只用目标 serial 的 `get-state`。
- 现有配对码 localStorage 持久化保留。
- 连接切换继续走串行事务，失败不改变当前活动连接。

## 方案

### 配置

`state/connection.json` 增加可选 `method`：

```json
{ "mode": "wifi", "method": "legacy", "address": "192.168.3.123:5555" }
```

旧配置缺少 `method` 时默认为 `pair`；现有地址仍可正常维护。

### 面板

顶部增加模式选择：

- “Android 11+ 配对码”
- “传统 5555（无需配对码）”

配对码模式保留现有字段与“自动获取”。

传统模式显示：

- IP 输入（USB 在线时可通过“自动获取并连接”填充）。
- 端口输入，默认 `5555`。
- “自动获取并连接”按钮：USB 在线时可用。
- “连接”按钮：用于 TCP 模式已经开启的情况。
- 独立安全警告。

选择模式与字段继续存入现有 `phone-link-wireless-pairing` localStorage。

### 后端

新增 `POST /api/wireless/legacy`：

```json
{ "host": "192.168.3.123", "port": 5555, "enableTcpip": true }
```

流程：

1. 校验 host/port。
2. `enableTcpip=true` 时先检查 USB serial 在线，再执行 `adb -s <usb> tcpip <port>`。
3. 执行 `adb connect host:port`。
4. 确认目标在线。
5. 通过现有串行事务持久化并激活 `{mode:"wifi", method:"legacy", address}`。
6. 返回与现有无线接口一致的状态。

`enableTcpip=false` 时不要求 USB，可直接连接已开启的 TCP 模式。

### 无线监督

维护地址时先尝试 `adb connect`；如果失败且配置为 `method:"legacy"`，再检查目标 USB serial：

- USB 在线：执行一次 `adb tcpip <port>` 后重连；
- USB 不在线：保持离线，等待下一次重试。

避免每 5 秒重复重启 adbd。

## 验证

- 单测覆盖 legacy 命令顺序、USB 离线、连接失败回滚、串行事务、监督重连、配置兼容。
- 面板测试覆盖模式切换、字段显隐、按钮可用性、localStorage、安全警告。
- 真机验证当前 EMUI 设备自动开启 5555、连接、投屏、拔 USB 后维持、切回 USB。
