# USB Switch Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the wireless panel's "Switch to USB" button disconnect the active wireless endpoint, scan USB devices immediately, and select one via the existing policy (or open the picker when ambiguous).

**Architecture:** `adb.disconnect()` is a new primitive. `connectionService.switchToUsb()` becomes an async, serialized scan-and-select operation that uses `adb.listDevices()` and `chooseDevice()`; it updates `adb.setConnection()` so ghost, keys, chat and the page follow. The bridge passes `selected`/`devices` back; the page either restarts with that serial or opens the device picker.

**Tech Stack:** Node ESM, `node --test`, static UI source checks.

**Spec:** `docs/superpowers/specs/2026-11-26-usb-switch-scan-design.md`

## Global Constraints

- Do not change pairing/legacy connect flows or `supervise()`'s single-device adoption rule.
- `PHONE_SERIAL` remains the *preferred* serial, not a fixed target.
- No auto-unlock; only disconnect a wireless transport and select a USB device.
- Existing upstream wireless tests must keep passing; extend payloads additively.

## Review Focus

- A failed `adb disconnect` must not block switching; the endpoint may already be gone.
- If the preferred serial is absent and several USB devices exist, `selected` must be `null` and the page must not restart a stale stream — a reasonable user expects the picker.
- `setConnection` must set `usbSerial` to the chosen device so the 5s supervisor cannot revert it.
- The 2s device poll and the switch response must agree on `selected`; no two streams may start.

---

### Task 1: Backend scan-and-select on switchToUsb

**Files:** `server/adb.mjs`, `server/connection-service.mjs`, `server/bridge.mjs`, `tests/adb.test.mjs`, `tests/connection-service.test.mjs`, `tests/bridge.test.mjs`

**Interfaces:**
- `adb.disconnect(address) -> Promise<void>`
- `connectionService.switchToUsb() -> Promise<{ mode, method, serial, online, usbOnline, selected, devices }>`
- `POST /api/wireless/usb` → `200 { ok, mode, method, serial, online, usbOnline, selected, devices }`

- [ ] **Step 1: Write failing tests** for `disconnect`, for switch scanning/disconnecting/selecting (including ambiguous multi-device → `selected:null`), and for the extended bridge response.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** `adb.disconnect`, rewrite `switchToUsb`, extend `wirelessStatusPayload`/route.
- [ ] **Step 4: Run `npm test`** — all suites green.
- [ ] **Step 5: Commit** `feat(usb): scan and select a device when leaving wireless mode`.

### Task 2: Frontend uses the scan result

**Files:** `web/app.js`, `tests/ui-app-harness.mjs` (or a new UI source test)

**Interfaces:** consumes `POST /api/wireless/usb` payload `{ selected, devices }`; uses existing `activateDevice`, `restartStream`, `refreshDevices`, `openDevicePicker`.

- [ ] **Step 1: Write a failing test** asserting `switchToUsb()` branches on `payload.selected`: non-null → `activateDevice` + `restartStream`; null → `refreshDevices` + `openDevicePicker`, and no stale `restartStream`.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement** the branch in `web/app.js`.
- [ ] **Step 4: Run `npm test`** — all suites green.
- [ ] **Step 5: Sync to the live install, restart, and verify** with a headless browser that switching back to USB selects the connected phone and no wireless endpoint remains in `adb devices`.
- [ ] **Step 6: Commit** `feat(ui): open device picker when USB switch is ambiguous`.
