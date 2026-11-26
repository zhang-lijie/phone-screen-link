import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_COMMANDS = ['node scripts/start.mjs', 'node dist/index.js'];
const STOP_TIMEOUT_MS = 5000;

function darwinCwd(pid) {
  const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return /^n(.+)$/m.exec(out)?.[1] ?? null;
}

function defaultCwd(pid) {
  try {
    if (process.platform === 'darwin') return darwinCwd(pid);
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // Unknown process or unsupported platform: rely on the command match.
    return projectDir;
  }
}

export function findAppPids({ psOutput, cwdForPid = defaultCwd, projectDir: root = projectDir } = {}) {
  const pids = [];
  for (const line of String(psOutput ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (!APP_COMMANDS.some((needle) => command.includes(needle))) continue;
    let cwd;
    try {
      cwd = cwdForPid(pid);
    } catch {
      continue;
    }
    if (cwd === root) pids.push(pid);
  }
  return [...new Set(pids)];
}

export async function stopPids({
  pids,
  kill,
  waitForExit,
  log = () => {},
  timeoutMs = STOP_TIMEOUT_MS,
}) {
  if (pids.length === 0) {
    log('No running phone-screen-link process found.');
    return { killed: 0, forceKilled: 0 };
  }

  for (const pid of pids) {
    try {
      kill(pid, 'SIGTERM');
    } catch (error) {
      log(`Could not signal ${pid}: ${error.message}`);
    }
  }

  const survivors = await waitForExit(pids, timeoutMs);
  for (const pid of survivors) {
    try {
      kill(pid, 'SIGKILL');
    } catch (error) {
      log(`Could not force stop ${pid}: ${error.message}`);
    }
  }

  return { killed: pids.length - survivors.length, forceKilled: survivors.length };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter(isAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(100);
    remaining = remaining.filter(isAlive);
  }
  return remaining.filter(isAlive);
}

export async function stopApp() {
  const psOutput = execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' });
  const pids = findAppPids({ psOutput });
  const result = await stopPids({
    pids,
    kill: (pid, signal) => process.kill(pid, signal),
    waitForExit,
    log: console.log,
  });
  console.log(
    `Stopped ${result.killed + result.forceKilled} process(es)${result.forceKilled ? ` (${result.forceKilled} forced)` : ''}.`,
  );
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  stopApp().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
