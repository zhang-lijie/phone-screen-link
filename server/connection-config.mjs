import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const FALLBACK_USB_SERIAL = '2FD0221C09004177';
export const DEFAULT_CONNECTION_CONFIG = Object.freeze({ mode: 'usb', address: '' });

// This is endpoint detection, not request validation. It recognizes the
// host:port serials ADB uses without mistaking emulator-5554 or a USB serial
// for a wireless address. Full pairing-input validation belongs to the API.
export function isWirelessSerial(value) {
  if (typeof value !== 'string') return false;
  const serial = value.trim();
  if (/^emulator-\d+$/.test(serial)) return false;
  const match = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\]):(\d+)$/.exec(serial);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}

function normalizeConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_CONNECTION_CONFIG };
  }
  if (value.mode !== 'usb' && value.mode !== 'wifi') {
    return { ...DEFAULT_CONNECTION_CONFIG };
  }
  if (typeof value.address !== 'string') {
    return { ...DEFAULT_CONNECTION_CONFIG };
  }
  return {
    mode: value.mode,
    address: value.mode === 'wifi' ? value.address.trim() : '',
  };
}

export function resolveInitialConnection({
  env = {},
  stored = {},
  usbSerial = FALLBACK_USB_SERIAL,
} = {}) {
  const phoneSerial = typeof env.PHONE_SERIAL === 'string' ? env.PHONE_SERIAL.trim() : '';
  if (isWirelessSerial(phoneSerial)) {
    return { mode: 'wifi', serial: phoneSerial };
  }

  const explicitUsbSerial = typeof env.PHONE_USB_SERIAL === 'string'
    ? env.PHONE_USB_SERIAL.trim()
    : '';
  if (explicitUsbSerial || phoneSerial) {
    return { mode: 'usb', serial: explicitUsbSerial || phoneSerial };
  }

  if (stored?.mode === 'wifi' && isWirelessSerial(stored.address)) {
    return { mode: 'wifi', serial: stored.address.trim() };
  }

  return { mode: 'usb', serial: usbSerial || FALLBACK_USB_SERIAL };
}

export function createConnectionConfigStore({ file }) {
  function load() {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { ...DEFAULT_CONNECTION_CONFIG };
      throw error;
    }

    let stored;
    try {
      stored = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_CONNECTION_CONFIG };
    }
    return normalizeConfig(stored);
  }

  function save(patch = {}) {
    const config = load();
    if (patch !== null && typeof patch === 'object' && !Array.isArray(patch)) {
      if (patch.mode === 'usb' || patch.mode === 'wifi') config.mode = patch.mode;
      if (typeof patch.address === 'string') config.address = patch.address.trim();
    }
    if (config.mode === 'usb') config.address = '';

    mkdirSync(dirname(file), { recursive: true });
    // A same-directory temp file + rename prevents readers from observing a
    // partial config. Removing a stale temp first also guarantees mode 0600
    // when replacing a pre-existing, more permissive file.
    const tmp = `${file}.tmp`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return publicConfig();
  }

  function publicConfig() {
    return load();
  }

  return { load, save, publicConfig };
}
