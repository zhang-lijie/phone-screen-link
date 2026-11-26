# Dual Wireless ADB Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the wireless panel choose between Android 11+ pairing-code mode and legacy no-code `adb tcpip` mode.

**Architecture:** Connection config gains an optional `method`; ADB/service code can bootstrap and maintain legacy TCP endpoints; the bridge exposes a serialized legacy-connect route; the modal switches between the two forms.

**Tech Stack:** Node ESM, `node:test`, ADB CLI, plain HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-11-26-dual-wireless-adb-modes-design.md`

## Global Constraints

- Traditional mode must show an explicit unencrypted/unauthenticated warning.
- `adb tcpip` runs only from a user-triggered legacy connect or a failed legacy reconnect while USB is online.
- Wireless mode never calls `adb devices`; USB availability uses targeted `get-state`.
- Connection mutations remain serialized and failure-atomic.
- Existing pairing-code localStorage persistence remains intact.
- Old `{mode,address}` configs remain valid and default to `method:"pair"`.

## Review Focus

- Legacy connect with USB offline and `enableTcpip:true`: 409 before any network mutation.
- `adb tcpip` succeeds but `adb connect` fails: previous active/persisted connection remains unchanged.
- Legacy wireless drops with USB present: one bootstrap attempt, not repeated adbd restarts every 5s.
- Phone reboot with no USB: legacy reconnect fails safely and remains offline.
- UI mode switch must not clear or leak the saved pairing code.

---

### Task 1: Legacy config, ADB bootstrap, and supervision

**Files:**
- Modify: `server/connection-config.mjs`
- Modify: `server/adb.mjs`
- Test: `tests/connection-config.test.mjs`, `tests/adb.test.mjs`

**Interfaces:**
- Config adds `method: 'pair' | 'legacy'`.
- `createAdb()` adds `tcpip(serial, port)`.
- Wireless maintenance accepts method/port and can bootstrap once when connect fails and USB is online.

- [ ] **Step 1: Write failing tests**

Cover old-config compatibility, method persistence, exact `tcpip` command, legacy maintenance connect→bootstrap→retry, no-USB offline behavior, and no repeated bootstrap after success.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/connection-config.test.mjs tests/adb.test.mjs`

- [ ] **Step 3: Implement config/ADB/supervision support**

Keep pair mode unchanged. Parse legacy port from the configured address. Track bootstrap attempts per outage so a healthy connection is not restarted every tick.

- [ ] **Step 4: Run full suite and commit**

Commit: `feat: support legacy tcpip wireless maintenance`

---

### Task 2: Legacy connection service and bridge route

**Files:**
- Modify: `server/connection-service.mjs`
- Modify: `server/bridge.mjs`
- Test: `tests/connection-service.test.mjs`, `tests/bridge.test.mjs`

**Interfaces:**
- Produces: `connectionService.connectLegacy({ host, port, enableTcpip })`.
- Adds `POST /api/wireless/legacy`.
- Wireless status includes `method`.

- [ ] **Step 1: Write failing service/API tests**

Cover validation, USB-offline 409 when bootstrap is requested, command order, connect failure rollback, serialized mutations, status method, Origin/preflight, and no unexpected fields.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/connection-service.test.mjs tests/bridge.test.mjs`

- [ ] **Step 3: Implement serialized legacy transaction**

Persist and activate `{mode:"wifi", method:"legacy", address}` only after the target is online. Reuse existing mutation queue/status handling.

- [ ] **Step 4: Run full suite and commit**

Commit: `feat: expose legacy wireless connect API`

---

### Task 3: Dual-mode panel and documentation

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/styles.css`
- Modify: `shared/keys.mjs`
- Modify: `README.md`
- Test: `tests/ui-wireless.test.mjs`

**Interfaces:**
- Adds mode selector, legacy host/port fields, auto-connect and connect actions.
- Uses `POST /api/wireless/legacy`.
- Persists selected method and legacy fields alongside existing pair fields.

- [ ] **Step 1: Write failing UI tests**

Cover mode switching, field visibility, default port 5555, USB-gated auto-connect, manual connect without USB, localStorage, security warning, success restart, and failure feedback.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/ui-wireless.test.mjs`

- [ ] **Step 3: Implement panel and copy**

Keep pairing mode intact. Legacy mode has its own warning and actions. Successful legacy connect updates `DEVICE_ID` and restarts the stream only after an online wifi response.

- [ ] **Step 4: Run full suite and Chrome checks**

Verify both mode forms, warnings, persistence, disabled states, and mocked success/failure.

- [ ] **Step 5: Commit**

Commit: `feat: add dual wireless debugging modes`
