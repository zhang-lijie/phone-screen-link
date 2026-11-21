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

export async function main() {
  const projectDir = dirname(engineDir());
  const [, copyStep, spawnStep, bridgeStep] = buildPlan({
    engineDir: engineDir(),
    webDir: join(projectDir, 'web'),
  });

  await adb.ensureUsbOnly();

  copyWeb(copyStep, join(spawnStep.cwd, 'dist', 'public'));

  const engine = spawn(spawnStep.command, spawnStep.args, {
    cwd: spawnStep.cwd,
    stdio: 'inherit',
  });

  const bridge = createBridge({ adb, port: bridgeStep.port });
  const { address } = await bridge.start();
  console.log(`control bridge listening at ${address}`);

  await waitForEngine(ENGINE_URL);

  const usbInterval = setInterval(() => {
    adb.ensureUsbOnly().catch((err) => console.error('USB re-check failed:', err));
  }, USB_RECHECK_MS);

  const shutdown = async () => {
    clearInterval(usbInterval);
    try {
      await bridge.stop();
    } finally {
      engine.kill();
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shutdown().catch((err) => {
        console.error(err);
        process.exitCode = 1;
      });
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
