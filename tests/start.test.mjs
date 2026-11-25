import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DEFAULT_USB_SERIAL } from '../server/adb.mjs';
import { ADB_MISSING_HINT, buildPlan, copyWeb, engineEnv, main } from '../scripts/start.mjs';

test('plan configures the connection before copying and starting the engine', () => {
  const plan = buildPlan({ engineDir: '/x/engine', webDir: '/x/web' });
  assert.deepEqual(plan.map((s) => s.kind), ['configureConnection', 'copyWeb', 'spawnEngine', 'startBridge']);
  assert.deepEqual(plan[1].files, ['index.html', 'app.js', 'styles.css']);
  assert.deepEqual(plan[1].sharedFiles, ['keys.mjs', 'chat-commands.mjs']);
  assert.equal(plan[2].command, 'node');
  assert.deepEqual(plan[2].args, ['dist/index.js']);
});

test('plan binds the control bridge to the fixed loopback port 8100', () => {
  const plan = buildPlan({ engineDir: '/x/engine', webDir: '/x/web' });
  assert.equal(plan[3].port, 8100);
});

test('plan resolves web and shared directories relative to the project', () => {
  const plan = buildPlan({ engineDir: '/x/engine', webDir: '/x/web' });
  assert.equal(plan[1].webDir, '/x/web');
  assert.equal(plan[1].sharedDir, '/x/shared');
  assert.equal(plan[2].cwd, '/x/engine');
});

test('copyWeb copies web files and shared modules into the public dir as .js', () => {
  const root = mkdtempSync(join(tmpdir(), 'phone-link-start-'));
  try {
    const webDir = join(root, 'web');
    const sharedDir = join(root, 'shared');
    const publicDir = join(root, 'engine', 'dist', 'public');
    mkdirSync(webDir, { recursive: true });
    mkdirSync(sharedDir, { recursive: true });
    const webFiles = {
      'index.html': '<html>phone link</html>',
      'app.js': 'console.log("app");',
      'styles.css': 'body { margin: 0; }',
    };
    for (const [name, content] of Object.entries(webFiles)) {
      writeFileSync(join(webDir, name), content);
    }
    writeFileSync(join(sharedDir, 'keys.mjs'), 'export const KEY_CODES = {};');
    writeFileSync(join(sharedDir, 'chat-commands.mjs'), 'export const X = 1;');

    const step = buildPlan({ engineDir: join(root, 'engine'), webDir })[1];
    copyWeb(step, publicDir);

    assert.deepEqual(readdirSync(publicDir).sort(), ['app.js', 'chat-commands.js', 'index.html', 'keys.js', 'styles.css']);
    for (const [name, content] of Object.entries(webFiles)) {
      assert.equal(readFileSync(join(publicDir, name), 'utf8'), content);
    }
    assert.equal(readFileSync(join(publicDir, 'keys.js'), 'utf8'), 'export const KEY_CODES = {};');
    assert.equal(readFileSync(join(publicDir, 'chat-commands.js'), 'utf8'), 'export const X = 1;');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Injected runtime: no real ADB, engine, bridge, ghost, timers, or process
// listeners.
function fakeRuntime(overrides = {}) {
  const calls = {
    ensureUsb: 0,
    ensureWireless: [],
    setConnection: [],
    connectionLoad: 0,
    copy: 0,
    spawn: [],
    order: [],
    bridgeStart: 0,
    bridgeStop: 0,
    ghostStart: 0,
    ghostStop: 0,
    ghostListTools: 0,
    ghostCalls: [],
    kill: 0,
    setTimer: 0,
    clearTimer: 0,
  };
  const handlers = new Map();
  const interval = Symbol('connection-interval');
  const child = { kill: () => { calls.order.push('kill'); calls.kill += 1; } };
  let connection = { mode: 'usb', serial: DEFAULT_USB_SERIAL };
  const adbClient = {
    getMode: () => connection.mode,
    getSerial: () => connection.serial,
    setConnection: (next) => {
      calls.order.push('setConnection');
      calls.setConnection.push(next);
      connection = next;
    },
    ensureUsbOnly: async () => { calls.order.push('ensureUsb'); calls.ensureUsb += 1; },
    ensureWirelessConnected: async (address) => {
      calls.order.push('ensureWireless');
      calls.ensureWireless.push(address);
      return true;
    },
    isLocked: async () => true,
  };
  const ghost = {
    start: async () => { calls.order.push('ghostStart'); calls.ghostStart += 1; },
    stop: async () => { calls.order.push('ghostStop'); calls.ghostStop += 1; },
    listTools: async () => { calls.ghostListTools += 1; return []; },
    callTool: async (name, toolArgs) => {
      calls.ghostCalls.push({ name, args: toolArgs });
      return { content: [{ type: 'text', text: '{"locked":false}' }] };
    },
  };
  const bridge = {
    start: async () => { calls.order.push('bridgeStart'); calls.bridgeStart += 1; return { address: 'http://127.0.0.1:8100' }; },
    stop: async () => { calls.order.push('bridgeStop'); calls.bridgeStop += 1; },
  };
  // In-memory stand-in for the file store; start.mjs must hand the same
  // object to the bridge and read config through it in chat.run.
  const chatConfig = {
    load: () => ({
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      maxSteps: 8,
      screenshot: true,
      apiKey: '',
    }),
    save: () => ({}),
    publicConfig: () => ({}),
  };
  const connectionConfig = { mode: 'usb', address: '' };
  const connectionStore = {
    load: () => { calls.connectionLoad += 1; return { ...connectionConfig }; },
    save: (patch) => {
      Object.assign(connectionConfig, patch);
      if (connectionConfig.mode === 'usb') connectionConfig.address = '';
      return { ...connectionConfig };
    },
    publicConfig: () => ({ ...connectionConfig }),
  };
  const deps = {
    adb: adbClient,
    env: { ...process.env, PHONE_SERIAL: '', PHONE_USB_SERIAL: '' },
    createConnectionConfigStore: (options) => {
      calls.connectionConfigOptions = options;
      return connectionStore;
    },
    engineDir: () => '/x/engine',
    copyWeb: () => { calls.copy += 1; },
    createGhostClient: (options) => { calls.ghostOptions = options; return ghost; },
    createChatConfigStore: (options) => { calls.chatConfigOptions = options; return chatConfig; },
    createBridge: (options) => {
      assert.equal(options.port, 8100);
      calls.bridgeOptions = options;
      return bridge;
    },
    spawn: (command, args, options) => {
      calls.order.push('spawn');
      calls.spawn.push({ command, args, cwd: options.cwd, stdio: options.stdio });
      calls.spawnEnv = options.env;
      return child;
    },
    waitForEngine: async () => {},
    setTimer: () => { calls.setTimer += 1; return interval; },
    clearTimer: (value) => { assert.equal(value, interval); calls.clearTimer += 1; },
    log: () => {},
    error: () => {},
    onSignal: (signal, handler) => { calls.order.push(`on:${signal}`); handlers.set(signal, handler); },
    offSignal: (signal, handler) => { if (handlers.get(signal) === handler) handlers.delete(signal); },
    ...overrides,
  };
  return { deps, calls, handlers, child, bridge, ghost, chatConfig, adbClient, connectionStore };
}

test('the engine is spawned with proxy-aware fetch settings when a proxy is configured', () => {
  // Node ignores HTTP(S)_PROXY for fetch by default, and the engine awaits an
  // optional dependency download before it serves — without these the fetch
  // hangs past the readiness deadline on a proxied network.
  const withProxy = engineEnv({ HTTPS_PROXY: 'http://127.0.0.1:31181' });
  assert.equal(withProxy.NODE_USE_ENV_PROXY, '1');
  assert.match(withProxy.NODE_OPTIONS, /--use-system-ca/);

  assert.deepEqual(engineEnv({}), {});
  assert.deepEqual(engineEnv({ PATH: '/usr/bin' }), {});
});

test('existing NODE_OPTIONS are preserved when the proxy settings are added', () => {
  const env = engineEnv({ HTTPS_PROXY: 'http://127.0.0.1:31181', NODE_OPTIONS: '--max-old-space-size=512' });
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=512/);
  assert.match(env.NODE_OPTIONS, /--use-system-ca/);
});

test('main installs signal handlers before spawning and cleans up when readiness rejects', async () => {  const { deps, calls, handlers } = fakeRuntime({
    waitForEngine: async () => { throw new Error('readiness failed'); },
  });

  await assert.rejects(main(deps), /readiness failed/);

  assert.deepEqual(
    calls.order.filter((entry) => entry === 'spawn' || entry.startsWith('on:')).slice(0, 3),
    ['on:SIGINT', 'on:SIGTERM', 'spawn'],
  );
  assert.equal(calls.ensureUsb, 1);
  assert.equal(calls.copy, 1);
  assert.deepEqual(calls.spawn, [
    { command: 'node', args: ['dist/index.js'], cwd: '/x/engine', stdio: 'inherit' },
  ]);
  assert.equal(calls.bridgeStart, 1);
  assert.equal(calls.bridgeStop, 1);
  assert.equal(calls.kill, 1);
  assert.equal(calls.setTimer, 0);
  assert.equal(handlers.size, 0);
});

function missingAdb() {
  const err = Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' });
  let connection = { mode: 'usb', serial: DEFAULT_USB_SERIAL };
  return {
    getMode: () => connection.mode,
    getSerial: () => connection.serial,
    setConnection: (next) => { connection = next; },
    ensureUsbOnly: async () => { throw err; },
    ensureWirelessConnected: async () => true,
    isLocked: async () => true,
  };
}

test('a missing adb at startup logs a hint and still starts the bridge and engine', async () => {
  const logs = [];
  const { deps, calls, handlers } = fakeRuntime({
    adb: missingAdb(),
    log: (line) => logs.push(line),
  });

  await main(deps);

  assert.ok(logs.includes(ADB_MISSING_HINT), 'the first-run adb download is explained');
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.bridgeStart, 1);
  assert.equal(calls.setTimer, 1);

  await handlers.get('SIGINT')();
  assert.equal(calls.kill, 1);
});

test('the periodic USB check stays quiet while adb is still being installed', async () => {
  const errors = [];
  let tick;
  const interval = Symbol('usb-interval');
  const { deps, handlers } = fakeRuntime({
    adb: missingAdb(),
    setTimer: (fn) => { tick = fn; return interval; },
    clearTimer: () => {},
    error: (...args) => errors.push(args),
  });

  await main(deps);
  tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, []);

  await handlers.get('SIGINT')();
});

test('main defaults to USB, applies it before engine spawn, and rechecks USB every 5 seconds', async () => {
  let tick;
  let intervalMs;
  const { deps, calls, handlers } = fakeRuntime({
    setTimer: (fn, ms) => { tick = fn; intervalMs = ms; return Symbol('usb-timer'); },
  });

  await main(deps);

  assert.equal(calls.connectionConfigOptions.file, join('/x', 'state', 'connection.json'));
  assert.equal(calls.connectionLoad, 1);
  assert.deepEqual(calls.setConnection, [{ mode: 'usb', serial: DEFAULT_USB_SERIAL }]);
  assert.ok(calls.order.indexOf('setConnection') < calls.order.indexOf('ensureUsb'));
  assert.ok(calls.order.indexOf('setConnection') < calls.order.indexOf('spawn'));
  assert.equal(calls.ensureUsb, 1);
  assert.equal(intervalMs, 5_000);

  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.ensureUsb, 2);
  assert.deepEqual(calls.ensureWireless, []);

  await handlers.get('SIGINT')();
});

test('stored wireless mode skips USB enforcement and reconnects only the active address', async () => {
  let tick;
  const address = '10.0.0.5:5555';
  const { deps, calls, handlers } = fakeRuntime({
    createConnectionConfigStore: () => ({
      load: () => ({ mode: 'wifi', address }),
      save: () => ({}),
      publicConfig: () => ({ mode: 'wifi', address }),
    }),
    setTimer: (fn) => { tick = fn; return Symbol('wifi-timer'); },
  });

  await main(deps);

  assert.deepEqual(calls.setConnection, [{ mode: 'wifi', serial: address }]);
  assert.ok(calls.order.indexOf('setConnection') < calls.order.indexOf('spawn'));
  assert.equal(calls.ensureUsb, 0);
  assert.deepEqual(calls.ensureWireless, []);

  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.ensureUsb, 0);
  assert.deepEqual(calls.ensureWireless, [address]);

  await handlers.get('SIGINT')();
});

test('PHONE_SERIAL wireless override takes precedence over stored USB mode', async () => {
  const { deps, calls, handlers } = fakeRuntime({
    env: { PHONE_SERIAL: ' 10.0.0.8:5555 ' },
  });

  await main(deps);

  assert.deepEqual(calls.setConnection, [{ mode: 'wifi', serial: '10.0.0.8:5555' }]);
  assert.equal(calls.ensureUsb, 0);

  await handlers.get('SIGINT')();
});

test('the supervision timer honors a live mode change on its next tick', async () => {
  let tick;
  const { deps, calls, handlers, adbClient } = fakeRuntime({
    setTimer: (fn) => { tick = fn; return Symbol('mode-timer'); },
  });

  await main(deps);
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.ensureUsb, 2);

  adbClient.setConnection({ mode: 'wifi', serial: '10.0.0.9:5555' });
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.ensureUsb, 2);
  assert.deepEqual(calls.ensureWireless, ['10.0.0.9:5555']);

  adbClient.setConnection({ mode: 'usb', serial: DEFAULT_USB_SERIAL });
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.ensureUsb, 3);
  assert.deepEqual(calls.ensureWireless, ['10.0.0.9:5555']);

  await handlers.get('SIGINT')();
});

test('the chat ghost gets the engine adb folder prepended to PATH', async () => {
  const { deps, calls, handlers } = fakeRuntime();

  await main(deps);

  const entries = calls.ghostOptions.env.PATH.split(delimiter);
  assert.equal(entries[0], join('/x', 'engine', 'dependencies', 'adb'));
  assert.ok(entries.length > 1, 'the inherited PATH is preserved after the bundled folder');

  await handlers.get('SIGINT')();
});

test('main cleans up the spawned engine and bridge when bridge.start rejects', async () => {
  const { deps, calls, handlers } = fakeRuntime();
  deps.createBridge = () => ({
    start: async () => { calls.bridgeStart += 1; throw new Error('bind failed'); },
    stop: async () => { calls.bridgeStop += 1; },
  });

  await assert.rejects(main(deps), /bind failed/);

  assert.equal(calls.bridgeStop, 1);
  assert.equal(calls.kill, 1);
  assert.equal(handlers.size, 0);
});

test('cleanup still kills the engine when bridge.stop rejects', async () => {
  const { deps, calls } = fakeRuntime({
    waitForEngine: async () => { throw new Error('readiness failed'); },
  });
  deps.createBridge = () => ({
    start: async () => { calls.bridgeStart += 1; return { address: 'http://127.0.0.1:8100' }; },
    stop: async () => { calls.bridgeStop += 1; throw new Error('stop failed'); },
  });

  await assert.rejects(main(deps), /readiness failed/);
  assert.equal(calls.bridgeStop, 1);
  assert.equal(calls.kill, 1);
});

test('a signal during readiness aborts startup and releases every resource', async () => {
  let readinessEntered;
  const entered = new Promise((resolve) => { readinessEntered = resolve; });
  const { deps, calls, handlers } = fakeRuntime({
    waitForEngine: () => { readinessEntered(); return new Promise(() => {}); },
  });

  const running = main(deps);
  await entered;
  await handlers.get('SIGINT')();

  await assert.rejects(running, /startup aborted/);
  assert.equal(calls.bridgeStop, 1);
  assert.equal(calls.kill, 1);
  assert.equal(calls.clearTimer, 0);
});

test('repeated signals after startup trigger cleanup only once', async () => {
  const { deps, calls, handlers } = fakeRuntime();

  await main(deps);
  assert.equal(calls.setTimer, 1);
  assert.equal(handlers.size, 2);

  await handlers.get('SIGINT')();
  await handlers.get('SIGINT')();
  await handlers.get('SIGTERM')();

  assert.equal(calls.bridgeStop, 1);
  assert.equal(calls.kill, 1);
  assert.equal(calls.clearTimer, 1);
});

// ---------------------------------------------------------------------------
// Chat wiring (Task 7): config store, ghost lifecycle, agent, cleanup order
// ---------------------------------------------------------------------------

test('main wires the chat config store and ghost agent into the bridge, ghost before bridge', async () => {
  const { deps, calls, handlers, chatConfig, adbClient } = fakeRuntime();

  await main(deps);

  assert.equal(calls.ghostOptions.serial, undefined);
  assert.equal(typeof calls.ghostOptions.getSerial, 'function');
  assert.equal(calls.ghostOptions.getSerial(), DEFAULT_USB_SERIAL);
  adbClient.setConnection({ mode: 'wifi', serial: '10.0.0.5:5555' });
  assert.equal(calls.ghostOptions.getSerial(), '10.0.0.5:5555');
  assert.equal(calls.ghostStart, 1);
  assert.deepEqual(
    calls.order.filter((entry) => ['spawn', 'ghostStart', 'bridgeStart'].includes(entry)),
    ['spawn', 'ghostStart', 'bridgeStart'],
  );
  assert.equal(calls.bridgeOptions.chatConfig, chatConfig);
  assert.equal(typeof calls.bridgeOptions.chat.run, 'function');

  await handlers.get('SIGINT')();
  assert.equal(calls.ghostStop, 1);
  // Cleanup unwinds in reverse start order: bridge, then ghost, then engine.
  assert.ok(calls.order.indexOf('bridgeStop') < calls.order.indexOf('ghostStop'));
  assert.ok(calls.order.indexOf('ghostStop') < calls.order.indexOf('kill'));
});

test('chat.run goes through the agent loop and the phone-state gate', async () => {
  const { deps, calls, handlers, chatConfig } = fakeRuntime();
  // Locked device: the agent must stop before listing tools or calling the
  // model, and reply with the localized unlock prompt.
  deps.createGhostClient = () => ({
    start: async () => { calls.ghostStart += 1; },
    stop: async () => { calls.ghostStop += 1; },
    listTools: async () => { calls.ghostListTools += 1; return []; },
    callTool: async (name, toolArgs) => {
      calls.ghostCalls.push({ name, args: toolArgs });
      return { content: [{ type: 'text', text: 'The screen is locked' }] };
    },
  });

  await main(deps);
  // M8: the bridge hands chat.run the config it already loaded for the gate;
  // run must use it instead of re-reading the store (TOCTOU double load).
  let loads = 0;
  const innerLoad = chatConfig.load;
  chatConfig.load = () => { loads += 1; return innerLoad(); };
  const turn = await calls.bridgeOptions.chat.run('回到桌面', 'zh', innerLoad());
  assert.equal(loads, 0, 'chat.run must not re-load the config store');

  assert.match(turn.reply, /解锁/);
  assert.deepEqual(turn.steps, []);
  assert.deepEqual(calls.ghostCalls.map((c) => c.name), [], 'lock check uses ADB, not a ghost tool');
  assert.equal(calls.ghostListTools, 0);

  await handlers.get('SIGINT')();
});

test('a hanging ghost start is bounded: startup completes with chat disabled', async () => {
  const { deps, calls, handlers, chatConfig } = fakeRuntime({ ghostStartTimeoutMs: 50 });
  deps.createGhostClient = () => ({
    start: () => { calls.ghostStart += 1; return new Promise(() => {}); }, // never resolves
    stop: async () => { calls.ghostStop += 1; },
    listTools: async () => [],
    callTool: async () => ({}),
  });

  // The bridge must come up even though ghost.start() hangs forever.
  await main(deps);

  assert.equal(calls.ghostStart, 1);
  assert.equal(calls.bridgeStart, 1);
  assert.equal(calls.bridgeOptions.chat, undefined);
  assert.equal(calls.bridgeOptions.chatConfig, chatConfig);
  assert.equal(calls.ghostStop, 1); // defensive release of the partial start

  await handlers.get('SIGINT')();
  assert.equal(calls.ghostStop, 1); // stopped exactly once
  assert.equal(calls.bridgeStop, 1);
  assert.equal(calls.kill, 1);
});

test('a signal while ghost is still starting aborts without hanging cleanup', async () => {
  let ghostEntered;
  const entered = new Promise((resolve) => { ghostEntered = resolve; });
  const { deps, calls, handlers } = fakeRuntime({ ghostStartTimeoutMs: 50 });
  deps.createGhostClient = () => ({
    start: () => { calls.ghostStart += 1; ghostEntered(); return new Promise(() => {}); },
    stop: async () => { calls.ghostStop += 1; },
    listTools: async () => [],
    callTool: async () => ({}),
  });

  const running = main(deps);
  await entered;
  await handlers.get('SIGINT')();

  await assert.rejects(running, /startup aborted/);
  assert.equal(calls.ghostStop, 1);
  assert.equal(calls.kill, 1);
  assert.equal(calls.bridgeStart, 0);
});

test('a ghost that fails to start leaves the bridge and buttons running without chat', async () => {
  const { deps, calls, handlers, chatConfig } = fakeRuntime();
  deps.createGhostClient = () => ({
    start: async () => { calls.ghostStart += 1; throw new Error('uvx not found'); },
    stop: async () => { calls.ghostStop += 1; },
    listTools: async () => [],
    callTool: async () => ({}),
  });

  // Startup must succeed anyway: chat degrades to unavailable, /keyevent does not.
  await main(deps);

  assert.equal(calls.bridgeStart, 1);
  assert.equal(calls.ghostStop, 1); // defensive release of the partial start
  assert.equal(calls.bridgeOptions.chat, undefined);
  assert.equal(calls.bridgeOptions.chatConfig, chatConfig);

  await handlers.get('SIGINT')();
  assert.equal(calls.ghostStop, 1); // stopped exactly once
  assert.equal(calls.bridgeStop, 1);
  assert.equal(calls.kill, 1);
});
