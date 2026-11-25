# USB-Assisted Wireless Auto-Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a USB-assisted “Auto fetch” action that fills wireless pairing/connection endpoints without enumerating USB devices or reading the pairing code.

**Architecture:** ADB helpers read the phone IP and TLS connect port over the configured USB serial, then poll host mDNS for the pairing endpoint. The connection service exposes partial results without mutating active state; the bridge adds `usbOnline` and an auto-fetch endpoint; the modal fills and persists the form.

**Tech Stack:** Node ESM, `node:test`, ADB CLI/mDNS, plain HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-11-26-usb-wireless-auto-config-design.md`

## Global Constraints

- USB availability uses `adb -s <usbSerial> get-state`; never `adb devices`.
- Pairing code is never read, logged, persisted by the backend, or included in auto-fetch requests/responses.
- Auto-fetch never changes active mode/serial or persisted connection config.
- Partial success is valid and must preserve fields already fetched.
- Existing localStorage form persistence remains unchanged.
- Bridge remains loopback-only with existing Origin checks.

## Review Focus

- USB serial offline: return 409 without shell/mDNS work.
- Wireless debugging disabled: return IP-only partial data with actionable warnings.
- Pairing dialog not open: poll up to 8s, then return connect data without pair port.
- Multiple mDNS devices on the LAN: match the USB phone IP, not an arbitrary pairing service.
- Auto-fetch during wireless mode: targeted USB `get-state` is allowed, but no device enumeration or mode change.

---

### Task 1: ADB discovery and parsing primitives

**Files:**
- Modify: `server/adb.mjs`
- Test: `tests/adb.test.mjs`

**Interfaces:**
- Produces: `parseWifiIp(text)` and `parseMdnsServices(text)`.
- Produces ADB methods `getWifiIp(serial)`, `getWirelessConnectPort(serial)`, `mdnsServices()`.

- [ ] **Step 1: Write failing parser/command tests**

Cover `ip addr` parsing, `ip route` fallback, numeric TLS port validation, mDNS pairing/connect parsing, and exact ADB argument arrays.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/adb.test.mjs`

- [ ] **Step 3: Implement helpers**

Use targeted `-s <serial> shell` commands. `getWifiIp()` tries `ip -f inet addr show wlan0`, then `ip route show dev wlan0`. `getWirelessConnectPort()` reads `getprop service.adb.tls.port`. `mdnsServices()` runs `adb mdns services` and returns structured entries.

- [ ] **Step 4: Run full suite and commit**

Commit: `feat: read wireless endpoints over usb adb`

---

### Task 2: Auto-discovery service and bridge API

**Files:**
- Modify: `server/connection-service.mjs`
- Modify: `server/bridge.mjs`
- Test: `tests/connection-service.test.mjs`, `tests/bridge.test.mjs`

**Interfaces:**
- Produces: `connectionService.discoverWirelessConfig()`.
- Produces: `POST /api/wireless/auto`.
- `GET /api/wireless` adds `usbOnline`.

- [ ] **Step 1: Write failing service tests**

Cover USB offline, IP-only partial result, connect-port property, mDNS connect fallback, pairing-port poll success/timeout, same-IP filtering, and unchanged active/persisted state.

- [ ] **Step 2: Write failing bridge tests**

Cover 409 when USB offline, 200 full/partial payloads, 502 on ADB failure, Origin/preflight, `usbOnline` in status, and no pairing-code field.

- [ ] **Step 3: Verify RED**

Run: `node --test tests/connection-service.test.mjs tests/bridge.test.mjs`

- [ ] **Step 4: Implement discovery orchestration and route**

Poll mDNS every 500ms up to 8000ms with injectable sleep for tests. Match endpoints by the USB phone IP. Return warnings for missing ports; do not throw on partial success.

- [ ] **Step 5: Run full suite and commit**

Commit: `feat: expose usb-assisted wireless auto fetch`

---

### Task 3: Auto-fetch button and modal integration

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/styles.css`
- Modify: `shared/keys.mjs`
- Modify: `README.md`
- Test: `tests/ui-wireless.test.mjs`

**Interfaces:**
- Consumes: `POST /api/wireless/auto` and `usbOnline`.
- Produces: `#wireless-auto` button, loading/disabled state, partial-result feedback.

- [ ] **Step 1: Write failing UI tests**

Assert button presence, disabled without `usbOnline`, API call, field filling, localStorage save, pairing-code focus, partial-result warning, and no pairing request from auto-fetch.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/ui-wireless.test.mjs`

- [ ] **Step 3: Implement UI and copy**

Add bilingual labels/hints. Auto-fetch uses the existing request guard, saves fetched fields, focuses `pairCode`, and displays warnings. It must not call the pair endpoint.

- [ ] **Step 4: Run full suite and Chrome checks**

Verify button enable/disable, mocked full/partial responses, persistence, and focus. Live device verification follows after service restart.

- [ ] **Step 5: Commit**

Commit: `feat: add usb-assisted wireless auto fetch button`
