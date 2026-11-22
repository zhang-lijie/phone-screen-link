import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adb, DEFAULT_USB_SERIAL } from '../server/adb.mjs';
import { runAgentTurn } from '../server/chat-agent.mjs';
import { createChatConfigStore } from '../server/chat-config.mjs';
import { createBridge } from '../server/bridge.mjs';
import { createGhostClient } from '../server/ghost-client.mjs';
import { engineDir } from './setup.mjs';

const BRIDGE_PORT = 8100;
const ENGINE_URL = 'http://127.0.0.1:8000/';
const USB_RECHECK_MS = 5_000;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const GHOST_START_TIMEOUT_MS = 25_000;
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
    // The engine's static server has no `.mjs` MIME type and sets `nosniff`,
    // so the browser-facing copy must end in `.js` to be importable.
    copyFileSync(join(sharedDir, file), join(targetDir, file.replace(/\.mjs$/, '.js')));
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bound a startup promise so a hang cannot hold the rest of startup (or
// cleanup) hostage. The timer is cleared as soon as the promise settles;
// Promise.race keeps a handler on the input, so a late rejection is safe.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The engine resolves an OPTIONAL node-pty dependency on startup and awaits it
// before it starts serving. Its fetch does not use the system HTTPS proxy
// (Node ignores HTTP(S)_PROXY for fetch unless told otherwise), so on a
// proxied network that fetch hangs for 3 x 30s and the engine misses the
// readiness deadline here. These two settings make the same fetch succeed in
// under a second; they only matter when a proxy is configured.
export function engineEnv(env = process.env) {
  const result = {};
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
    result.NODE_USE_ENV_PROXY = '1';
    // A proxy re-signs TLS with its own CA, which Node's bundled root store
    // does not know; the system store does.
    result.NODE_OPTIONS = [env.NODE_OPTIONS, '--use-system-ca'].filter(Boolean).join(' ');
  }
  return result;
}

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
    createChatConfigStore: makeChatConfig = createChatConfigStore,
    createGhostClient: makeGhost = createGhostClient,
    spawn: spawnChild = spawn,
    waitForEngine: checkEngine = waitForEngine,
    engineDir: getEngineDir = engineDir,
    copyWeb: copyFiles = copyWeb,
    setTimer = setInterval,
    clearTimer = clearInterval,
    ghostStartTimeoutMs = GHOST_START_TIMEOUT_MS,
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
  let ghost;
  let ghostStart;
  let ghostStopped = false;
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
      if (ghostStart) {
        const starting = ghostStart;
        ghostStart = undefined;
        try {
          // Same bound as startup: a hanging ghost must not hang cleanup.
          await withTimeout(starting, ghostStartTimeoutMs, 'ghost MCP server start (cleanup)');
        } catch {
          // A failed start is released once by the startup path.
        }
      }
      try {
        if (bridge && !bridgeStopped) {
          bridgeStopped = true;
          await bridge.stop();
        }
      } finally {
        try {
          if (ghost && !ghostStopped) {
            ghostStopped = true;
            await ghost.stop();
          }
        } finally {
          // The child must die even if stopping the bridge or ghost fails.
          if (engine && !engineKilled) {
            engineKilled = true;
            engine.kill();
          }
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
      env: { ...process.env, ...engineEnv() },
    });
    if (aborted) throw new Error('startup aborted');

    // Chat wiring, in order: backend config store, then the ghost MCP tools
    // layer, then the agent loop wrapped for the bridge. None of it may take
    // projection or /keyevent down: when ghost cannot start, chat is simply
    // absent and the bridge reports it as unavailable.
    const chatConfig = makeChatConfig({ file: join(projectDir, 'state', 'chat.json') });
    try {
      ghost = makeGhost({ serial: DEFAULT_USB_SERIAL });
      // A hanging ghost.start() (e.g. uvx stuck downloading) must not block
      // the bridge: bound it and fall into the chat-disabled catch below.
      ghostStart = withTimeout(ghost.start(), ghostStartTimeoutMs, 'ghost MCP server start');
      await ghostStart;
      ghostStart = undefined;
    } catch (err) {
      error('ghost MCP server failed to start; chat disabled:', err);
      if (ghost && !ghostStopped) {
        ghostStopped = true;
        try {
          await ghost.stop(); // release anything a partial start acquired
        } catch {
          // Nothing else to release.
        }
      }
      ghost = undefined;
    }
    if (aborted) throw new Error('startup aborted');

    // The bridge passes the config it already loaded for the enablement gate;
    // re-loading here would race a concurrent settings save (TOCTOU).
    const chat = ghost
      ? {
          run: (userText, lang, config) => runAgentTurn({
            config,
            ghost,
            userText,
            lang,
            // Real lock/sleep state comes from ADB; ghost has no lock tool.
            deps: { isLocked: () => adbClient.isLocked() },
          }),
        }
      : undefined;

    bridge = makeBridge({ adb: adbClient, port: bridgeStep.port, chatConfig, chat });
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
