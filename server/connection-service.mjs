import { performance } from 'node:perf_hooks';
import { isMissingAdbError } from './adb.mjs';
import { isWirelessSerial } from './connection-config.mjs';
import { WIRELESS_AUTO_WARNING_CODES } from '../shared/keys.mjs';

const MDNS_POLL_INTERVAL_MS = 500;
const MDNS_POLL_TIMEOUT_MS = 8_000;
const LEGACY_WARNING_THROTTLE_MS = 60_000;
// EMUI restarts adbd when `adb tcpip` runs. The first connect after that can
// be refused for a second or two, so allow a short bounded settle window.
const LEGACY_SETTLE_WINDOW_MS = 3_000;
const LEGACY_SETTLE_DELAYS_MS = [250, 500, 1_000, 1_000];
const PAIRING_SERVICE = '_adb-tls-pairing._tcp';
const CONNECT_SERVICE = '_adb-tls-connect._tcp';

function defaultSleep(ms) {
  let timer;
  const promise = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  promise.cancel = () => clearTimeout(timer);
  return promise;
}

function usbOfflineError() {
  return Object.assign(new Error('USB device is offline'), { code: 'USB_OFFLINE' });
}

function adbFailureText(err) {
  const output = [err?.stderr, err?.stdout]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .map((value) => String(value));
  if (output.length > 0) return output.join('\n');
  return err instanceof Error ? err.message : String(err ?? '');
}

function isExplicitUsbOfflineError(err) {
  const output = adbFailureText(err);
  return /(?:^|\n)[ \t]*(?:adb:[ \t]*)?(?:error:[ \t]*)?device(?:[ \t]+(?:'[^']+'|"[^"]+"))?(?:[ \t]+is)?[ \t]+(?:not[ \t]+found|offline)\b/i.test(output);
}

function matchingPort(services, service, host) {
  return services.find((entry) => entry.service === service && entry.host === host)?.port ?? null;
}

function endpointPort(address) {
  const match = /:(\d+)$/.exec(String(address ?? '').trim());
  return match ? Number(match[1]) : null;
}

function normalizeHost(value, field) {
  const host = typeof value === 'string' ? value.trim() : '';
  let valid;
  if (/^[\d.]+$/.test(host)) {
    const parts = host.split('.');
    valid = parts.length === 4 && parts.every((part) => (
      /^\d{1,3}$/.test(part) && Number(part) <= 255
    ));
  } else {
    valid = host.length <= 253 && host.split('.').every((label) => (
      label.length >= 1
      && label.length <= 63
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    ));
  }
  if (!valid) throw new Error(`${field} must be a valid IPv4 address or hostname`);
  return host;
}

function normalizePort(value, field) {
  const text = typeof value === 'string' ? value.trim() : value;
  const port = typeof text === 'number' ? text : (
    typeof text === 'string' && /^\d+$/.test(text) ? Number(text) : NaN
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${field} must be an integer between 1 and 65535`);
  }
  return port;
}

function redactedError(err, pairingCode) {
  const detail = err instanceof Error ? err.message : String(err ?? 'wireless connection failed');
  const redacted = detail.split(pairingCode).join('[redacted]');
  return new Error(redacted || 'wireless connection failed');
}

export function createConnectionService({
  adb,
  store,
  usbSerial,
  sleep = defaultSleep,
  deadlineWait = defaultSleep,
  now = () => performance.now(),
  warn = (message) => console.warn(message),
}) {
  let mutationTail = Promise.resolve();
  let lastLegacyWarning = null;

  function serializeMutation(work) {
    const result = mutationTail.then(work);
    mutationTail = result.catch(() => {});
    return result;
  }

  async function targetedDeviceOnline(serial) {
    try {
      return String(await adb.getState(serial)).trim() === 'device';
    } catch {
      return false;
    }
  }

  function currentMethod() {
    return typeof adb.getMethod === 'function' ? adb.getMethod() : 'pair';
  }

  // A legacy bootstrap can fail on every supervision tick while the phone is
  // asleep or unplugged. Warn once per outage window instead of flooding logs.
  function warnLegacyBootstrapFailure(address, cause) {
    const key = String(address);
    const at = now();
    if (lastLegacyWarning && lastLegacyWarning.key === key
      && at - lastLegacyWarning.at < LEGACY_WARNING_THROTTLE_MS) return;
    lastLegacyWarning = { key, at };
    const detail = cause ? `: ${adbFailureText(cause)}` : '';
    warn(`legacy wireless bootstrap failed for ${key}${detail}`);
  }

  // Only explicit device absence is a 409. ADB/server failures are host-side
  // problems and must stay distinguishable as 502 at the bridge.
  async function requireUsbOnline() {
    let state;
    try {
      state = String(await adb.getState(usbSerial)).trim();
    } catch (err) {
      if (isMissingAdbError(err) || !isExplicitUsbOfflineError(err)) throw err;
      throw usbOfflineError();
    }
    if (state !== 'device') throw usbOfflineError();
  }

  // Only a bootstrap-triggered connect gets a settle window: pair mode must
  // keep its original single attempt, and a manual legacy connect without
  // tcpip has nothing to wait for. The injected clock bounds the window even
  // if an injected sleep implementation does not advance time.
  async function connectAndConfirm(address, settle) {
    const deadline = now() + LEGACY_SETTLE_WINDOW_MS;
    let lastConnectError = null;
    for (let attempt = 0; ; attempt += 1) {
      let connectOk = false;
      try {
        await adb.connect(address);
        connectOk = true;
        lastConnectError = null;
      } catch (err) {
        if (!settle) throw err;
        lastConnectError = err;
      }
      // A rejected connect must never be treated as success just because a
      // stale previous endpoint still reports `device`.
      if (connectOk) {
        let online = false;
        try {
          online = String(await adb.getState(address)).trim() === 'device';
        } catch {
          // A nonzero get-state is how adb reports an offline or unknown device.
        }
        if (online) return true;
      }
      if (!settle || attempt >= LEGACY_SETTLE_DELAYS_MS.length) break;
      const delay = LEGACY_SETTLE_DELAYS_MS[attempt];
      if (now() + delay > deadline) break;
      await sleep(delay);
    }
    if (settle && lastConnectError) throw lastConnectError;
    return false;
  }

  async function status() {
    const mode = adb.getMode();
    const serial = adb.getSerial();
    const online = mode === 'usb'
      ? await targetedDeviceOnline(serial)
      : await adb.isOnline();
    const usbOnline = mode === 'usb' && serial === usbSerial
      ? online
      : await targetedDeviceOnline(usbSerial);
    return { mode, serial, online, usbOnline, method: currentMethod() };
  }

  // Activation and persistence have committed. A status probe is diagnostic:
  // its failure must not report the completed mutation as failed. The pair
  // transaction already proved the wireless endpoint online; USB has no such
  // proof, so a failed USB probe is reported as offline.
  async function committedStatus(mode, serial, knownOnline) {
    try {
      return await status();
    } catch {
      return { mode, serial, online: knownOnline, usbOnline: false, method: currentMethod() };
    }
  }

  async function pairAndConnect(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('pairing input is required');
    }
    const pairHost = normalizeHost(input.pairHost, 'pairHost');
    const pairPort = normalizePort(input.pairPort, 'pairPort');
    const pairCode = input.pairCode;
    if (typeof pairCode !== 'string' || !/^\d{6}$/.test(pairCode)) {
      throw new Error('pairCode must be exactly 6 digits');
    }
    const connectHost = normalizeHost(input.connectHost, 'connectHost');
    const connectPort = normalizePort(input.connectPort, 'connectPort');
    const address = `${connectHost}:${connectPort}`;

    return serializeMutation(async () => {
      try {
        await adb.pair({ host: pairHost, port: pairPort, code: pairCode });
      } catch (err) {
        throw redactedError(err, pairCode);
      }
      try {
        await adb.connect(address);
      } catch (err) {
        throw redactedError(err, pairCode);
      }

      let online = false;
      try {
        online = String(await adb.getState(address)).trim() === 'device';
      } catch {
        // A nonzero get-state is how adb reports an offline or unknown device.
      }
      if (!online) throw new Error('wireless device is offline after connect');

      // Disk is the commit record. Do not activate a transport that was not
      // durably selected; save() returns exactly what its atomic rename wrote.
      // The method is explicit so a legacy connection switched back to pairing
      // cannot leave persisted and runtime state disagreeing.
      const saved = store.save({ mode: 'wifi', method: 'pair', address });
      adb.setConnection({ mode: 'wifi', serial: saved.address, method: 'pair', usbSerial });
      return committedStatus('wifi', saved.address, true);
    });
  }

  // User-triggered legacy connect. `adb tcpip` restarts adbd over USB, so it
  // is never attempted unless the caller asked for bootstrap and USB is
  // online. Disk and the active transport change only after a healthy target.
  async function connectLegacy(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('legacy input is required');
    }
    const host = normalizeHost(input.host, 'host');
    const port = normalizePort(input.port, 'port');
    const enableTcpip = input.enableTcpip === undefined ? false : input.enableTcpip;
    if (typeof enableTcpip !== 'boolean') {
      throw new Error('enableTcpip must be a boolean');
    }
    const address = `${host}:${port}`;

    return serializeMutation(async () => {
      if (enableTcpip) {
        try {
          await requireUsbOnline();
          await adb.tcpip(usbSerial, port);
        } catch (err) {
          warnLegacyBootstrapFailure(address, err);
          throw err;
        }
      }

      let online = false;
      try {
        online = await connectAndConfirm(address, enableTcpip);
      } catch (err) {
        if (enableTcpip) warnLegacyBootstrapFailure(address, err);
        throw err;
      }
      if (!online) {
        if (enableTcpip) warnLegacyBootstrapFailure(address);
        throw new Error('wireless device is offline after connect');
      }

      const saved = store.save({ mode: 'wifi', method: 'legacy', address });
      adb.setConnection({ mode: 'wifi', serial: saved.address, method: 'legacy', usbSerial });
      return committedStatus('wifi', saved.address, true);
    });
  }

  function switchToUsb() {
    return serializeMutation(async () => {
      store.save({ mode: 'usb', method: 'pair', address: '' });
      adb.setConnection({ mode: 'usb', serial: usbSerial, method: 'pair', usbSerial });
      return committedStatus('usb', usbSerial, false);
    });
  }

  // The supervision timer calls this instead of reaching into ADB directly:
  // it keeps the configured USB serial and current method in one place and
  // throttles repeated legacy bootstrap failures.
  async function supervise() {
    const mode = typeof adb.getMode === 'function' ? adb.getMode() : 'usb';
    if (mode !== 'wifi') {
      await adb.ensureUsbOnly();
      // A phone swap changes its USB serial. Keep the old target only while it
      // is present; when exactly one physical USB device is online, adopt it
      // so the bridge, ghost and the page all follow the same phone. Multiple
      // candidates are deliberately left alone rather than guessing.
      return serializeMutation(async () => {
        if (adb.getMode() !== 'usb') return;
        const active = adb.getSerial();
        const devices = (await adb.list()).filter((serial) => (
          typeof serial === 'string'
          && serial.length > 0
          && !isWirelessSerial(serial)
          && !serial.startsWith('emulator-')
        ));
        if (devices.includes(active) || devices.length !== 1) return;
        const candidate = devices[0];
        usbSerial = candidate;
        adb.setConnection({
          mode: 'usb',
          serial: candidate,
          method: currentMethod(),
          usbSerial: candidate,
        });
      });
    }
    const serial = adb.getSerial();
    const method = currentMethod();
    const online = await adb.ensureWirelessConnected(serial, {
      method,
      port: endpointPort(serial),
      usbSerial,
    });
    if (method === 'legacy' && online === false) warnLegacyBootstrapFailure(serial);
    return online;
  }

  // A runner may ignore cancellation, so the deadline is enforced by a race as
  // well as AbortSignal. The signal terminates the real execFile child; the race
  // guarantees that a stuck injected/custom runner cannot hold the request open.
  async function mdnsBeforeDeadline(deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) return [];

    const controller = new AbortController();
    const invocation = (async () => {
      try {
        const services = await adb.mdnsServices({ signal: controller.signal });
        if (controller.signal.aborted || now() >= deadline) {
          controller.abort();
          return [];
        }
        return services;
      } catch {
        return [];
      }
    })();

    const delay = deadlineWait(remaining);
    const expiry = delay.then(() => {
      controller.abort();
      return [];
    });
    try {
      return await Promise.race([invocation, expiry]);
    } finally {
      delay.cancel?.();
    }
  }

  // Read-only discovery is deliberately outside the mutation queue: it always
  // targets the configured USB serial and never activates or persists what it
  // finds. Missing endpoints are partial success, not a failed transaction.
  async function discoverWirelessConfig() {
    await requireUsbOnline();

    const host = await adb.getWifiIp(usbSerial);
    let connectPort = null;
    try {
      connectPort = (await adb.getWirelessConnectPort(usbSerial)) ?? null;
    } catch {
      // The IP is still useful when the TLS property cannot be read; mDNS
      // below may provide the connect endpoint instead.
    }
    let pairPort = null;

    if (host) {
      const deadline = now() + MDNS_POLL_TIMEOUT_MS;
      while (now() < deadline) {
        let services = [];
        try {
          services = await mdnsBeforeDeadline(deadline);
        } catch {
          // mDNS can be unavailable or still starting. Preserve the USB data
          // and keep polling rather than discarding a useful partial result.
        }
        pairPort = matchingPort(services, PAIRING_SERVICE, host);
        if (connectPort === null) {
          connectPort = matchingPort(services, CONNECT_SERVICE, host);
        }
        if (pairPort !== null) break;
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await sleep(Math.min(MDNS_POLL_INTERVAL_MS, remaining));
      }
    }

    const warnings = [];
    if (!host) warnings.push(WIRELESS_AUTO_WARNING_CODES.WIFI_IP_UNAVAILABLE);
    if (connectPort === null) {
      warnings.push(WIRELESS_AUTO_WARNING_CODES.CONNECT_PORT_UNAVAILABLE);
    }
    if (pairPort === null) {
      warnings.push(WIRELESS_AUTO_WARNING_CODES.PAIRING_PORT_UNAVAILABLE);
    }

    return {
      usbSerial,
      pairHost: host,
      pairPort,
      connectHost: host,
      connectPort,
      warnings,
    };
  }

  return { status, pairAndConnect, connectLegacy, switchToUsb, discoverWirelessConfig, supervise };
}
