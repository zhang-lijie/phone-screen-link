import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_USB_SERIAL } from '../server/adb.mjs';
import { buildPlan, copyWeb, engineEnv, main } from '../scripts/start.mjs';

test('plan enforces usb before copying and starting the engine', () => {
  const plan = buildPlan({ engineDir: '/x/engine', webDir: '/x/web' });
  assert.deepEqual(plan.map((s) => s.kind), ['enforceUsb', 'copyWeb', 'spawnEngine', 'startBridge']);
  assert.deepEqual(plan[1].files, ['index.html', 'app.js', 'styles.css', 'keys.mjs']);
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

test('copyWeb copies the three web files and shared keys into the public dir as .js', () => {
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

    const step = buildPlan({ engineDir: join(root, 'engine'), webDir })[1];
    copyWeb(step, publicDir);

    assert.deepEqual(readdirSync(publicDir).sort(), ['app.js', 'index.html', 'keys.js', 'styles.css']);
    for (const [name, content] of Object.entries(webFiles)) {
      assert.equal(readFileSync(join(publicDir, name), 'utf8'), content);
    }
    assert.equal(readFileSync(join(publicDir, 'keys.js'), 'utf8'), 'export const KEY_CODES = {};');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Injected runtime: no real ADB, engine, bridge, ghost, timers, or process
// listeners.
function fakeRuntime(overrides = {}) {
  const calls = {
    ensureUsb: 0,
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
  const interval = Symbol('usb-interval');
  const child = { kill: () => { calls.order.push('kill'); calls.kill += 1; } };
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
  const deps = {
    adb: { ensureUsbOnly: async () => { calls.ensureUsb += 1; } },
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
  return { deps, calls, handlers, child, bridge, ghost, chatConfig };
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

  assert.deepEqual(calls.order.slice(0, 3), ['on:SIGINT', 'on:SIGTERM', 'spawn']);
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
  const { deps, calls, handlers, chatConfig } = fakeRuntime();

  await main(deps);

  assert.equal(calls.ghostOptions.serial, DEFAULT_USB_SERIAL);
  assert.equal(calls.ghostStart, 1);
  assert.deepEqual(calls.order.slice(2, 5), ['spawn', 'ghostStart', 'bridgeStart']);
  assert.equal(calls.bridgeOptions.chatConfig, chatConfig);
  assert.equal(typeof calls.bridgeOptions.chat.run, 'function');

  await handlers.get('SIGINT')();
  assert.equal(calls.ghostStop, 1);
  // Cleanup unwinds in reverse start order: bridge, then ghost, then engine.
  assert.ok(calls.order.indexOf('bridgeStop') < calls.order.indexOf('ghostStop'));
  assert.ok(calls.order.indexOf('ghostStop') < calls.order.indexOf('kill'));
});

test('chat.run goes through the agent loop and the phone-state gate', async () => {
  const { deps, calls, handlers } = fakeRuntime();
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
  const turn = await calls.bridgeOptions.chat.run('回到桌面', 'zh');

  assert.match(turn.reply, /解锁/);
  assert.deepEqual(turn.steps, []);
  assert.deepEqual(calls.ghostCalls.map((c) => c.name), ['get_phone_state']);
  assert.equal(calls.ghostListTools, 0);

  await handlers.get('SIGINT')();
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
