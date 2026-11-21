import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan, copyWeb, main } from '../scripts/start.mjs';

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

test('copyWeb copies the three web files and shared keys into the public dir', () => {
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

    assert.deepEqual(readdirSync(publicDir).sort(), ['app.js', 'index.html', 'keys.mjs', 'styles.css']);
    for (const [name, content] of Object.entries(webFiles)) {
      assert.equal(readFileSync(join(publicDir, name), 'utf8'), content);
    }
    assert.equal(readFileSync(join(publicDir, 'keys.mjs'), 'utf8'), 'export const KEY_CODES = {};');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Injected runtime: no real ADB, engine, bridge, timers, or process listeners.
function fakeRuntime(overrides = {}) {
  const calls = {
    ensureUsb: 0,
    copy: 0,
    spawn: [],
    order: [],
    bridgeStart: 0,
    bridgeStop: 0,
    kill: 0,
    setTimer: 0,
    clearTimer: 0,
  };
  const handlers = new Map();
  const interval = Symbol('usb-interval');
  const child = { kill: () => { calls.kill += 1; } };
  const bridge = {
    start: async () => { calls.bridgeStart += 1; return { address: 'http://127.0.0.1:8100' }; },
    stop: async () => { calls.bridgeStop += 1; },
  };
  const deps = {
    adb: { ensureUsbOnly: async () => { calls.ensureUsb += 1; } },
    engineDir: () => '/x/engine',
    copyWeb: () => { calls.copy += 1; },
    createBridge: (options) => {
      assert.equal(options.port, 8100);
      return bridge;
    },
    spawn: (command, args, options) => {
      calls.order.push('spawn');
      calls.spawn.push({ command, args, cwd: options.cwd, stdio: options.stdio });
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
  return { deps, calls, handlers, child, bridge };
}

test('main installs signal handlers before spawning and cleans up when readiness rejects', async () => {
  const { deps, calls, handlers } = fakeRuntime({
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
