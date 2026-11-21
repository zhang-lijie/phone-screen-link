# Phone Screen Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a loopback-only web app that mirrors the whole screen of the connected Huawei Mate 40 Pro and lets the page control the phone, using ws-scrcpy-web as the engine.

**Architecture:** The upstream engine v0.5.13 runs with **one minimal, idempotent bind patch** (see Task 1) so it listens on `127.0.0.1:8000` only — stock `server.listen(port)` binds all interfaces, which would expose the unauthenticated control API to the LAN. Our static page is copied into its `dist/public/` so it loads `ws-scrcpy.umd.js` same-origin and calls `WsScrcpy.startStream()`. A small Node ADB bridge on `127.0.0.1:8100` supplies Home/Back/Power and enforces USB-only ADB. An orchestrator owns startup, file copying, re-asserting USB, and shutdown.

**Tech Stack:** Node >= 24 (host v26.13.1), ws-scrcpy-web v0.5.13 (GPL-3.0), vanilla HTML/CSS/ES modules, `node:test` + `node:assert`, ADB 1.0.41

**Spec:** `docs/superpowers/specs/2026-11-22-phone-screen-link-design.md`

## Global Constraints

- Engine version: `ws-scrcpy-web` v0.5.13, cloned from `https://github.com/bilbospocketses/ws-scrcpy-web.git`.
- Always use `adb -s <serial>`; never bare `adb shell`.
- USB serial: `2FD0221C09004177`. Wi‑Fi address: `192.168.3.123:5555`.
- Build the engine ONCE in setup: `npm install` → apply loopback bind patch → `npm run stage-seed` → `npm run build`. `dist/` is NOT tracked in git; `npm install` alone does not produce `dist/index.js`.
- Start the engine with `node dist/index.js` (NOT `npm start` / supervisor).
- `startStream()` options: `keyboard: true`, `fitToScreen: true`, `maxFps: 30`, codec auto-selected, `audio: true`. Confirm option names against `src/app/public/types.ts` (`StartStreamOptions`) before relying on them.
- Listen only on `127.0.0.1` (engine 8000 via bind patch, bridge 8100 via its own `host`). No authentication layer in this release.
- Engine's `GET /api/devices/screen-state?udid=<serial>` returns `{ awake: boolean; locked: boolean }` — verified against `src/server/__tests__/deviceScreenState.test.ts`.
- At startup and on ADB reconnect: disconnect Wi‑Fi ADB so only USB remains.
- No root, no lockscreen bypass, no FLAG_SECURE capture, no APK install on the phone.
- Host Node v26.13.1; engine requires >=24 and downloads its own Node 24 bootstrap on first build.

## Review Focus

- Locked phone → engine cannot capture keyguard; page must show an explicit "device locked" hint instead of a blank frame. Test: `buildStreamOptions` + lock-state mapping in Task 5.
- Wi‑Fi ADB reappears mid-session → engine may switch transport; re-assert USB on every reconnect cycle. Test: idempotent `ensureUsbOnly()` in Task 2.
- Engine not ready when page loads → page must show connecting/error, never a dead blank container. Test: status mapping from `onError`/`onDisconnect` in Task 5.
- Page opened over LAN IP (insecure context) → WebCodecs unavailable; show a clear message. Test: `isUsableContext(protocol, hostname)` in Task 5.
- Bridge called while ADB offline → explicit 503 and visible page error, not a silently ignored click. Test: POST `/keyevent` offline case in Task 3.

---

### Task 1: Project scaffold and engine setup

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `scripts/setup.mjs`
- Test: `tests/setup.test.mjs`

**Interfaces:**
- Consumes: none
- Produces: `ENGINE_REPO`, `ENGINE_TAG`, `engineDir()`, `LOOPBACK_PATCH` from `scripts/setup.mjs`; npm scripts `setup`, `start`, `test`.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_REPO, ENGINE_TAG, engineDir, LOOPBACK_PATCH } from '../scripts/setup.mjs';

test('engine is pinned to upstream v0.5.13', () => {
  assert.equal(ENGINE_TAG, 'v0.5.13');
  assert.match(ENGINE_REPO, /ws-scrcpy-web\.git$/);
  assert.match(engineDir(), /\/engine$/);
});

test('loopback patch targets the single all-interfaces listen call', () => {
  assert.equal(LOOPBACK_PATCH.file, 'src/server/services/HttpServer.ts');
  assert.match(LOOPBACK_PATCH.from, /server\.listen\(port,/);
  assert.match(LOOPBACK_PATCH.to, /'127\.0\.0\.1'/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/setup.test.mjs`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement scaffold and setup script**

`package.json`: private ESM package, `"type": "module"`, scripts: `"setup": "node scripts/setup.mjs"`, `"start": "node scripts/start.mjs"`, `"test": "node --test tests/*.test.mjs"`.
`.gitignore`: `engine/`, `node_modules/`, `*.log`.
`scripts/setup.mjs`: export the four values above. `LOOPBACK_PATCH = { file: 'src/server/services/HttpServer.ts', from: 'server.listen(port, () => {', to: "server.listen(port, '127.0.0.1', () => {" }` — verified against upstream v0.5.13 that this is the sole `server.listen(port` call and the engine exposes no bind-host config. `setup()` runs these steps, each skipped when already satisfied (check `engine/dist/index.js`):
  1. `git clone --depth 1 --branch v0.5.13 <ENGINE_REPO> <engineDir()>`
  2. `npm install` (cwd `engineDir()`) — ~10 min
  3. Apply `LOOPBACK_PATCH` idempotently: read file, if `from` present replace with `to`; if `to` present do nothing; if neither throw (upstream drifted).
  4. `npm run stage-seed` (stages node-pty + scrcpy-server, downloads Node 24 bootstrap ~30 MB)
  5. `npm run build` (webpack + types) → produces `dist/index.js`
Run all child processes with `stdio: 'inherit'` and `cwd: engineDir()`. Guard side effects: only invoke `setup()` when this module is the process entry point (`import.meta.url === pathToFileURL(process.argv[1]).href`), so importing it from the test has no side effects.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/setup.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Install the engine once**

Run: `npm run setup`
Expected: `engine/dist/index.js` exists and `engine/src/server/services/HttpServer.ts` contains `server.listen(port, '127.0.0.1'`. May take ~10 minutes.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore scripts/setup.mjs tests/setup.test.mjs
git commit -m "feat: scaffold project and pin ws-scrcpy-web engine"
```

---

### Task 2: ADB helper with USB enforcement

**Files:**
- Create: `server/adb.mjs`
- Create: `shared/keys.mjs` (initial version: `KEY_CODES` only; Task 5 extends it)
- Test: `tests/adb.test.mjs`

**Interfaces:**
- Consumes: none.
- Produces: `DEFAULT_USB_SERIAL`, `WIFI_ADDRESS`, `parseDevices(text)`, `createAdb(runner)`, `adb` default instance. `createAdb()` returns `{ list(), ensureUsbOnly(), keyEvent(key), isOnline() }`. All methods are async except `parseDevices`. Also produces `KEY_CODES` from `shared/keys.mjs` (`{ home: 3, back: 4, power: 26 }`), imported by `server/adb.mjs`.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDevices, createAdb, WIFI_ADDRESS, DEFAULT_USB_SERIAL } from '../server/adb.mjs';

const devicesText = `List of devices attached
2FD0221C09004177       device usb:1-5 product:NOH-AN01
192.168.3.123:5555     device product:NOH-AN01
`;

test('parseDevices returns both transports', () => {
  assert.deepEqual(parseDevices(devicesText), [DEFAULT_USB_SERIAL, WIFI_ADDRESS]);
});

test('ensureUsbOnly disconnects the wifi transport', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return args[0] === 'devices' ? devicesText : ''; });
  await adb.ensureUsbOnly();
  assert.ok(calls.some((a) => a[0] === 'disconnect' && a[1] === WIFI_ADDRESS));
});

test('ensureUsbOnly is idempotent when wifi is already gone', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return 'List of devices attached\n'; });
  await adb.ensureUsbOnly();
  assert.equal(calls.some((a) => a[0] === 'disconnect'), false);
});

test('keyEvent pins the usb serial', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return ''; });
  await adb.keyEvent('home');
  assert.deepEqual(calls[0], ['-s', DEFAULT_USB_SERIAL, 'shell', 'input', 'keyevent', '3']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/adb.test.mjs`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `server/adb.mjs` and initial `shared/keys.mjs`**

`shared/keys.mjs` initially exports only `KEY_CODES = { home: 3, back: 4, power: 26 }`.
`parseDevices(text)` → array of serials from lines whose second field is `device`. Default runner uses `node:child_process` `execFile('adb', args)`. `ensureUsbOnly()` calls `list()` and disconnects only when `WIFI_ADDRESS` is present. `keyEvent(key)` looks up `KEY_CODES[key]` and throws `Error('unknown key')` otherwise. `isOnline()` checks `list()` includes `DEFAULT_USB_SERIAL`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/adb.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/adb.mjs shared/keys.mjs tests/adb.test.mjs
git commit -m "feat: add adb helper with usb-only enforcement"
```

---

### Task 3: Local ADB bridge service

**Files:**
- Create: `server/bridge.mjs`
- Test: `tests/bridge.test.mjs`

**Interfaces:**
- Consumes: `adb` from Task 2.
- Produces: `createBridge({ adb, host, port })` → `{ start(), stop(), address() }`. `address()` returns the bound `http://127.0.0.1:<port>`. Endpoints: `GET /health` → `{ ok, online }`; `POST /keyevent` body `{ key }` → 200 `{ ok: true }`, 400 `{ error: 'unknown key' }`, 503 `{ error: 'device offline' }`.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../server/bridge.mjs';

const fakeAdb = {
  isOnline: async () => true,
  keyEvent: async (key) => { fakeAdb.last = key; },
};

test('health reports online', async () => {
  const bridge = createBridge({ adb: fakeAdb, port: 0 });
  const { address } = await bridge.start();
  const res = await fetch(`${address}/health`);
  assert.deepEqual(await res.json(), { ok: true, online: true });
  await bridge.stop();
});

test('keyevent accepts home and maps to adb', async () => {
  const bridge = createBridge({ adb: fakeAdb, port: 0 });
  const { address } = await bridge.start();
  const res = await fetch(`${address}/keyevent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'home' }),
  });
  assert.equal(res.status, 200);
  assert.equal(fakeAdb.last, 'home');
  await bridge.stop();
});

test('keyevent rejects unknown key', async () => {
  const bridge = createBridge({ adb: fakeAdb, port: 0 });
  const { address } = await bridge.start();
  const res = await fetch(`${address}/keyevent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'f13' }),
  });
  assert.equal(res.status, 400);
  await bridge.stop();
});

test('keyevent returns 503 when device offline', async () => {
  const bridge = createBridge({ adb: { ...fakeAdb, isOnline: async () => false }, port: 0 });
  const { address } = await bridge.start();
  const res = await fetch(`${address}/keyevent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'home' }),
  });
  assert.equal(res.status, 503);
  await bridge.stop();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/bridge.test.mjs`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `server/bridge.mjs`**

Use `node:http`. Bind `host ?? '127.0.0.1'`. Parse JSON body with a 64 KiB cap. No CORS headers. Delegate to `adb.isOnline()` and `adb.keyEvent(key)`. Keep `start()` returning a promise that resolves once listening.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/bridge.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/bridge.mjs tests/bridge.test.mjs
git commit -m "feat: add loopback ADB key bridge"
```

---

### Task 4: Startup orchestrator

**Files:**
- Create: `scripts/start.mjs`
- Test: `tests/start.test.mjs`

**Interfaces:**
- Consumes: `adb` from Task 2, `createBridge` from Task 3, `engineDir()` from Task 1.
- Produces: `buildPlan({ engineDir, webDir })` → ordered array of `{ kind: 'enforceUsb' | 'copyWeb' | 'spawnEngine' | 'startBridge' }`; `main()` executable via `npm start`.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../scripts/start.mjs';

test('plan enforces usb before copying and starting the engine', () => {
  const plan = buildPlan({ engineDir: '/x/engine', webDir: '/x/web' });
  assert.deepEqual(plan.map((s) => s.kind), ['enforceUsb', 'copyWeb', 'spawnEngine', 'startBridge']);
  assert.deepEqual(plan[1].files, ['index.html', 'app.js', 'styles.css', 'keys.mjs']);
  assert.equal(plan[2].command, 'node');
  assert.deepEqual(plan[2].args, ['dist/index.js']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/start.test.mjs`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `scripts/start.mjs`**

`buildPlan()` is pure and returns the four steps above. The `copyWeb` step is `{ kind: 'copyWeb', files: ['index.html', 'app.js', 'styles.css', 'keys.mjs'], webDir, sharedDir }`; it copies the three files from `webDir` plus `sharedDir/keys.mjs` → `engineDir/dist/public/keys.mjs`. `main()` executes the plan: await `adb.ensureUsbOnly()`, copy files, spawn `node dist/index.js` with `cwd: engineDir` and stdio inherit, call `createBridge({ adb }).start()`, poll `http://127.0.0.1:8000/` until 2xx, then set an interval that calls `adb.ensureUsbOnly()` every 5 s (Review Focus #2). On SIGINT/SIGTERM stop bridge, kill engine child, clear interval. Guard side effects: only invoke `main()` when this module is the process entry point, so importing `buildPlan` in tests is side-effect-free.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/start.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/start.mjs tests/start.test.mjs
git commit -m "feat: add startup orchestrator"
```

---

### Task 5: Shared config and web UI

**Files:**
- Modify: `shared/keys.mjs` (add the three helpers below to the existing `KEY_CODES`)
- Create: `web/index.html`
- Create: `web/app.js`
- Create: `web/styles.css`
- Test: `tests/shared-keys.test.mjs`

**Interfaces:**
- Consumes: engine global `window.WsScrcpy.startStream` loaded from `/ws-scrcpy.umd.js`; `shared/keys.mjs` copied to `dist/public/keys.mjs` by Task 4's `copyWeb` step.
- Produces: `buildStreamOptions(config)`, `isUsableContext(protocol, hostname)` from `shared/keys.mjs`; `handle` stored as `window.phoneLinkHandle`.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY_CODES, buildStreamOptions, isUsableContext } from '../shared/keys.mjs';

test('key codes match android', () => {
  assert.deepEqual(KEY_CODES, { home: 3, back: 4, power: 26 });
});

test('stream options pin keyboard, fit and 30fps', () => {
  const o = buildStreamOptions({ deviceId: '2FD0221C09004177' });
  assert.equal(o.keyboard, true);
  assert.equal(o.fitToScreen, true);
  assert.equal(o.maxFps, 30);
  assert.equal(o.audio, true);
});

test('insecure lan origin is rejected', () => {
  assert.equal(isUsableContext('http:', '127.0.0.1'), true);
  assert.equal(isUsableContext('http:', 'localhost'), true);
  assert.equal(isUsableContext('http:', '192.168.3.50'), false);
  assert.equal(isUsableContext('https:', 'example.com'), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/shared-keys.test.mjs`
Expected: FAIL (module not found)

- [ ] **Step 3: Extend `shared/keys.mjs`**

Keep the existing `KEY_CODES` export and add `buildStreamOptions` and `isUsableContext`. `buildStreamOptions` returns a fresh object with `codec` omitted (auto-select) and the four pinned values. `isUsableContext` returns true for `https:` or for `http:` with hostname `127.0.0.1`/`localhost`/`[::1]`. Do not import any Node-only modules — this file is shared with the browser.

- [ ] **Step 4: Implement the page**

`web/index.html`: loads `/ws-scrcpy.umd.js` (plain script), then `/app.js` with `type="module"`, and `/styles.css`; contains `#stream`, `#status`, buttons `data-key="home|back|power"`.
`web/app.js`: ES module; `import { buildStreamOptions, isUsableContext } from './keys.mjs'`; guard `isUsableContext(location.protocol, location.hostname)` and show a clear message if false (Review Focus #4); call `window.WsScrcpy.startStream(document.getElementById('stream'), '2FD0221C09004177', buildStreamOptions(...))`; wire `onConnect`/`onDisconnect`/`onError` to `#status` text (Review Focus #3); if `window.WsScrcpy` is undefined or `startStream()` throws, set `#status` to a clear "engine unavailable — is the service running?" message and leave the page in a visible error state, never a dead blank container; wire buttons to `POST /keyevent` on `http://127.0.0.1:8100` and display 503 as a visible error (Review Focus #5); expose `window.phoneLinkHandle`.
`web/styles.css`: dark layout, full-height stream container, visible status bar.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/shared-keys.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add shared/keys.mjs web/ tests/shared-keys.test.mjs
git commit -m "feat: add web shell with stream and control buttons"
```

---

### Task 6: Lock-state hint, docs, and acceptance smoke

**Files:**
- Modify: `web/app.js` (lock-state polling)
- Create: `README.md`

**Interfaces:**
- Consumes: engine `GET /api/devices/screen-state?udid=<serial>` returning `{ awake, locked }`.
- Produces: README with setup/usage/troubleshooting; lock hint in `#status`.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { lockHint } from '../shared/keys.mjs';

test('locked device produces an explicit hint', () => {
  assert.equal(lockHint({ awake: true, locked: true }), 'Phone is locked — unlock it to see the screen');
  assert.equal(lockHint({ awake: false, locked: false }), 'Phone is asleep — waking it');
  assert.equal(lockHint({ awake: true, locked: false }), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/shared-keys.test.mjs`
Expected: FAIL (`lockHint` is not a function)

- [ ] **Step 3: Implement lock hint and docs**

Add `lockHint(state)` to `shared/keys.mjs`. In `web/app.js`, poll `/api/devices/screen-state?udid=2FD0221C09004177` every 3 s via `fetch` (same-origin) and prepend the hint to `#status` (Review Focus #1). README must document: `npm run setup`, `npm start`, open `http://127.0.0.1:8000/`, lock screen limitation, secure-context limitation, USB enforcement behavior, and spike-derived troubleshooting: Node 26 `velopack` engine warning is harmless; supervisor is avoided; if the engine's own first-run "install for all users?" dialog appears on `/`, dismiss it with "no, me only" (our custom page at the root replaces that home page after copy, so normally it will not appear).

- [ ] **Step 4: Run all tests to verify they pass**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 5: Acceptance smoke with the real phone**

Run `npm start`, then in a browser open `http://127.0.0.1:8000/` and verify: `#stream` canvas renders non-black pixels; clicking Home returns the phone to launcher (check with `adb -s 2FD0221C09004177 shell 'dumpsys window | grep mCurrentFocus'`). Confirm `adb devices -l` shows only the USB serial while the app runs.

- [ ] **Step 6: Commit**

```bash
git add shared/keys.mjs web/app.js README.md tests/shared-keys.test.mjs
git commit -m "docs: add lock hint and usage guide"
```
