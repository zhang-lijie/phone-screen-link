# 切回 USB 时立即扫描设备 — 设计

**Approved:** 2026-11-26（用户选择方案 A）
**Intent:** 点击无线面板的「切回 USB」后，不再盲目回到固定序列号，而是一次原子操作：断开当前无线端点，立即通过 `adb devices -l` 扫描 USB 设备，按现有策略选中设备，让画面/按键/聊天指向同一台；多台时交给页面选择器。

## 现状问题（已查证）

- `switchToUsb()` 使用服务启动时固定的 `usbSerial`，不扫描；对不在线的序列号报 `online:false`，页面仍去连它。
- `ensureUsbOnly()` 只断开写死的 `192.168.3.123:5555`；真实的 `192.168.1.19:5555` 仍留在 `adb devices`。
- 只有 5 秒后的 `supervise()` 才扫描，且「恰好一台 USB 设备」才接管，多台故意不处理。
- `/api/devices` 选择器不在这条路径上被调用。

## 方案 A

### 后端

1. `adb` 新增 `disconnect(address)` → `runner(['disconnect', address])`。
2. `connectionService.switchToUsb()` 在 `serializeMutation` 内：
   - 若当前 `mode==='wifi'`，断开当前无线 serial（失败只告警，不阻断）；
   - 用 `adb.listDevices()`（长格式 `devices -l`）扫描 USB；不可用时退回 `adb.list()` 包装成 `{serial, selectable:true}`；
   - `chooseDevice({ devices, selected: null, preferred: usbSerial })` 决定 serial；
   - 保存 `{mode:'usb', method:'pair', address:''}`；`adb.setConnection({mode:'usb', serial: chosen ?? usbSerial, usbSerial: chosen ?? usbSerial})`，使 `supervise` 不再覆盖；
   - 返回 `committedStatus('usb', chosen ?? usbSerial, false)` 并附带 `selected`（chosen，可为 null）与 `devices`。
3. `/api/wireless/usb` 的响应 payload 增加 `selected` 与 `devices`，保留既有字段。

### 前端

`web/app.js switchToUsb()` 成功分支：

- `applyWirelessStatus(payload)` 后若 `payload.selected` 非空 → `activateDevice(selected)` + `restartStream()` + `wireless.usbConnected`；
- 若为 `null` → 不重启旧流，调用 `refreshDevices()` 刷新列表并 `openDevicePicker()`，状态提示交给设备选择器（多台）或「等待手机连接」（0 台）。

### 不做的

- 不改无线配对/legacy 流程，不改 `supervise` 的多设备策略（它仍只接管唯一设备）；
- 不自动解锁手机，不绕过锁屏；
- 不改 `PHONE_SERIAL` 语义（仍是首选序列号）。

## 验证

- `tests/adb.test.mjs`：`disconnect` 调用参数。
- `tests/connection-service.test.mjs`：切回 USB 时断开真实无线端点、按策略选设备、多台且首选不在线时 `selected:null`、单台自动选。
- `tests/bridge.test.mjs`：`/api/wireless/usb` 响应含 `selected`/`devices`。
- `npm test`、`python3 -m unittest discover -s tests -p '*_test.py'` 全绿。
- 真机/手工：无线在线时点「切回 USB」，`adb devices` 不再有该无线端点，正确选中当前 USB 手机；多台时弹选择器。
