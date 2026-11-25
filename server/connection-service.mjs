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

export function createConnectionService({ adb, store, usbSerial }) {
  let mutationTail = Promise.resolve();

  function serializeMutation(work) {
    const result = mutationTail.then(work);
    mutationTail = result.catch(() => {});
    return result;
  }

  async function status() {
    const mode = adb.getMode();
    const serial = adb.getSerial();
    return { mode, serial, online: await adb.isOnline() };
  }

  // Activation and persistence have committed. A status probe is diagnostic:
  // its failure must not report the completed mutation as failed. The pair
  // transaction already proved the wireless endpoint online; USB has no such
  // proof, so a failed USB probe is reported as offline.
  async function committedStatus(mode, serial, knownOnline) {
    try {
      return await status();
    } catch {
      return { mode, serial, online: knownOnline };
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

  return { status, pairAndConnect, switchToUsb };
}
