import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KEY_CODES } from '../shared/keys.mjs';

export const DEFAULT_USB_SERIAL = '2FD0221C09004177';
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
  };
}

export const adb = createAdb();
