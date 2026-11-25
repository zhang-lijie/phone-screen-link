# Multi-device selection — implementation plan

**Base:** `4037af6` (master). **Branch:** `feat/device-selection`.
**Spec:** the confirmed conversation plan of 2026-11-25 (status-bar entry + modal,
localStorage only, auto-switch when the selected phone is gone and exactly one
authorised device remains).

## Goal

A phone plugged in after startup, or a second phone, must be discoverable and
selectable. The page must follow the selected serial everywhere: video stream,
key events, screen control, and chat tools. A single-device setup keeps working
with zero configuration.

## Global constraints

- `PHONE_SERIAL` (and the installer's `serial`) keeps its meaning as the
  **preferred** device: used when online, otherwise the fallback policy decides.
- Selection lives in the bridge's memory plus the browser's `localStorage`.
  No new backend state file.
- Only USB transports are listed (`adb devices -l` serials without `:`).
- `unauthorized` / `offline` devices are listed but not selectable.
- A missing adb (`ENOENT`) is "not ready yet", never a 500.
- Single-device behaviour and all existing tests must keep passing.
- Every request that targets a device must use the **currently selected**
  serial; with no selection it returns `409 { error: 'device selection required' }`
  and performs no adb action.
- UI text ships in both `en` and `zh`; `tests/shared-keys.test.mjs` enforces
  key parity.

## Interfaces (produced → consumed)

| Producer | Interface | Consumer |
| --- | --- | --- |
| Task 1 | `parseDeviceList(text) -> Device[]`, `adb.listDevices()` | Task 3 |
| Task 1 | `keyEvent(key, serial)`, `isOnline(serial)`, `wakeScreen(serial)`, `getScreenTimeout(serial)`, `setScreenTimeout(ms, serial)`, `isLocked(serial)` | Task 3 |
| Task 2 | `chooseDevice({ devices, selected, remembered, preferred }) -> serial \| null` | Task 3 |
| Task 3 | `GET /api/devices`, `POST /api/devices/select`, `/health.serial`, `onSelectionChange` | Task 4, Task 5 |
| Task 4 | `ghost.setSerial(serial)` | Task 5 (via bridge callback) |
| Task 5 | UI reads `GET /api/devices` | — |

`Device` shape: `{ serial, state, model, product, transport, selectable }`
where `selectable === (state === 'device')`.

---

## Task 1: adb device listing and per-serial calls

**Files:** `server/adb.mjs`, `tests/adb.test.mjs`.

**Steps**

1. Add failing tests to `tests/adb.test.mjs`:

```js
const listedText = `List of devices attached
2FD0221C09004177       device usb:1-5 product:NOH-AN01 model:NOH_AN01 device:HWNOA transport_id:1
192.168.3.123:5555     device product:NOH-AN01 model:NOH_AN01 transport_id:2
R58M12345              unauthorized usb:1-2 transport_id:3
emulator-5554          offline transport_id:4
`;

test('parseDeviceList keeps USB devices with state and model', () => {
  assert.deepEqual(parseDeviceList(listedText), [
    { serial: '2FD0221C09004177', state: 'device', model: 'NOH AN01', product: 'NOH-AN01', transport: 'usb:1-5', selectable: true },
    { serial: 'R58M12345', state: 'unauthorized', model: '', product: '', transport: 'usb:1-2', selectable: false },
    { serial: 'emulator-5554', state: 'offline', model: '', product: '', transport: '', selectable: false },
  ]);
});

test('parseDeviceList tolerates the header-only output', () => {
  assert.deepEqual(parseDeviceList('List of devices attached\n'), []);
});

test('listDevices returns [] when adb is missing', async () => {
  const adb = createAdb(async () => { throw Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }); });
  assert.deepEqual(await adb.listDevices(), []);
});

test('listDevices asks adb for the long format', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return listedText; });
  await adb.listDevices();
  assert.deepEqual(calls[0], ['devices', '-l']);
});

test('per-call serial overrides the default device', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return ''; });
  await adb.keyEvent('home', 'SERIAL-B');
  await adb.isOnline('SERIAL-B');
  assert.deepEqual(calls[0], ['-s', 'SERIAL-B', 'shell', 'input', 'keyevent', '3']);
  assert.deepEqual(calls[1], ['-s', 'SERIAL-B', 'devices']);
});
```

2. Run `npm test -- tests/adb.test.mjs`. Expected: FAIL — `parseDeviceList` is
   not exported / `listDevices` is not a function.

3. Implement in `server/adb.mjs`:
   - `parseDeviceList(text)`: split lines, skip `List of devices attached` and
     blanks, require `fields[1]` to be a known state (`device`, `unauthorized`,
     `offline`, `bootloader`, `recovery`, `sideload`, `connecting`, `authorizing`);
     skip serials containing `:`; read `model=`, `product=`, `usb:`/`transport_id=`
     key/value fields; `model.replace(/_/g, ' ')`; `selectable: state === 'device'`.
   - `parseDevices(text)` keeps its current behaviour (wifi included) for
     `ensureUsbOnly`; implement it as `parseDeviceList` filtered to `device`
     **plus** network serials, or leave the existing implementation untouched.
     Leave it untouched — it has its own test.
   - `listDevices()` in `createAdb`: `const text = await runner(['devices', '-l'])`,
     return `parseDeviceList(text)`; catch `isMissingAdbError` → `[]`.
   - Add an optional trailing `serial = DEFAULT_USB_SERIAL` parameter to
     `keyEvent`, `isOnline`, `wakeScreen`, `getScreenTimeout`,
     `setScreenTimeout`, `isLocked`; use it in the `-s` arguments.

4. Run `npm test -- tests/adb.test.mjs`. Expected: PASS, all tests.

5. Commit: `feat(adb): list USB devices and target a serial per call`.

**Verification:** `npm test -- tests/adb.test.mjs`.

---

## Task 2: selection policy as a pure function

**Files:** `shared/device-selection.mjs` (new), `tests/device-selection.test.mjs` (new).

**Steps**

1. Write the failing test:

```js
import { chooseDevice } from '../shared/device-selection.mjs';

const dev = (serial, selectable = true) => ({ serial, state: selectable ? 'device' : 'unauthorized', selectable });

test('keeps the current selection while it is selectable', () => {
  assert.equal(chooseDevice({ devices: [dev('A'), dev('B')], selected: 'B', remembered: 'A', preferred: 'A' }), 'B');
});

test('falls back to the remembered device', () => {
  assert.equal(chooseDevice({ devices: [dev('A'), dev('B')], selected: null, remembered: 'B', preferred: 'A' }), 'B');
});

test('falls back to the preferred device', () => {
  assert.equal(chooseDevice({ devices: [dev('A'), dev('B')], selected: null, remembered: null, preferred: 'A' }), 'A');
});

test('auto-selects the only selectable device', () => {
  assert.equal(chooseDevice({ devices: [dev('A'), dev('B', false)], selected: null, remembered: null, preferred: null }), 'A');
});

test('returns null when several devices need a choice', () => {
  assert.equal(chooseDevice({ devices: [dev('A'), dev('B')], selected: null, remembered: null, preferred: null }), null);
});

test('ignores remembered/preferred devices that are not selectable', () => {
  assert.equal(chooseDevice({ devices: [dev('A'), dev('B', false)], selected: null, remembered: 'B', preferred: 'B' }), 'A');
});

test('returns null with no devices', () => {
  assert.equal(chooseDevice({ devices: [], selected: 'A', remembered: 'A', preferred: 'A' }), null);
});
```

2. Run `npm test -- tests/device-selection.test.mjs`. Expected: FAIL — module
   not found.

3. Implement `shared/device-selection.mjs`:

```js
export function chooseDevice({ devices = [], selected, remembered, preferred } = {}) {
  const selectable = devices.filter((d) => d.selectable).map((d) => d.serial);
  for (const candidate of [selected, remembered, preferred]) {
    if (candidate && selectable.includes(candidate)) return candidate;
  }
  return selectable.length === 1 ? selectable[0] : null;
}
```

4. Run the test. Expected: PASS.

5. Commit: `feat(shared): choose the active device with a pure policy`.

**Verification:** `npm test -- tests/device-selection.test.mjs`.

---

## Task 3: bridge device endpoints and selected-serial routing

**Files:** `server/bridge.mjs`, `tests/bridge.test.mjs`.

**Interfaces**

- `createBridge({ adb, host, port, chatConfig, chat, preferredSerial = DEFAULT_USB_SERIAL, onSelectionChange })`
- `GET /api/devices` →
  `{ devices, selected, preferred, adbMissing }`
- `POST /api/devices/select` body `{ serial }` → `200 { ok: true, selected }`,
  `400 { error: 'serial required' }`, `409 { error: 'device not available' }`
- `/health` → `{ ok: true, online, serial: selected, devices: devices.length, preferred }`
- Any device action with `selected === null` → `409 { error: 'device selection required' }`.

**Steps**

1. Add a fake adb that can list devices, and tests:

```js
function fakeDevices(devices, { selected } = {}) { ... }
```

   Tests to add:
   - `GET /api/devices` lists USB devices and auto-selects the only one.
   - `GET /api/devices` with two devices and no preference returns
     `selected: null`; `/keyevent` then returns 409 and never calls `keyEvent`.
   - `POST /api/devices/select { serial: 'B' }` switches; `/keyevent` then calls
     `adb.keyEvent('home', 'B')`.
   - `select` with an unknown/unauthorised serial returns 409.
   - `select` with a non-string serial returns 400.
   - `select` from a disallowed Origin returns 403 (existing CORS rule).
   - `/health` reports the selected serial and `online` only for it.
   - `onSelectionChange` fires once per actual change (initial resolve counts).
   - `adb.listDevices` throwing `ENOENT` → `/api/devices` returns
     `{ devices: [], selected: null, adbMissing: true }` with status 200.
   - Existing `health` deep-equal assertions are updated to the new payload.

2. Run `npm test -- tests/bridge.test.mjs`. Expected: FAIL on the new routes and
   on the changed `/health` shape.

3. Implement in `server/bridge.mjs`:
   - import `chooseDevice`, keep `DEFAULT_USB_SERIAL` as `preferredSerial` default.
   - module-level state per bridge: `let selected = null; let announced;`
   - `async function snapshot()`:
     ```js
     let devices = [];
     let adbMissing = false;
     try { devices = await adb.listDevices(); }
     catch (err) { if (!isMissingAdbError(err)) throw err; adbMissing = true; }
     const next = chooseDevice({ devices, selected, preferred: preferredSerial });
     if (next !== selected) { selected = next; if (onSelectionChange) onSelectionChange(next); }
     return { devices, adbMissing, selected };
     ```
     Guard the callback with `try/catch` and `Promise.resolve(...).catch(() => {})`
     so a failing ghost cannot break the route.
   - `requireSelected()` returns `selected` or sends 409.
   - `/api/devices` and `/api/devices/select` routes; add both to
     `PREFLIGHT_METHODS` (`GET, OPTIONS` and `POST, OPTIONS`).
   - `/health`, `/keyevent`, `/api/chat-screen`, `/chat`, `/api/chat-command`
     call `await snapshot()` first and use `selected`.
   - Pass `selected` into `adb.isOnline(serial)`, `keyEvent(key, serial)`,
     `wakeScreen(serial)`, `getScreenTimeout(serial)`,
     `setScreenTimeout(ms, serial)`.
   - `savedScreenTimeout` resets to `null` when the selection changes, so a
     restored timeout cannot be written to a different phone.

4. Run `npm test -- tests/bridge.test.mjs`. Expected: PASS.

5. Commit: `feat(bridge): expose devices and route actions to the selection`.

**Verification:** `npm test -- tests/bridge.test.mjs`.

---

## Task 4: chat follows the selected device

**Files:** `server/ghost-client.mjs`, `scripts/start.mjs`,
`tests/ghost-client.test.mjs`, `tests/start.test.mjs`.

**Steps**

1. Failing ghost test: after `setSerial('B')`, a tool whose schema **has** an
   optional `device` property receives `device: 'B'`; a tool with no `device`
   property does not. Also `setSerial` before `listTools` still applies.

2. Failing start test: a bridge `onSelectionChange('B')` callback is wired so
   `ghost.setSerial('B')` is called and `chat.run`'s `isLocked` uses `'B'`.
   (Drive it through the injected `createBridge` fake: capture the option and
   invoke it after startup.)

3. Run both test files. Expected: FAIL.

4. Implement:
   - `ghost-client.mjs`: `let activeSerial = serial;` `setSerial(next)` sets it;
     collect `deviceTools` from `inputSchema.properties.device`; inject when
     `activeSerial && (deviceTools === null || deviceTools.has(name))`; return
     `setSerial` from the factory. `DEFAULT_DEVICE` at spawn stays the initial
     serial.
   - `start.mjs`: `let activeSerial = DEFAULT_USB_SERIAL;` pass
     `onSelectionChange: (next) => { activeSerial = next; ghost?.setSerial(next); }`
     to `createBridge`; `isLocked: () => adbClient.isLocked(activeSerial)`;
     guard `ghost.setSerial` with optional call so older/fake ghosts are fine.
     If `next` is `null`, keep the last serial for chat (chat is gated by the
     bridge's 409 before it runs).

5. Run both test files. Expected: PASS.

6. Commit: `feat(chat): retarget ghost tools when the device changes`.

**Verification:** `npm test -- tests/ghost-client.test.mjs tests/start.test.mjs`.

---

## Task 5: status-bar device entry, picker, polling and reconnect

**Files:** `web/index.html`, `web/app.js`, `web/styles.css`, `shared/keys.mjs`,
`tests/shared-keys.test.mjs`.

**Steps**

1. Add the new i18n keys to both `MESSAGES.en` and `MESSAGES.zh` and a failing
   assertion in `tests/shared-keys.test.mjs` that `translate('zh', 'device.multiple', { count: 2 })`
   and its `en` counterpart are non-empty and interpolate the count.
   Keys: `device.title`, `device.multiple`, `device.none`, `device.switch`,
   `device.selected`, `device.unauthorized`, `device.offline`, `device.close`,
   `device.busy`, `device.selectFailed`.
   Run `npm test -- tests/shared-keys.test.mjs`. Expected: FAIL before the keys
   are added.

2. Implement the UI:
   - `index.html`: a `#device-button` above `#status` (inside a `.status-row`),
     hidden until there is something to show; a `#device-overlay` reusing
     `.settings-overlay` / `.settings-panel` with `#device-list` and
     `#device-close`.
   - `app.js`:
     - `let DEVICE_ID = null;` no hard-coded fallback serial.
     - `const DEVICES_URL = `${BRIDGE_BASE}/api/devices``,
       `const DEVICE_SELECT_URL = `${DEVICES_URL}/select``,
       `const DEVICE_POLL_MS = 2000;`
     - `let deviceList = []; let devicePoll; let switching = false;`
     - `refreshDevices()`: GET `/api/devices`; on success update `deviceList`,
       render the button/list, and if `selected !== DEVICE_ID` call
       `switchDevice(selected)`. `null` selected → stop the stream, show
       `device.none` / `device.multiple`.
     - `switchDevice(serial)`: refuse while `chatRunning` (status `device.busy`);
       otherwise stop the current handle, bump `generation`, reset `attempts`,
       set `DEVICE_ID`, store in `localStorage` (`phoneLinkDevice`), and start
       the stream when the context is usable.
     - `boot()`: try `GET /api/devices`; fall back to `/health` only if the
       route is missing (older bridge), then start the poll. With no selected
       device, do not call `startStream`.
     - `pollScreenState` keeps using the current `DEVICE_ID`, skipped when null.
     - `selectDevice(serial)`: POST `/api/devices/select`; on 409 show
       `device.selectFailed` and refresh; on success `switchDevice(serial)`.
     - Device button text: `model · last4` when selected, `device.multiple`
       with the count when not, `device.none` when the list is empty.
     - List rows: model + serial; unauthorised/offline rows disabled with the
       reason; the selected row marked.
     - `applyLanguage()` re-renders the button and list.
   - `styles.css`: `.status-row` (flex, gap), `.device-button` (muted text
     button that looks like `#status`), `.device-list` rows, `.device-item`
     states, reusing the existing panel colours.
   - Keep the status line's existing scale/uppercase behaviour.

3. Manual/DOM verification is limited to static checks in this environment:
   `node --check web/app.js`; `npm test` for the i18n and parity suites. The
   browser acceptance list is in Task 6's README section.

4. Commit: `feat(web): choose among phones from the status bar`.

**Verification:** `node --check web/app.js && npm test -- tests/shared-keys.test.mjs`.

---

## Task 6: installer wording, README, acceptance notes

**Files:** `installer/server.py`, `installer/static/index.html` (if it labels the
serial field), `tests/installer_test.py`, `README.md`.

**Steps**

1. Update the failing/updated installer test: the serial field is documented as
   the preferred device and an empty value means auto-select; `make_start_script`
   keeps exporting `PHONE_SERIAL` only when set (unchanged behaviour).
   Run `python3 -m pytest tests/installer_test.py -q`. Expected: FAIL on the new
   assertion (or PASS if the assertion is wording-only — then keep it as a
   regression guard and say so).

2. Update `installer/server.py` help/description text and the wizard label to
   "preferred device serial (leave empty to auto-select)"; keep the value and
   env export behaviour identical.

3. README:
   - "Multiple phones" section: status-bar entry, selection, auto-switch rule,
     unauthorised/offline rows, `localStorage` persistence.
   - API table: `GET /api/devices`, `POST /api/devices/select`, `409` cases.
   - `PHONE_SERIAL` = preferred serial; empty = auto.
   - Troubleshooting: two phones but no picker → check `/api/devices`; selected
     phone unplugged; chat busy blocks switching.
   - Manual acceptance checklist: 0 / 1 / 2 phones, unauthorised, unplug with
     one left, switch while chat is running, reload restores the choice.

4. Run `python3 -m pytest tests/installer_test.py -q` and `npm test`. Expected:
   PASS.

5. Commit: `docs: document multi-device selection`.

**Verification:** `npm test && python3 -m pytest tests/installer_test.py -q`.

---

## Final verification

- `npm test` — all node suites green.
- `python3 -m pytest tests/installer_test.py -q` — green.
- Copy the changed runtime files into `~/.local/share/phone-screen-link`,
  restart with `./start.sh`, confirm `/health` and `/api/devices` answer and the
  page loads. (Side effect outside the worktree: the running install. Report it.)
- Whole-branch review, then merge decision with the human partner.
