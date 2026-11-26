import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
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

async function defaultRunner(args, { signal } = {}) {
  const { stdout } = await execFileAsync(resolveAdbCommand(), args, { signal });
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

const ADB_TLS_SERVICES = new Set([
  '_adb-tls-pairing._tcp',
  '_adb-tls-connect._tcp',
]);

// After `adb tcpip`, adbd restarts its TCP listener. EMUI can take ~1-2s
// before `adb connect` succeeds, so post-bootstrap connects settle briefly.
const LEGACY_SETTLE_WINDOW_MS = 3_000;
const LEGACY_SETTLE_DELAYS_MS = [250, 500, 1_000, 1_000];

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function parseIpv4(value) {
  const address = String(value ?? '').trim();
  return isIP(address) === 4 ? address : null;
}

function parsePort(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function parseEndpointPort(address) {
  const match = /:(\d+)$/.exec(String(address ?? '').trim());
  return match ? parsePort(match[1]) : null;
}

export function parseWifiIp(text) {
  const output = String(text ?? '');
  for (const match of output.matchAll(/\binet\s+(\S+)/g)) {
    const address = parseIpv4(match[1].split('/')[0]);
    if (address) return address;
  }
  const source = /\bsrc\s+(\S+)/.exec(output)?.[1];
  return source ? parseIpv4(source) : null;
}

function parseMdnsEndpoint(value) {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const host = match[1] ?? match[2];
  const port = parsePort(match[3]);
  if (isIP(host) === 0 || port === null) return null;
  return { host, port };
}

export function parseMdnsServices(text) {
  const entries = [];
  for (const line of String(text ?? '').split('\n')) {
    const [service, endpoint] = line.trim().split(/\s+/);
    if (!ADB_TLS_SERVICES.has(service) || !endpoint) continue;
    const parsed = parseMdnsEndpoint(endpoint);
    if (parsed) entries.push({ service, ...parsed });
  }
  return entries;
}

export function createAdb(runner = defaultRunner, {
  serial = DEFAULT_USB_SERIAL,
  mode = 'usb',
  method = 'pair',
  sleep = defaultSleep,
  now = () => performance.now(),
} = {}) {
  let activeSerial = serial;
  let activeMode = mode;
  let activeMethod = method === 'legacy' ? 'legacy' : 'pair';
  // Supervision runs on a timer outside the connection service, so the last
  // USB serial selected by a mutation must be remembered here. Otherwise a
  // legacy bootstrap would always fall back to the module-level default.
  let activeUsbSerial = DEFAULT_USB_SERIAL;
  let legacyBootstrapKey = null;

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

  async function getState(deviceSerial = activeSerial) {
    return runner(['-s', deviceSerial, 'get-state']);
  }

  async function getWifiIp(deviceSerial = activeSerial) {
    const serialArgs = ['-s', deviceSerial, 'shell'];
    let addresses;
    try {
      addresses = await runner([...serialArgs, 'ip', '-f', 'inet', 'addr', 'show', 'wlan0']);
    } catch {
      addresses = '';
    }
    const address = parseWifiIp(addresses);
    if (address) return address;
    const routes = await runner([...serialArgs, 'ip', 'route', 'show', 'dev', 'wlan0']).catch(() => '');
    return parseWifiIp(routes);
  }

  async function getWirelessConnectPort(deviceSerial = activeSerial) {
    const output = await runner([
      '-s', deviceSerial, 'shell', 'getprop', 'service.adb.tls.port',
    ]);
    return parsePort(output);
  }

  async function mdnsServices({ signal } = {}) {
    return parseMdnsServices(await runner(['mdns', 'services'], { signal }));
  }

  async function wirelessIsOnline(address) {
    try {
      return String(await getState(address)).trim() === 'device';
    } catch {
      return false;
    }
  }

  // Retry only connect + target state, never tcpip: adbd has already been
  // restarted once and overlapping ticks must not restart it again.
  async function connectAfterBootstrap(address) {
    const deadline = now() + LEGACY_SETTLE_WINDOW_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await runner(['connect', address]);
        if (await wirelessIsOnline(address)) return true;
      } catch {
        // A refused connect or offline get-state is expected during restart.
      }
      if (attempt >= LEGACY_SETTLE_DELAYS_MS.length) return false;
      const delay = LEGACY_SETTLE_DELAYS_MS[attempt];
      if (now() + delay > deadline) return false;
      await sleep(delay);
    }
  }

  return {
    list,
    listDevices,

    getSerial() {
      return activeSerial;
    },

    getMode() {
      return activeMode;
    },

    getMethod() {
      return activeMethod;
    },

    setConnection({ mode: nextMode, serial: nextSerial, method: nextMethod, usbSerial: nextUsbSerial }) {
      activeMode = nextMode;
      activeSerial = nextSerial;
      activeMethod = nextMethod === 'legacy' ? 'legacy' : 'pair';
      if (typeof nextUsbSerial === 'string' && nextUsbSerial.trim()) {
        activeUsbSerial = nextUsbSerial.trim();
      } else if (nextMode === 'usb' && typeof nextSerial === 'string'
        && !isWirelessSerial(nextSerial)) {
        activeUsbSerial = nextSerial;
      }
      legacyBootstrapKey = null;
    },

    async pair({ host, port, code }) {
      return runner(['pair', `${host}:${port}`, String(code)]);
    },

    async connect(address) {
      return runner(['connect', address]);
    },

    async tcpip(deviceSerial, port) {
      return runner(['-s', deviceSerial, 'tcpip', String(port)]);
    },

    getState,
    getWifiIp,
    getWirelessConnectPort,
    mdnsServices,

    async ensureWirelessConnected(address, {
      method = activeMethod,
      port,
      usbSerial = activeUsbSerial,
    } = {}) {
      const tcpipPort = parsePort(port ?? parseEndpointPort(address));
      const bootstrapKey = method === 'legacy'
        ? JSON.stringify([address, usbSerial, tcpipPort])
        : null;
      if (await wirelessIsOnline(address)) {
        if (legacyBootstrapKey === bootstrapKey) legacyBootstrapKey = null;
        return true;
      }

      // Pairing-mode supervision keeps its original reconnect behavior. Legacy
      // mode may recover a dead TCP listener through an online USB transport.
      if (method !== 'legacy') {
        await runner(['connect', address]);
        return wirelessIsOnline(address);
      }

      try {
        await runner(['connect', address]);
      } catch {
        // A rejected connect is the expected first symptom of a stopped adbd.
      }
      if (await wirelessIsOnline(address)) {
        if (legacyBootstrapKey === bootstrapKey) legacyBootstrapKey = null;
        return true;
      }
      if (tcpipPort === null || legacyBootstrapKey === bootstrapKey) return false;
      if (!(await wirelessIsOnline(usbSerial))) return false;

      // Mark before invoking adb: overlapping maintenance ticks must not restart
      // adbd twice. A later healthy probe clears the marker for the next outage.
      legacyBootstrapKey = bootstrapKey;
      try {
        await runner(['-s', usbSerial, 'tcpip', String(tcpipPort)]);
      } catch {
        return false;
      }
      const online = await connectAfterBootstrap(address);
      if (online) legacyBootstrapKey = null;
      return online;
    },

    async ensureUsbOnly() {
      if (activeMode !== 'usb') return;
      const devices = await list();
      // Pairing can switch modes while `adb devices` is in flight. Re-check
      // before disconnecting so an active wireless transport is never torn down.
      if (activeMode === 'usb' && devices.includes(WIFI_ADDRESS)) {
        await runner(['disconnect', WIFI_ADDRESS]);
      }
    },

    async keyEvent(key, serial = activeSerial) {
      if (!Object.hasOwn(KEY_CODES, key)) {
        throw new Error('unknown key');
      }
      await runner(['-s', serial, 'shell', 'input', 'keyevent', String(KEY_CODES[key])]);
    },

    async isOnline(serial = activeSerial) {
      // A call for the active wireless endpoint must use get-state, not the
      // USB-only `devices` list. An explicit override addresses a USB device.
      if (serial === activeSerial && activeMode === 'wifi') return wirelessIsOnline(serial);
      return (await list()).includes(serial);
    },

    // Wake the screen without unlocking (KEYCODE_WAKEUP = 224). Never bypasses
    // the keyguard; the chat lock gate still rejects locked devices.
    async wakeScreen(serial = activeSerial) {
      await runner(['-s', serial, 'shell', 'input', 'keyevent', '224']);
    },

    async getScreenTimeout(serial = activeSerial) {
      const out = await runner(['-s', serial, 'shell', 'settings', 'get', 'system', 'screen_off_timeout']);
      const ms = Number.parseInt(String(out).trim(), 10);
      return Number.isFinite(ms) ? ms : null;
    },

    async setScreenTimeout(ms, serial = activeSerial) {
      await runner(['-s', serial, 'shell', 'settings', 'put', 'system', 'screen_off_timeout', String(ms)]);
    },

    // Real lock/sleep state from ADB. ghost's get_phone_state returns the
    // current app/activity only (no lock info), so the chat gate uses this
    // instead. Unreadable state fails closed: a possibly locked device must
    // never reach the model or action tools.
    async isLocked(deviceSerial = activeSerial) {
      const serialArgs = ['-s', deviceSerial, 'shell'];
      const power = await runner([...serialArgs, 'dumpsys', 'power']);
      const wake = /mWakefulness=(\w+)/.exec(power)?.[1];
      if (wake !== 'Awake') return true; // asleep or unreadable
      const trust = await runner([...serialArgs, 'dumpsys', 'trust']);
      return /deviceLocked=1\b/.test(trust);
    },
  };
}

export const adb = createAdb();
