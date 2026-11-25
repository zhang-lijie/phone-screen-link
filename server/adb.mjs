import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { KEY_CODES } from '../shared/keys.mjs';

// Device serial can be set via env so swapping phones needs no code change.
export const DEFAULT_USB_SERIAL = process.env.PHONE_SERIAL || '2FD0221C09004177';
export const WIFI_ADDRESS = '192.168.3.123:5555';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const adbExeName = process.platform === 'win32' ? 'adb.exe' : 'adb';

const execFileAsync = promisify(execFile);

// The engine resolves adb from its own dependencies folder (never PATH), and
// installs it there in the background after the HTTP server starts. The bridge
// must do the same, or a machine with no system adb never gets key controls.
export function bundledAdbDir(root = projectDir) {
  return join(root, 'engine', 'dependencies', 'adb');
}

export function bundledAdbPath(root = projectDir) {
  return join(bundledAdbDir(root), adbExeName);
}

// Resolved on every call, not at import time: on a first run the bundled adb
// does not exist yet and only appears once the engine's background dependency
// install finishes. A cached answer would stay "not found" until restart.
export function resolveAdbCommand({
  env = process.env,
  exists = existsSync,
  root = projectDir,
} = {}) {
  if (env.PHONE_ADB) return env.PHONE_ADB;
  const bundled = bundledAdbPath(root);
  return exists(bundled) ? bundled : 'adb';
}

// ENOENT is how execFile reports "no adb anywhere on PATH". Startup treats it
// as "not installed yet", not as a fatal error.
export function isMissingAdbError(err) {
  return err?.code === 'ENOENT';
}

async function defaultRunner(args) {
  const { stdout } = await execFileAsync(resolveAdbCommand(), args);
  return stdout;
}

export function parseDevices(text) {
  return text.split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[1] === 'device')
    .map((fields) => fields[0]);
}

// `adb devices -l` states that are worth showing in the picker. A phone that
// has not authorised this host is still listed, so the user sees why it cannot
// be selected instead of wondering where the phone went.
const USB_STATES = new Set([
  'device', 'unauthorized', 'offline', 'bootloader', 'recovery', 'sideload',
  'connecting', 'authorizing',
]);

// Network transports (host:port) are out of scope: the bridge disconnects the
// known wifi address and mirrors USB only.
export function parseDeviceList(text) {
  return String(text).split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((fields) => fields.length >= 2
      && USB_STATES.has(fields[1])
      && !fields[0].includes(':'))
    .map((fields) => {
      const info = {};
      for (const field of fields.slice(2)) {
        const at = field.indexOf(':');
        if (at <= 0) continue;
        const key = field.slice(0, at);
        if (key === 'usb') info.transport = field;
        else if (key === 'model' || key === 'product') {
          // adb turns spaces in model names into underscores.
          info[key] = field.slice(at + 1).replace(/_/g, ' ');
        }
      }
      return {
        serial: fields[0],
        state: fields[1],
        model: info.model ?? '',
        product: info.product ?? '',
        transport: info.transport ?? '',
        selectable: fields[1] === 'device',
      };
    });
}

export function createAdb(runner = defaultRunner) {
  async function list() {
    return parseDevices(await runner(['devices']));
  }

  async function listDevices() {
    try {
      return parseDeviceList(await runner(['devices', '-l']));
    } catch (err) {
      // A fresh install has no adb until the engine's download completes;
      // that is "no devices yet", not a bridge error.
      if (isMissingAdbError(err)) return [];
      throw err;
    }
  }

  return {
    list,
    listDevices,

    async ensureUsbOnly() {
      if ((await list()).includes(WIFI_ADDRESS)) {
        await runner(['disconnect', WIFI_ADDRESS]);
      }
    },

    async keyEvent(key, serial = DEFAULT_USB_SERIAL) {
      if (!Object.hasOwn(KEY_CODES, key)) {
        throw new Error('unknown key');
      }
      await runner(['-s', serial, 'shell', 'input', 'keyevent', String(KEY_CODES[key])]);
    },

    async isOnline(serial = DEFAULT_USB_SERIAL) {
      return (await list()).includes(serial);
    },

    // Wake the screen without unlocking (KEYCODE_WAKEUP = 224). Never bypasses
    // the keyguard; the chat lock gate still rejects locked devices.
    async wakeScreen(serial = DEFAULT_USB_SERIAL) {
      await runner(['-s', serial, 'shell', 'input', 'keyevent', '224']);
    },

    async getScreenTimeout(serial = DEFAULT_USB_SERIAL) {
      const out = await runner(['-s', serial, 'shell', 'settings', 'get', 'system', 'screen_off_timeout']);
      const ms = Number.parseInt(String(out).trim(), 10);
      return Number.isFinite(ms) ? ms : null;
    },

    async setScreenTimeout(ms, serial = DEFAULT_USB_SERIAL) {
      await runner(['-s', serial, 'shell', 'settings', 'put', 'system', 'screen_off_timeout', String(ms)]);
    },

    // Real lock/sleep state from ADB. ghost's get_phone_state returns the
    // current app/activity only (no lock info), so the chat gate uses this
    // instead. Unreadable state fails closed: a possibly locked device must
    // never reach the model or action tools.
    async isLocked(serial = DEFAULT_USB_SERIAL) {
      const serialArgs = ['-s', serial, 'shell'];
      const power = await runner([...serialArgs, 'dumpsys', 'power']);
      const wake = /mWakefulness=(\w+)/.exec(power)?.[1];
      if (wake !== 'Awake') return true; // asleep or unreadable
      const trust = await runner([...serialArgs, 'dumpsys', 'trust']);
      return /deviceLocked=1\b/.test(trust);
    },
  };
}

export const adb = createAdb();
