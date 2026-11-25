import { performance } from 'node:perf_hooks';
import { isMissingAdbError } from './adb.mjs';
import { WIRELESS_AUTO_WARNING_CODES } from '../shared/keys.mjs';

const MDNS_POLL_INTERVAL_MS = 500;
const MDNS_POLL_TIMEOUT_MS = 8_000;
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

export function createConnectionService({ adb, store, usbSerial, sleep = defaultSleep, deadlineWait = defaultSleep, now = () => performance.now() }) {
  let mutationTail = Promise.resolve();

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

  async function status() {
    const mode = adb.getMode();
    const serial = adb.getSerial();
    const online = mode === 'usb'
      ? await targetedDeviceOnline(serial)
      : await adb.isOnline();
    const usbOnline = mode === 'usb' && serial === usbSerial
      ? online
      : await targetedDeviceOnline(usbSerial);
    return { mode, serial, online, usbOnline };
  }

  // Activation and persistence have committed. A status probe is diagnostic:
  // its failure must not report the completed mutation as failed. The pair
  // transaction already proved the wireless endpoint online; USB has no such
  // proof, so a failed USB probe is reported as offline.
  async function committedStatus(mode, serial, knownOnline) {
    try {
      return await status();
    } catch {
      return { mode, serial, online: knownOnline, usbOnline: false };
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
      const saved = store.save({ mode: 'wifi', address });
      adb.setConnection({ mode: 'wifi', serial: saved.address });
      return committedStatus('wifi', saved.address, true);
    });
  }

  function switchToUsb() {
    return serializeMutation(async () => {
      store.save({ mode: 'usb', address: '' });
      adb.setConnection({ mode: 'usb', serial: usbSerial });
      return committedStatus('usb', usbSerial, false);
    });
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
    let usbState;
    try {
      usbState = String(await adb.getState(usbSerial)).trim();
    } catch (err) {
      // ADB exits nonzero for an absent serial, but the same shape carries
      // server/permission failures. Only explicit device absence is a 409;
      // every other host-side failure must reach the bridge as a 502.
      if (isMissingAdbError(err) || !isExplicitUsbOfflineError(err)) throw err;
      throw usbOfflineError();
    }
    if (usbState !== 'device') throw usbOfflineError();

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

  return { status, pairAndConnect, switchToUsb, discoverWirelessConfig };
}
