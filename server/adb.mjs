import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { KEY_CODES } from '../shared/keys.mjs';
import { FALLBACK_USB_SERIAL, isWirelessSerial } from './connection-config.mjs';

// Device serial can be set via env so swapping phones needs no code change.
// A host:port PHONE_SERIAL selects wireless mode; it is never a USB fallback.
const envPhoneSerial = typeof process.env.PHONE_SERIAL === 'string' ? process.env.PHONE_SERIAL.trim() : '';
export const DEFAULT_USB_SERIAL = process.env.PHONE_USB_SERIAL?.trim()
  || (isWirelessSerial(envPhoneSerial) ? '' : envPhoneSerial)
  || FALLBACK_USB_SERIAL;
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

export function createAdb(runner = defaultRunner, {
  serial = DEFAULT_USB_SERIAL,
  mode = 'usb',
} = {}) {
  let activeSerial = serial;
  let activeMode = mode;

  async function list() {
    return parseDevices(await runner(['devices']));
  }

  async function getState(deviceSerial = activeSerial) {
    return runner(['-s', deviceSerial, 'get-state']);
  }

  async function wirelessIsOnline(address) {
    try {
      return String(await getState(address)).trim() === 'device';
    } catch {
      return false;
    }
  }

  return {
    list,

    getSerial() {
      return activeSerial;
    },

    getMode() {
      return activeMode;
    },

    setConnection({ mode: nextMode, serial: nextSerial }) {
      activeMode = nextMode;
      activeSerial = nextSerial;
    },

    async pair({ host, port, code }) {
      return runner(['pair', `${host}:${port}`, String(code)]);
    },

    async connect(address) {
      return runner(['connect', address]);
    },

    getState,

    async ensureWirelessConnected(address) {
      if (await wirelessIsOnline(address)) return true;
      await runner(['connect', address]);
      return wirelessIsOnline(address);
    },

    async ensureUsbOnly() {
      if ((await list()).includes(WIFI_ADDRESS)) {
        await runner(['disconnect', WIFI_ADDRESS]);
      }
    },

    async keyEvent(key) {
      if (!Object.hasOwn(KEY_CODES, key)) {
        throw new Error('unknown key');
      }
      await runner(['-s', activeSerial, 'shell', 'input', 'keyevent', String(KEY_CODES[key])]);
    },

    async isOnline() {
      if (activeMode === 'wifi') return wirelessIsOnline(activeSerial);
      return (await list()).includes(activeSerial);
    },

    // Wake the screen without unlocking (KEYCODE_WAKEUP = 224). Never bypasses
    // the keyguard; the chat lock gate still rejects locked devices.
    async wakeScreen() {
      await runner(['-s', activeSerial, 'shell', 'input', 'keyevent', '224']);
    },

    async getScreenTimeout() {
      const out = await runner(['-s', activeSerial, 'shell', 'settings', 'get', 'system', 'screen_off_timeout']);
      const ms = Number.parseInt(String(out).trim(), 10);
      return Number.isFinite(ms) ? ms : null;
    },

    async setScreenTimeout(ms) {
      await runner(['-s', activeSerial, 'shell', 'settings', 'put', 'system', 'screen_off_timeout', String(ms)]);
    },

    // Real lock/sleep state from ADB. ghost's get_phone_state returns the
    // current app/activity only (no lock info), so the chat gate uses this
    // instead. Unreadable state fails closed: a possibly locked device must
    // never reach the model or action tools.
    async isLocked() {
      const serialArgs = ['-s', activeSerial, 'shell'];
      const power = await runner([...serialArgs, 'dumpsys', 'power']);
      const wake = /mWakefulness=(\w+)/.exec(power)?.[1];
      if (wake !== 'Awake') return true; // asleep or unreadable
      const trust = await runner([...serialArgs, 'dumpsys', 'trust']);
      return /deviceLocked=1\b/.test(trust);
    },
  };
}

export const adb = createAdb();
