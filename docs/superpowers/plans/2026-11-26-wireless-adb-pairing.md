# Wireless ADB Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app Android 11+ wireless ADB pairing flow and stop all USB probing while wireless mode is active.

**Architecture:** A connection config store and dynamic ADB serial become the source of truth for startup, bridge, and ghost. The bridge exposes pairing/switch APIs; the page adds a toolbar-launched modal and persists the pairing form in browser `localStorage` as requested.

**Tech Stack:** Node ESM, `node:test`, Python installer tests, plain HTML/CSS/JavaScript, ADB CLI, Chrome verification.

**Spec:** `docs/superpowers/specs/2026-11-26-wireless-adb-pairing-design.md`

## Global Constraints

- Default USB behavior remains unchanged.
- Wireless mode must not call `ensureUsbOnly()` or enumerate devices with `adb devices`.
- Pairing code is never logged or written to backend config; the frontend persists it in `localStorage` under `phone-link-wireless-pairing` with a clear warning and clear button.
- Pair/connect failure must not change the active device or persisted address.
- Bridge stays loopback-only and keeps existing Origin checks.
- `PHONE_SERIAL=IP:port` automatically selects wireless mode.
- The scrcpy engine is not modified.

## Review Focus

- Pair succeeds but connect fails: original USB connection and config must remain intact.
- Wireless connection drops: only the configured address is retried; no USB enumeration occurs.
- USB enforcement is in flight when mode changes: it must not perform a late `disconnect`.
- Invalid host/port/code: return a clear 400 and never echo the pairing code.
- Saved browser pairing code expires: the UI explains this without breaking an already-connected wireless device.

---

### Task 1: Connection config and ADB pairing primitives

**Files:**
- Create: `server/connection-config.mjs`
- Modify: `server/adb.mjs`
- Test: `tests/connection-config.test.mjs`, `tests/adb.test.mjs`

**Interfaces:**
- Produces: `createConnectionConfigStore({ file })` → `{ load, save, publicConfig }`.
- Produces: `resolveInitialConnection({ env, stored, usbSerial })` → `{ mode: 'usb' | 'wifi', serial: string }`.
- Produces: `createAdb(runner, { serial, mode })` with `getSerial()`, `getMode()`, `setConnection({ mode, serial })`, `pair({ host, port, code })`, `connect(address)`, `getState(serial)`, `ensureWirelessConnected(address)`.

- [ ] **Step 1: Write failing connection-config tests**

Cover default USB config, save/load wireless address, malformed-file fallback, atomic 0600 write, and `PHONE_SERIAL=IP:port` selecting wireless mode.

- [ ] **Step 2: Write failing ADB tests**

Assert `pair` runs `['pair', 'host:port', code]`, `connect` runs `['connect', address]`, `getState` runs `['-s', serial, 'get-state']`, dynamic serial is used by key/lock/timeout commands, and `ensureWirelessConnected()` never calls `devices`.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node --test tests/connection-config.test.mjs tests/adb.test.mjs`
Expected: missing exports/methods.

- [ ] **Step 4: Implement config store and ADB primitives**

Use `state/connection.json` with `{ mode: 'usb' | 'wifi', address: string }`. Keep existing `list()`/`ensureUsbOnly()` for USB mode. All device-specific commands read the mutable active serial.

- [ ] **Step 5: Run full suite and commit**

Run: `npm test`
Commit: `feat: add wireless adb connection primitives`

---

### Task 2: Dynamic ghost serial and USB-race guard

**Files:**
- Modify: `server/adb.mjs`
- Modify: `server/ghost-client.mjs`
- Test: `tests/adb.test.mjs`, `tests/ghost-client.test.mjs`

**Interfaces:**
- Consumes: `getSerial()`/`getMode()` from Task 1.
- Produces: `createGhostClient({ getSerial, env })`, retaining `{ serial }` compatibility.

- [ ] **Step 1: Write failing ghost test**

After `setConnection()` changes the serial, the next `callTool()` must inject the new address.

- [ ] **Step 2: Write failing USB-race test**

`ensureUsbOnly()` starts in USB mode, `list()` resolves after mode changes to wireless, and no `disconnect` command may run.

- [ ] **Step 3: Verify RED**

Run: `node --test tests/adb.test.mjs tests/ghost-client.test.mjs`

- [ ] **Step 4: Implement dynamic provider and double mode check**

`ghost-client` resolves the serial on every tool call. `ensureUsbOnly()` checks mode before listing and again before disconnecting.

- [ ] **Step 5: Run full suite and commit**

Commit: `fix: follow active adb device without usb races`

---

### Task 3: Connection service and startup mode

**Files:**
- Create: `server/connection-service.mjs`
- Modify: `scripts/start.mjs`
- Test: `tests/connection-service.test.mjs`, `tests/start.test.mjs`

**Interfaces:**
- Produces: `createConnectionService({ adb, store, usbSerial })` → `{ status, pairAndConnect, switchToUsb }`.
- `pairAndConnect(input)` validates, pairs, connects, confirms online, then switches and persists.

- [ ] **Step 1: Write failing service tests**

Cover successful pair/connect/switch, pair failure, connect failure, offline-after-connect, validation failure, and pairing-code redaction from errors.

- [ ] **Step 2: Write failing startup tests**

USB mode calls `ensureUsbOnly()` at startup and on the 5s timer. Wireless mode skips it and calls `ensureWirelessConnected()`. A live mode change is honored by the next timer tick. Ghost receives `getSerial`.

- [ ] **Step 3: Verify RED**

Run: `node --test tests/connection-service.test.mjs tests/start.test.mjs`

- [ ] **Step 4: Implement service and startup branching**

Load `state/connection.json`, resolve env overrides, set the initial ADB connection before engine spawn, and choose the timer behavior from the current mode on every tick.

- [ ] **Step 5: Run full suite and commit**

Commit: `feat: supervise usb and wireless adb modes`

---

### Task 4: Bridge pairing APIs

**Files:**
- Modify: `server/bridge.mjs`
- Test: `tests/bridge.test.mjs`

**Interfaces:**
- Adds `GET /api/wireless`.
- Adds `POST /api/wireless/pair` with `{ pairHost, pairPort, pairCode, connectHost, connectPort }`.
- Adds `POST /api/wireless/usb`.
- `/health` returns dynamic `serial` and `mode`.

- [ ] **Step 1: Write failing API tests**

Cover status, successful pairing response, invalid body 400, ADB failure 502, cross-origin POST 403, preflight, dynamic health serial, and no pairing code in responses/errors.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/bridge.test.mjs`

- [ ] **Step 3: Implement validation and routes**

Validate IPv4/hostname, ports 1–65535, and `/^\d{6}$/`. Redact the pairing code from any surfaced error. Keep response shapes small and explicit.

- [ ] **Step 4: Run full suite and commit**

Commit: `feat: expose wireless pairing through the bridge`

---

### Task 5: Toolbar button, modal, and browser persistence

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/styles.css`
- Modify: `shared/keys.mjs`
- Test: `tests/ui-wireless.test.mjs`

**Interfaces:**
- Adds `.wireless-button` beside `.settings-button`.
- Adds `#wireless-overlay` with pair host/port/code, connect host/port, submit, USB, clear, status, and warning elements.
- Uses `localStorage['phone-link-wireless-pairing']`.
- Calls `GET /api/wireless`, `POST /api/wireless/pair`, `POST /api/wireless/usb`.

- [ ] **Step 1: Write failing UI source-contract tests**

Assert button injection, modal fields, storage key, save/load/clear helpers, API paths, successful device update + stream restart, USB switch, and bilingual warning strings.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/ui-wireless.test.mjs`

- [ ] **Step 3: Implement HTML/CSS/JS/i18n**

Keep the wireless button out of engine-label translation loops. Persist all form fields, including pairing code, to `localStorage`; provide clear button. On success update `DEVICE_ID`/`window.__PHONE_SERIAL` and call the existing stream restart path.

- [ ] **Step 4: Run full suite**

Run: `npm test`

- [ ] **Step 5: Verify in Chrome**

Check toolbar button, modal, localStorage reload persistence, clear action, error display, successful mode switch, and automatic stream restart. Pairing with a real device is Task 6.

- [ ] **Step 6: Commit**

Commit: `feat: add wireless debugging pairing panel`

---

### Task 6: Documentation and device smoke test

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update documentation**

Document Android 11+ pairing steps, the two ports, browser localStorage security warning, wireless-mode USB behavior, and switching back to USB.

- [ ] **Step 2: Run all automated tests**

Run: `npm test` and the Python installer suite.

- [ ] **Step 3: Real-device smoke test**

Verify pair/connect, mirroring, touch, key controls, ghost chat, operation with USB unplugged, browser restart persistence, wireless reconnect, and switch back to USB. If no device is available, report the exact unverified steps.

- [ ] **Step 4: Commit**

Commit: `docs: document wireless adb pairing`
