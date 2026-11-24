import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KEY_CODES } from '../shared/keys.mjs';

// Device serial can be set via env so swapping phones needs no code change.
export const DEFAULT_USB_SERIAL = process.env.PHONE_SERIAL || '2FD0221C09004177';
export const WIFI_ADDRESS = '192.168.3.123:5555';

const execFileAsync = promisify(execFile);

async function defaultRunner(args) {
  const { stdout } = await execFileAsync('adb', args);
  return stdout;
}

export function parseDevices(text) {
  return text.split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[1] === 'device')
    .map((fields) => fields[0]);
}

export function createAdb(runner = defaultRunner) {
  async function list() {
    return parseDevices(await runner(['devices']));
  }

  return {
    list,

    async ensureUsbOnly() {
      if ((await list()).includes(WIFI_ADDRESS)) {
        await runner(['disconnect', WIFI_ADDRESS]);
      }
    },

    async keyEvent(key) {
      if (!Object.hasOwn(KEY_CODES, key)) {
        throw new Error('unknown key');
      }
      await runner(['-s', DEFAULT_USB_SERIAL, 'shell', 'input', 'keyevent', String(KEY_CODES[key])]);
    },

    async isOnline() {
      return (await list()).includes(DEFAULT_USB_SERIAL);
    },

    // Wake the screen without unlocking (KEYCODE_WAKEUP = 224). Never bypasses
    // the keyguard; the chat lock gate still rejects locked devices.
    async wakeScreen() {
      await runner(['-s', DEFAULT_USB_SERIAL, 'shell', 'input', 'keyevent', '224']);
    },

    async getScreenTimeout() {
      const out = await runner(['-s', DEFAULT_USB_SERIAL, 'shell', 'settings', 'get', 'system', 'screen_off_timeout']);
      const ms = Number.parseInt(String(out).trim(), 10);
      return Number.isFinite(ms) ? ms : null;
    },

    async setScreenTimeout(ms) {
      await runner(['-s', DEFAULT_USB_SERIAL, 'shell', 'settings', 'put', 'system', 'screen_off_timeout', String(ms)]);
    },

    // Real lock/sleep state from ADB. ghost's get_phone_state returns the
    // current app/activity only (no lock info), so the chat gate uses this
    // instead. Unreadable state fails closed: a possibly locked device must
    // never reach the model or action tools.
    async isLocked() {
      const serialArgs = ['-s', DEFAULT_USB_SERIAL, 'shell'];
      const power = await runner([...serialArgs, 'dumpsys', 'power']);
      const wake = /mWakefulness=(\w+)/.exec(power)?.[1];
      if (wake !== 'Awake') return true; // asleep or unreadable
      const trust = await runner([...serialArgs, 'dumpsys', 'trust']);
      return /deviceLocked=1\b/.test(trust);
    },
  };
}

export const adb = createAdb();
