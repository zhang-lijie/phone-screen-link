# USB 辅助自动获取无线调试配置

## 意图

在无线调试面板增加“自动获取”按钮：USB 手机在线时可用；点击后通过 USB ADB 自动读取 Wi‑Fi IP、连接端口，并在手机配对码弹窗打开后通过 mDNS 获取配对端口，自动填回面板。6 位配对码仍由用户手动输入。

## 目标 / 非目标

- 目标：减少手工填写 IP/端口；只自动读取 Android 允许 ADB 获取的信息；USB 可用性判断不枚举设备列表。
- 非目标：不读取或破解配对码；不修改 scrcpy 引擎；不实现二维码配对；不在无线模式下恢复 `adb devices` 探测。

## 约束

- 继续使用现有桥接 Origin 防护与 loopback 绑定。
- 配对码不进入自动获取请求、日志或后端配置。
- 自动获取失败不得改变当前活动设备或连接模式。
- USB 在线判断使用 `adb -s <usbSerial> get-state`。
- 面板已有 localStorage 持久化行为保持不变。

## 方案

### UI

在“配对（Android 11+）”分组标题附近增加“自动获取”按钮：

- `usbOnline === true` 且非 busy 时可点击。
- 点击后显示 loading，调用 `POST /api/wireless/auto`。
- 成功填回 `pairHost`、`pairPort`、`connectHost`、`connectPort`，并保存到现有 localStorage。
- 自动聚焦配对码输入框。
- 若只拿到部分信息，保留已获取字段并显示明确提示；不发起配对。

### 后端自动获取流程

1. 用配置的 USB serial 执行 `get-state`，不在线则返回 409。
2. 通过 USB shell 读取 Wi‑Fi IP：
   - 首选 `ip -f inet addr show wlan0`，解析 `inet` 地址；
   - 回退 `ip route show dev wlan0`，解析 `src`。
3. 读取连接端口：
   - 首选 `getprop service.adb.tls.port`；
   - 为空时轮询 `adb mdns services`，匹配同 IP 的 `_adb-tls-connect._tcp`。
4. 轮询 `adb mdns services` 最多 8 秒，匹配同 IP 的 `_adb-tls-pairing._tcp`。
5. 返回完整或部分配置：
   ```json
   {
     "usbSerial": "...",
     "pairHost": "192.168.x.x",
     "pairPort": 12345,
     "connectHost": "192.168.x.x",
     "connectPort": 23456,
     "warnings": []
   }
   ```
6. 用户输入配对码后，仍走现有 `POST /api/wireless/pair`。

### 状态接口

`GET /api/wireless` 增加 `usbOnline`，通过目标 USB serial 的 `get-state` 获取，不调用 `adb devices`。

## 考虑过但未采用

- 只读取 IP、端口手填：自动化不足。
- 尝试通过 USB 读取配对码：Android 不暴露，且会破坏安全模型。
- 二维码配对：需要额外二维码 UI/协议，超出本次范围。

## 验证

- 单测覆盖 IP/端口解析、mDNS 匹配、USB 离线、部分成功、超时、活动设备不变。
- 桥接测试覆盖自动获取接口、409/502、状态 `usbOnline`、配对码不出现在响应。
- 前端测试覆盖按钮可用性、自动填表、部分结果提示、localStorage 保存。
- 真机验证：USB 在线可点；打开手机配对码弹窗后可获取两个端口；拔掉 USB 后按钮禁用；无线模式下仍不枚举 USB 列表。
