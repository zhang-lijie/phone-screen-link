import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adb } from '../server/adb.mjs';
import { createBridge } from '../server/bridge.mjs';
import { engineDir } from './setup.mjs';

const BRIDGE_PORT = 8100;
const ENGINE_URL = 'http://127.0.0.1:8000/';
const USB_RECHECK_MS = 5_000;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const ABORTED = Symbol('startup-aborted');

export function buildPlan({ engineDir, webDir }) {
  return [
    { kind: 'enforceUsb' },
    {
      kind: 'copyWeb',
      files: ['index.html', 'app.js', 'styles.css', 'keys.mjs'],
      webDir,
      sharedDir: join(dirname(engineDir), 'shared'),
    },
    { kind: 'spawnEngine', command: 'node', args: ['dist/index.js'], cwd: engineDir },
    { kind: 'startBridge', port: BRIDGE_PORT },
  ];
}

export function copyWeb({ files, webDir, sharedDir }, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const webFiles = files.slice(0, -1);
  const sharedFiles = files.slice(-1);
  for (const file of webFiles) {
    copyFileSync(join(webDir, file), join(targetDir, file));
  }
  for (const file of sharedFiles) {
    copyFileSync(join(sharedDir, file), join(targetDir, file));
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEngine(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status >= 200 && res.status < 300) return;
    } catch {
      // The engine has not started listening yet.
    }
    await delay(READY_POLL_MS);
  }
  throw new Error(`engine did not become ready at ${url}`);
}

// Dependencies are injectable so startup failures and signals can be exercised
// without a real device, engine, or bridge.
export async function main(deps = {}) {
  const {
    adb: adbClient = adb,
    createBridge: makeBridge = createBridge,
    spawn: spawnChild = spawn,
    waitForEngine: checkEngine = waitForEngine,
    engineDir: getEngineDir = engineDir,
    copyWeb: copyFiles = copyWeb,
    setTimer = setInterval,
    clearTimer = clearInterval,
    log = console.log,
    error = console.error,
    onSignal = (signal, handler) => process.once(signal, handler),
    offSignal = (signal, handler) => process.removeListener(signal, handler),
  } = deps;

  const projectDir = dirname(getEngineDir());
  const [, copyStep, spawnStep, bridgeStep] = buildPlan({
    engineDir: getEngineDir(),
    webDir: join(projectDir, 'web'),
  });

  await adbClient.ensureUsbOnly();

  copyFiles(copyStep, join(spawnStep.cwd, 'dist', 'public'));

  let engine;
  let bridge;
  let bridgeStart;
  let usbInterval;
  let bridgeStopped = false;
  let engineKilled = false;
  let cleanupTail = Promise.resolve();
  let aborted = false;
  let abortStartup;
  const startupAbort = new Promise((resolve) => { abortStartup = resolve; });

  // Serialized and re-entrant: every caller re-checks current state, so a
  // resource created after an earlier cleanup is still released. Safe to call
  // from a signal handler, the failure path, and the finally block.
  function cleanup() {
    const run = async () => {
      if (usbInterval !== undefined) {
        clearTimer(usbInterval);
        usbInterval = undefined;
      }
      if (bridgeStart) {
        const starting = bridgeStart;
        bridgeStart = undefined;
        try {
          await starting;
        } catch {
          // A failed start has no server to close.
        }
      }
      try {
        if (bridge && !bridgeStopped) {
          bridgeStopped = true;
          await bridge.stop();
        }
      } finally {
        // The child must die even if stopping the bridge fails.
        if (engine && !engineKilled) {
          engineKilled = true;
          engine.kill();
        }
      }
    };
    cleanupTail = cleanupTail.then(run, run).catch((err) => {
      error('cleanup failed:', err);
    });
    return cleanupTail;
  }

  function handleSignal() {
    aborted = true;
    abortStartup();
    return cleanup();
  }

  const signals = ['SIGINT', 'SIGTERM'];
  // Installed before spawn so an early Ctrl-C cannot hit Node's default exit
  // and orphan the child or leave a listening bridge behind.
  for (const signal of signals) onSignal(signal, handleSignal);

  let running = false;
  try {
    engine = spawnChild(spawnStep.command, spawnStep.args, {
      cwd: spawnStep.cwd,
      stdio: 'inherit',
    });
    if (aborted) throw new Error('startup aborted');

    bridge = makeBridge({ adb: adbClient, port: bridgeStep.port });
    bridgeStart = bridge.start();
    const { address } = await bridgeStart;
    bridgeStart = undefined;
    log(`control bridge listening at ${address}`);
    if (aborted) throw new Error('startup aborted');

    const readiness = checkEngine(ENGINE_URL);
    readiness.catch(() => {}); // consumed by the race if an abort wins first
    const ready = await Promise.race([readiness, startupAbort.then(() => ABORTED)]);
    if (ready === ABORTED || aborted) throw new Error('startup aborted');

    usbInterval = setTimer(() => {
      adbClient.ensureUsbOnly().catch((err) => error('USB re-check failed:', err));
    }, USB_RECHECK_MS);
    running = true;
  } catch (err) {
    await cleanup();
    throw err;
  } finally {
    if (!running) {
      await cleanup();
      for (const signal of signals) offSignal(signal, handleSignal);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
