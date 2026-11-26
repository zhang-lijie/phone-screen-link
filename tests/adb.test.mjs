import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectionConfigStore } from '../server/connection-config.mjs';
import * as adbModule from '../server/adb.mjs';

const {
  parseDevices,
  parseDeviceList,
  createAdb,
  WIFI_ADDRESS,
  DEFAULT_USB_SERIAL,
  bundledAdbPath,
  isMissingAdbError,
  resolveAdbCommand,
} = adbModule;

const devicesText = `List of devices attached
2FD0221C09004177       device usb:1-5 product:NOH-AN01
192.168.3.123:5555     device product:NOH-AN01
`;

function tempConnectionStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adb-connection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'connection.json');
  return { file, store: createConnectionConfigStore({ file }) };
}

function discoveryExport(name) {
  const value = adbModule[name];
  assert.equal(typeof value, 'function', `${name} must be exported`);
  return value;
}

test('parseDevices returns both transports', () => {
  assert.deepEqual(parseDevices(devicesText), [DEFAULT_USB_SERIAL, WIFI_ADDRESS]);
});

// A fresh install has no system adb; the engine downloads its copy into
// engine/dependencies/adb after it starts serving. The bridge must find that
// copy on every call, so resolution cannot be cached at import time.
test('resolveAdbCommand prefers the engine-bundled adb when it exists', () => {
  const root = '/x';
  const bundled = join(root, 'engine', 'dependencies', 'adb', 'adb');
  assert.equal(bundledAdbPath(root), bundled);
  assert.equal(
    resolveAdbCommand({ root, env: {}, exists: (p) => p === bundled }),
    bundled,
  );
});

test('resolveAdbCommand falls back to PATH adb when the bundled copy is absent', () => {
  assert.equal(resolveAdbCommand({ root: '/x', env: {}, exists: () => false }), 'adb');
});

test('resolveAdbCommand lets PHONE_ADB override both defaults', () => {
  assert.equal(
    resolveAdbCommand({ root: '/x', env: { PHONE_ADB: '/custom/adb' }, exists: () => true }),
    '/custom/adb',
  );
});

test('isMissingAdbError only matches execFile ENOENT', () => {
  assert.equal(isMissingAdbError(Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' })), true);
  assert.equal(isMissingAdbError(new Error('exit 1')), false);
  assert.equal(isMissingAdbError(undefined), false);
});

const listedText = `List of devices attached
2FD0221C09004177       device usb:1-5 product:NOH-AN01 model:NOH_AN01 device:HWNOA transport_id:1
192.168.3.123:5555     device product:NOH-AN01 model:NOH_AN01 transport_id:2
R58M12345              unauthorized usb:1-2 transport_id:3
emulator-5554          offline transport_id:4
`;

test('parseDeviceList keeps USB devices with state and model', () => {
  assert.deepEqual(parseDeviceList(listedText), [
    {
      serial: '2FD0221C09004177',
      state: 'device',
      model: 'NOH AN01',
      product: 'NOH-AN01',
      transport: 'usb:1-5',
      selectable: true,
    },
    {
      serial: 'R58M12345',
      state: 'unauthorized',
      model: '',
      product: '',
      transport: 'usb:1-2',
      selectable: false,
    },
    {
      serial: 'emulator-5554',
      state: 'offline',
      model: '',
      product: '',
      transport: '',
      selectable: false,
    },
  ]);
});

test('parseDeviceList tolerates the header-only output', () => {
  assert.deepEqual(parseDeviceList('List of devices attached\n'), []);
});

test('listDevices returns an empty list when adb is missing', async () => {
  const adb = createAdb(async () => {
    throw Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' });
  });
  assert.deepEqual(await adb.listDevices(), []);
});

test('listDevices asks adb for the long format', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return listedText; });
  await adb.listDevices();
  assert.deepEqual(calls[0], ['devices', '-l']);
});

test('per-call serial overrides the default device', async () => {
  const calls = [];
  const adb = createAdb(async (args) => {
    calls.push(args);
    if (args[0] === 'devices') return 'List of devices attached\nSERIAL-B\tdevice\n';
    if (args.includes('get')) return '30000\n';
    if (args.includes('power')) return '  mWakefulness=Awake\n';
    return '  deviceLocked=0\n';
  });
  await adb.keyEvent('home', 'SERIAL-B');
  await adb.wakeScreen('SERIAL-B');
  await adb.getScreenTimeout('SERIAL-B');
  await adb.setScreenTimeout(60000, 'SERIAL-B');
  assert.equal(await adb.isOnline('SERIAL-B'), true);
  assert.equal(await adb.isOnline('SERIAL-A'), false);
  assert.equal(await adb.isLocked('SERIAL-B'), false);
  for (const call of calls.filter((args) => args[0] === '-s')) {
    assert.equal(call[1], 'SERIAL-B');
  }
});

test('ensureUsbOnly disconnects the wifi transport', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return args[0] === 'devices' ? devicesText : ''; });
  await adb.ensureUsbOnly();
  assert.ok(calls.some((a) => a[0] === 'disconnect' && a[1] === WIFI_ADDRESS));
});

test('ensureUsbOnly is idempotent when wifi is already gone', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return 'List of devices attached\n'; });
  await adb.ensureUsbOnly();
  assert.equal(calls.some((a) => a[0] === 'disconnect'), false);
});

test('ensureUsbOnly skips device enumeration in wireless mode', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return devicesText; }, {
    mode: 'wifi',
    serial: '10.0.0.5:5555',
  });

  await adb.ensureUsbOnly();
  assert.deepEqual(calls, []);
});

test('ensureUsbOnly does not disconnect when wireless mode starts while listing devices', async () => {
  const calls = [];
  let resolveList;
  const listing = new Promise((resolve) => { resolveList = resolve; });
  const adb = createAdb(async (args) => {
    calls.push(args);
    return args[0] === 'devices' ? listing : '';
  });

  const pending = adb.ensureUsbOnly();
  adb.setConnection({ mode: 'wifi', serial: '10.0.0.5:5555' });
  resolveList(devicesText);
  await pending;

  assert.deepEqual(calls, [['devices']]);
});

test('keyEvent pins the usb serial', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return ''; });
  await adb.keyEvent('home');
  assert.deepEqual(calls[0], ['-s', DEFAULT_USB_SERIAL, 'shell', 'input', 'keyevent', '3']);
});

test('isLocked: asleep screen fails closed as locked', async () => {
  const adb = createAdb(async (args) => {
    if (args.includes('power')) return '  mWakefulness=Asleep\n';
    return '  deviceLocked=0\n';
  });
  assert.equal(await adb.isLocked(), true);
});

test('isLocked: awake with no keyguard is unlocked', async () => {
  const adb = createAdb(async (args) => {
    if (args.includes('power')) return '  mWakefulness=Awake\n';
    return '  deviceLocked=0\n';
  });
  assert.equal(await adb.isLocked(), false);
});

test('isLocked: awake but keyguard locked fails closed as locked', async () => {
  const adb = createAdb(async (args) => {
    if (args.includes('power')) return '  mWakefulness=Awake\n';
    return '  deviceLocked=1\n';
  });
  assert.equal(await adb.isLocked(), true);
});

test('isLocked: unreadable wakefulness fails closed as locked', async () => {
  const adb = createAdb(async () => '');
  assert.equal(await adb.isLocked(), true);
});


test('isLocked: an explicit serial pins both power and trust probes to that device', async () => {
  const calls = [];
  const adb = createAdb(async (args) => {
    calls.push(args);
    return args.includes('power') ? 'mWakefulness=Awake\n' : 'deviceLocked=0\n';
  }, { mode: 'wifi', serial: 'ACTIVE-AFTER-SWITCH' });

  assert.equal(await adb.isLocked('PINNED-TURN-SERIAL'), false);
  assert.deepEqual(calls, [
    ['-s', 'PINNED-TURN-SERIAL', 'shell', 'dumpsys', 'power'],
    ['-s', 'PINNED-TURN-SERIAL', 'shell', 'dumpsys', 'trust'],
  ]);
});

test('wakeScreen sends KEYCODE_WAKEUP on the configured serial', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return ''; });
  await adb.wakeScreen();
  assert.deepEqual(calls[0], ['-s', DEFAULT_USB_SERIAL, 'shell', 'input', 'keyevent', '224']);
});

test('getScreenTimeout parses settings value; setScreenTimeout writes it', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return args.includes('get') ? '30000\n' : ''; });
  assert.equal(await adb.getScreenTimeout(), 30000);
  await adb.setScreenTimeout(3600000);
  assert.deepEqual(calls.at(-1), ['-s', DEFAULT_USB_SERIAL, 'shell', 'settings', 'put', 'system', 'screen_off_timeout', '3600000']);
});

test('createAdb defaults to USB pair and exposes mutable connection state', () => {
  const adb = createAdb(async () => '');
  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getMethod(), 'pair');
  assert.equal(adb.getSerial(), DEFAULT_USB_SERIAL);

  adb.setConnection({ mode: 'wifi', method: 'legacy', serial: '10.0.0.5:5555' });
  assert.equal(adb.getMode(), 'wifi');
  assert.equal(adb.getMethod(), 'legacy');
  assert.equal(adb.getSerial(), '10.0.0.5:5555');

  adb.setConnection({ mode: 'wifi', serial: '10.0.0.6:5555' });
  assert.equal(adb.getMethod(), 'pair', 'a connection switch without a method keeps pair behavior');
});

test('pair runs adb pair with the pairing endpoint and code', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return ''; });
  await adb.pair({ host: '192.168.1.20', port: 37123, code: '123456' });
  assert.deepEqual(calls, [['pair', '192.168.1.20:37123', '123456']]);
});

test('connect runs adb connect with the supplied address', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return ''; });
  await adb.connect('192.168.1.20:5555');
  assert.deepEqual(calls, [['connect', '192.168.1.20:5555']]);
});

test('tcpip targets the supplied USB serial and port', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return ''; });
  await adb.tcpip('USB-SERIAL', 5555);
  assert.deepEqual(calls, [['-s', 'USB-SERIAL', 'tcpip', '5555']]);
});

test('pair rejection preserves the active connection and persisted config bytes', async (t) => {
  const { file, store } = tempConnectionStore(t);
  const original = { mode: 'usb', method: 'pair', address: '' };
  store.save(original);
  const before = readFileSync(file);
  const adb = createAdb(async () => { throw new Error('pair rejected'); }, {
    mode: 'usb',
    serial: 'USB-ORIGINAL',
  });

  await assert.rejects(
    adb.pair({ host: '192.168.1.20', port: 37123, code: '123456' }),
    /pair rejected/,
  );
  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(store.load(), original);
});

test('connect rejection after pairing preserves the active connection and persisted config bytes', async (t) => {
  const { file, store } = tempConnectionStore(t);
  const original = { mode: 'usb', method: 'pair', address: '' };
  store.save(original);
  const before = readFileSync(file);
  const adb = createAdb(async (args) => {
    if (args[0] === 'connect') throw new Error('connect rejected');
    return '';
  }, {
    mode: 'usb',
    serial: 'USB-ORIGINAL',
  });

  await adb.pair({ host: '192.168.1.20', port: 37123, code: '123456' });
  await assert.rejects(adb.connect('192.168.1.20:5555'), /connect rejected/);
  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(store.load(), original);
});

test('getState checks the explicit serial rather than the active serial', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return 'device\n'; }, {
    mode: 'wifi',
    serial: '10.0.0.5:5555',
  });
  await adb.getState('10.0.0.6:5555');
  assert.deepEqual(calls, [['-s', '10.0.0.6:5555', 'get-state']]);
});

test('keyEvent and wakeScreen follow the active serial after a connection switch', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return ''; });
  adb.setConnection({ mode: 'wifi', serial: '10.0.0.5:5555' });

  await adb.keyEvent('home');
  await adb.wakeScreen();
  assert.deepEqual(calls, [
    ['-s', '10.0.0.5:5555', 'shell', 'input', 'keyevent', '3'],
    ['-s', '10.0.0.5:5555', 'shell', 'input', 'keyevent', '224'],
  ]);
});

test('screen timeout commands follow the active serial after a connection switch', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return args.includes('get') ? '30000\n' : ''; });
  adb.setConnection({ mode: 'wifi', serial: '10.0.0.5:5555' });

  assert.equal(await adb.getScreenTimeout(), 30000);
  await adb.setScreenTimeout(3600000);
  assert.deepEqual(calls, [
    ['-s', '10.0.0.5:5555', 'shell', 'settings', 'get', 'system', 'screen_off_timeout'],
    ['-s', '10.0.0.5:5555', 'shell', 'settings', 'put', 'system', 'screen_off_timeout', '3600000'],
  ]);
});

test('isLocked reads power and trust from the active serial after a connection switch', async () => {
  const calls = [];
  const adb = createAdb(async (args) => {
    calls.push(args);
    return args.includes('power') ? 'mWakefulness=Awake\n' : 'deviceLocked=0\n';
  });
  adb.setConnection({ mode: 'wifi', serial: '10.0.0.5:5555' });

  assert.equal(await adb.isLocked(), false);
  assert.deepEqual(calls, [
    ['-s', '10.0.0.5:5555', 'shell', 'dumpsys', 'power'],
    ['-s', '10.0.0.5:5555', 'shell', 'dumpsys', 'trust'],
  ]);
});

test('isOnline uses get-state without enumerating devices in wireless mode', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return 'device\n'; }, {
    mode: 'wifi',
    serial: '10.0.0.5:5555',
  });
  assert.equal(await adb.isOnline(), true);
  assert.deepEqual(calls, [['-s', '10.0.0.5:5555', 'get-state']]);
});

test('ensureWirelessConnected returns true without connect or devices when already online', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return 'device\n'; });
  assert.equal(await adb.ensureWirelessConnected('10.0.0.5:5555'), true);
  assert.deepEqual(calls, [['-s', '10.0.0.5:5555', 'get-state']]);
});

test('ensureWirelessConnected reconnects an offline address and confirms it without devices', async () => {
  const calls = [];
  let stateChecks = 0;
  const adb = createAdb(async (args) => {
    calls.push(args);
    if (args[0] === 'get-state' || args[2] === 'get-state') stateChecks += 1;
    return stateChecks === 1 ? 'offline\n' : 'device\n';
  });

  assert.equal(await adb.ensureWirelessConnected('10.0.0.5:5555'), true);
  assert.deepEqual(calls, [
    ['-s', '10.0.0.5:5555', 'get-state'],
    ['connect', '10.0.0.5:5555'],
    ['-s', '10.0.0.5:5555', 'get-state'],
  ]);
});

test('ensureWirelessConnected still reconnects when the initial get-state exits nonzero', async () => {
  const calls = [];
  let stateChecks = 0;
  const adb = createAdb(async (args) => {
    calls.push(args);
    if (args[2] === 'get-state') {
      stateChecks += 1;
      if (stateChecks === 1) throw new Error('error: device offline');
      return 'device\n';
    }
    return '';
  });

  assert.equal(await adb.ensureWirelessConnected('10.0.0.5:5555'), true);
  assert.deepEqual(calls, [
    ['-s', '10.0.0.5:5555', 'get-state'],
    ['connect', '10.0.0.5:5555'],
    ['-s', '10.0.0.5:5555', 'get-state'],
  ]);
});

test('ensureWirelessConnected returns false if the address remains offline', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return 'offline\n'; });
  assert.equal(await adb.ensureWirelessConnected('10.0.0.5:5555'), false);
  assert.equal(calls.some((args) => args[0] === 'devices'), false);
  assert.deepEqual(calls, [
    ['-s', '10.0.0.5:5555', 'get-state'],
    ['connect', '10.0.0.5:5555'],
    ['-s', '10.0.0.5:5555', 'get-state'],
  ]);
});

test('legacy maintenance bootstraps over USB and retries after connect fails', async () => {
  const address = '10.0.0.5:5555';
  const calls = [];
  let wirelessChecks = 0;
  let connects = 0;
  const adb = createAdb(async (args) => {
    calls.push(args);
    if (args[0] === 'connect') {
      connects += 1;
      if (connects === 1) throw new Error('connect failed');
      return '';
    }
    if (args[0] === '-s' && args[1] === address && args[2] === 'get-state') {
      wirelessChecks += 1;
      return wirelessChecks === 3 ? 'device\n' : 'offline\n';
    }
    if (args[0] === '-s' && args[1] === 'USB-SERIAL' && args[2] === 'get-state') return 'device\n';
    return '';
  });

  assert.equal(await adb.ensureWirelessConnected(address, {
    method: 'legacy',
    port: 5555,
    usbSerial: 'USB-SERIAL',
  }), true);
  assert.deepEqual(calls, [
    ['-s', address, 'get-state'],
    ['connect', address],
    ['-s', address, 'get-state'],
    ['-s', 'USB-SERIAL', 'get-state'],
    ['-s', 'USB-SERIAL', 'tcpip', '5555'],
    ['connect', address],
    ['-s', address, 'get-state'],
  ]);
});

test('legacy maintenance bootstraps when connect exits successfully but the endpoint is offline', async () => {
  const address = '10.0.0.5:5555';
  const calls = [];
  let wirelessChecks = 0;
  const adb = createAdb(async (args) => {
    calls.push(args);
    if (args[0] === '-s' && args[1] === address && args[2] === 'get-state') {
      wirelessChecks += 1;
      return wirelessChecks === 3 ? 'device\n' : 'offline\n';
    }
    if (args[0] === '-s' && args[1] === 'USB-SERIAL' && args[2] === 'get-state') return 'device\n';
    return '';
  });

  assert.equal(await adb.ensureWirelessConnected(address, {
    method: 'legacy',
    port: 5555,
    usbSerial: 'USB-SERIAL',
  }), true);
  assert.deepEqual(calls, [
    ['-s', address, 'get-state'],
    ['connect', address],
    ['-s', address, 'get-state'],
    ['-s', 'USB-SERIAL', 'get-state'],
    ['-s', 'USB-SERIAL', 'tcpip', '5555'],
    ['connect', address],
    ['-s', address, 'get-state'],
  ]);
});

test('legacy maintenance stays offline without USB and never enumerates devices', async () => {
  const address = '10.0.0.5:5555';
  const calls = [];
  const adb = createAdb(async (args) => {
    calls.push(args);
    if (args[0] === '-s' && args[1] === 'USB-SERIAL' && args[2] === 'get-state') {
      throw new Error("error: device 'USB-SERIAL' not found");
    }
    return 'offline\n';
  });

  assert.equal(await adb.ensureWirelessConnected(address, {
    method: 'legacy',
    port: 5555,
    usbSerial: 'USB-SERIAL',
  }), false);
  assert.deepEqual(calls, [
    ['-s', address, 'get-state'],
    ['connect', address],
    ['-s', address, 'get-state'],
    ['-s', 'USB-SERIAL', 'get-state'],
  ]);
});

test('legacy maintenance parses the tcpip port from the configured address', async () => {
  const address = '192.168.1.20:5555';
  const calls = [];
  let wirelessChecks = 0;
  const adb = createAdb(async (args) => {
    calls.push(args);
    if (args[0] === '-s' && args[1] === address && args[2] === 'get-state') {
      wirelessChecks += 1;
      return wirelessChecks === 3 ? 'device\n' : 'offline\n';
    }
    if (args[0] === '-s' && args[1] === 'USB-SERIAL' && args[2] === 'get-state') return 'device\n';
    return '';
  }, { mode: 'wifi', method: 'legacy', serial: address });

  assert.equal(await adb.ensureWirelessConnected(address, { usbSerial: 'USB-SERIAL' }), true);
  assert.ok(calls.some((args) => args.join(' ') === '-s USB-SERIAL tcpip 5555'));
});

test('legacy maintenance does not repeat tcpip while the same outage remains offline', async () => {
  const address = '10.0.0.5:5555';
  const calls = [];
  const adb = createAdb(async (args) => {
    calls.push(args);
    if (args[0] === '-s' && args[1] === 'USB-SERIAL' && args[2] === 'get-state') return 'device\n';
    return 'offline\n';
  }, { sleep: async () => {}, now: () => 0 });

  assert.equal(await adb.ensureWirelessConnected(address, {
    method: 'legacy',
    port: 5555,
    usbSerial: 'USB-SERIAL',
  }), false);
  assert.equal(await adb.ensureWirelessConnected(address, {
    method: 'legacy',
    port: 5555,
    usbSerial: 'USB-SERIAL',
  }), false);

  assert.equal(calls.filter((args) => args[2] === 'tcpip').length, 1);
  assert.equal(calls.filter((args) => args[0] === 'connect').length, 7);
  assert.equal(calls.filter((args) => args[0] === 'devices').length, 0);
});

test('legacy maintenance allows a fresh bootstrap after a healthy connection and a new outage', async () => {
  const address = '10.0.0.5:5555';
  const calls = [];
  let wirelessChecks = 0;
  const adb = createAdb(async (args) => {
    calls.push(args);
    if (args[0] === '-s' && args[1] === address && args[2] === 'get-state') {
      wirelessChecks += 1;
      return wirelessChecks === 1 || wirelessChecks === 2 || wirelessChecks === 5 || wirelessChecks === 6
        ? 'offline\n'
        : 'device\n';
    }
    if (args[0] === '-s' && args[1] === 'USB-SERIAL' && args[2] === 'get-state') return 'device\n';
    return '';
  });
  const options = { method: 'legacy', port: 5555, usbSerial: 'USB-SERIAL' };

  assert.equal(await adb.ensureWirelessConnected(address, options), true);
  assert.equal(await adb.ensureWirelessConnected(address, options), true);
  assert.equal(await adb.ensureWirelessConnected(address, options), true);
  assert.equal(calls.filter((args) => args[2] === 'tcpip').length, 2);
});

test('legacy maintenance waits for EMUI adbd to settle after tcpip before retrying connect', async () => {
  const address = '10.0.0.5:5555';
  const calls = [];
  const sleeps = [];
  let elapsed = 0;
  let wirelessChecks = 0;
  const adb = createAdb(async (args) => {
    calls.push(args);
    if (args[0] === '-s' && args[1] === address && args[2] === 'get-state') {
      wirelessChecks += 1;
      return wirelessChecks >= 5 ? 'device\n' : 'offline\n';
    }
    return 'device\n';
  }, {
    sleep: async (ms) => { sleeps.push(ms); elapsed += ms; },
    now: () => elapsed,
  });

  assert.equal(await adb.ensureWirelessConnected(address, {
    method: 'legacy',
    port: 5555,
    usbSerial: 'USB-SERIAL',
  }), true);

  assert.deepEqual(sleeps, [250, 500]);
  assert.equal(calls.filter((args) => args[0] === 'connect').length, 4);
  assert.equal(calls.filter((args) => args[2] === 'tcpip').length, 1);
  assert.equal(calls.some((args) => args[0] === 'devices'), false);
});

test('legacy maintenance bounds retries when the target never comes online after tcpip', async () => {
  const address = '10.0.0.5:5555';
  const calls = [];
  const sleeps = [];
  let elapsed = 0;
  const adb = createAdb(async (args) => {
    calls.push(args);
    if (args[0] === '-s' && args[1] === 'USB-SERIAL' && args[2] === 'get-state') return 'device\n';
    if (args[0] === '-s' && args[1] === address && args[2] === 'get-state') return 'offline\n';
    return '';
  }, {
    sleep: async (ms) => { sleeps.push(ms); elapsed += ms; },
    now: () => elapsed,
  });
  const options = { method: 'legacy', port: 5555, usbSerial: 'USB-SERIAL' };

  assert.equal(await adb.ensureWirelessConnected(address, options), false);
  assert.deepEqual(sleeps, [250, 500, 1000, 1000]);
  assert.equal(calls.filter((args) => args[0] === 'connect').length, 6);
  assert.equal(calls.filter((args) => args[2] === 'tcpip').length, 1);

  assert.equal(await adb.ensureWirelessConnected(address, options), false);
  assert.equal(calls.filter((args) => args[0] === 'connect').length, 7);
  assert.equal(calls.filter((args) => args[2] === 'tcpip').length, 1);
  assert.equal(calls.some((args) => args[0] === 'devices'), false);
});

test('pair-mode supervision keeps its single connect without settle retries', async () => {
  const calls = [];
  const sleeps = [];
  const adb = createAdb(async (args) => { calls.push(args); return 'offline\n'; }, {
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => 0,
  });

  assert.equal(await adb.ensureWirelessConnected('10.0.0.5:5555'), false);
  assert.deepEqual(calls, [
    ['-s', '10.0.0.5:5555', 'get-state'],
    ['connect', '10.0.0.5:5555'],
    ['-s', '10.0.0.5:5555', 'get-state'],
  ]);
  assert.deepEqual(sleeps, []);
});

test('parseWifiIp reads the IPv4 address from ip addr output', () => {
  const parseWifiIp = discoveryExport('parseWifiIp');
  const text = `3: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP
    inet 192.168.1.42/24 brd 192.168.1.255 scope global wlan0
    inet6 fe80::1234:5678:9abc:def0/64 scope link
`;
  assert.equal(parseWifiIp(text), '192.168.1.42');
});

test('parseWifiIp reads the source address from ip route output', () => {
  const parseWifiIp = discoveryExport('parseWifiIp');
  const text = `default via 192.168.1.1 dev wlan0 proto dhcp src 192.168.1.42 metric 600
192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.42 metric 600
`;
  assert.equal(parseWifiIp(text), '192.168.1.42');
});

test('parseWifiIp rejects missing and malformed IPv4 addresses', () => {
  const parseWifiIp = discoveryExport('parseWifiIp');
  const cases = [
    '',
    '3: wlan0: <BROADCAST,MULTICAST> mtu 1500 state DOWN\n',
    '    inet 999.168.1.42/24 scope global wlan0\n',
    '192.168.1.0/24 dev wlan0 src 192.168.1.999 metric 600\n',
    '    inet6 fe80::1234:5678:9abc:def0/64 scope link\n',
  ];
  for (const text of cases) assert.equal(parseWifiIp(text), null, JSON.stringify(text));
});

test('getWifiIp targets the explicit USB serial without changing active state', async () => {
  const calls = [];
  const adb = createAdb(async (args) => {
    calls.push(args);
    return '    inet 192.168.1.42/24 scope global wlan0\n';
  }, { mode: 'wifi', serial: 'ACTIVE-WIFI' });

  assert.equal(await adb.getWifiIp('USB-SERIAL'), '192.168.1.42');
  assert.deepEqual(calls, [
    ['-s', 'USB-SERIAL', 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
  ]);
  assert.equal(adb.getMode(), 'wifi');
  assert.equal(adb.getSerial(), 'ACTIVE-WIFI');
});

test('getWifiIp falls back to ip route when wlan0 has no inet address', async () => {
  const calls = [];
  const adb = createAdb(async (args) => {
    calls.push(args);
    return args.includes('addr')
      ? '3: wlan0: <BROADCAST,MULTICAST> mtu 1500 state DOWN\n'
      : '192.168.1.0/24 dev wlan0 src 192.168.1.42 metric 600\n';
  });

  assert.equal(await adb.getWifiIp('USB-SERIAL'), '192.168.1.42');
  assert.deepEqual(calls, [
    ['-s', 'USB-SERIAL', 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
    ['-s', 'USB-SERIAL', 'shell', 'ip', 'route', 'show', 'dev', 'wlan0'],
  ]);
});

test('getWifiIp falls back to ip route when the address query fails', async () => {
  const calls = [];
  const adb = createAdb(async (args) => {
    calls.push(args);
    if (args.includes('addr')) throw new Error('wlan0 address query failed');
    return '192.168.1.0/24 dev wlan0 src 192.168.1.42 metric 600\n';
  });

  assert.equal(await adb.getWifiIp('USB-SERIAL'), '192.168.1.42');
  assert.deepEqual(calls, [
    ['-s', 'USB-SERIAL', 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
    ['-s', 'USB-SERIAL', 'shell', 'ip', 'route', 'show', 'dev', 'wlan0'],
  ]);
});

test('getWifiIp returns null when neither query contains an IPv4 address', async () => {
  const calls = [];
  const adb = createAdb(async (args) => {
    calls.push(args);
    return '';
  });

  assert.equal(await adb.getWifiIp('USB-SERIAL'), null);
  assert.deepEqual(calls, [
    ['-s', 'USB-SERIAL', 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
    ['-s', 'USB-SERIAL', 'shell', 'ip', 'route', 'show', 'dev', 'wlan0'],
  ]);
});

test('getWifiIp returns null when both wlan0 queries fail', async () => {
  const calls = [];
  const adb = createAdb(async (args) => {
    calls.push(args);
    throw new Error('wlan0 query failed');
  });

  assert.equal(await adb.getWifiIp('USB-SERIAL'), null);
  assert.deepEqual(calls, [
    ['-s', 'USB-SERIAL', 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
    ['-s', 'USB-SERIAL', 'shell', 'ip', 'route', 'show', 'dev', 'wlan0'],
  ]);
});

for (const { label, output, expected } of [
  { label: 'accepts a numeric TLS port', output: '5555\n', expected: 5555 },
  { label: 'trims whitespace and leading zeroes', output: ' 00080\n', expected: 80 },
  { label: 'rejects an empty property', output: '\n', expected: null },
  { label: 'rejects zero', output: '0\n', expected: null },
  { label: 'rejects a port above 65535', output: '65536\n', expected: null },
  { label: 'rejects a negative port', output: '-1\n', expected: null },
  { label: 'rejects a fractional port', output: '5555.5\n', expected: null },
  { label: 'rejects trailing junk', output: '5555oops\n', expected: null },
]) {
  test(`getWirelessConnectPort ${label}`, async () => {
    const calls = [];
    const adb = createAdb(async (args) => { calls.push(args); return output; }, {
      mode: 'wifi',
      serial: 'ACTIVE-WIFI',
    });

    assert.equal(await adb.getWirelessConnectPort('USB-SERIAL'), expected);
    assert.deepEqual(calls, [
      ['-s', 'USB-SERIAL', 'shell', 'getprop', 'service.adb.tls.port'],
    ]);
    assert.equal(adb.getMode(), 'wifi');
    assert.equal(adb.getSerial(), 'ACTIVE-WIFI');
  });
}

test('parseMdnsServices extracts TLS pairing and connect endpoints', () => {
  const parseMdnsServices = discoveryExport('parseMdnsServices');
  const text = `List of discovered mdns services
_adb-tls-pairing._tcp\t192.168.1.42:37123
_adb-tls-connect._tcp\t192.168.1.42:42123
`;
  assert.deepEqual(parseMdnsServices(text), [
    { service: '_adb-tls-pairing._tcp', host: '192.168.1.42', port: 37123 },
    { service: '_adb-tls-connect._tcp', host: '192.168.1.42', port: 42123 },
  ]);
});

test('parseMdnsServices ignores unrelated and malformed TLS endpoints', () => {
  const parseMdnsServices = discoveryExport('parseMdnsServices');
  const text = `List of discovered mdns services
_some-other._tcp\t192.168.1.42:12345
_adb-tls-pairing._tcp\t192.168.1.42:0
_adb-tls-pairing._tcp\t192.168.1.42:65536
_adb-tls-pairing._tcp\t192.168.1.42:37x
_adb-tls-connect._tcp\t999.168.1.42:42123
_adb-tls-connect._tcp\t[fe80::1234:5678:9abc:def0]:42123
`;
  assert.deepEqual(parseMdnsServices(text), [
    { service: '_adb-tls-connect._tcp', host: 'fe80::1234:5678:9abc:def0', port: 42123 },
  ]);
});

test('parseMdnsServices returns no entries for empty or header-only output', () => {
  const parseMdnsServices = discoveryExport('parseMdnsServices');
  assert.deepEqual(parseMdnsServices(''), []);
  assert.deepEqual(parseMdnsServices('List of discovered mdns services\n'), []);
});

test('mdnsServices runs the host command and returns parsed entries without changing active state', async () => {
  const calls = [];
  const adb = createAdb(async (args) => {
    calls.push(args);
    return 'List of discovered mdns services\n_adb-tls-pairing._tcp\t192.168.1.42:37123\n';
  }, { mode: 'wifi', serial: 'ACTIVE-WIFI' });

  assert.deepEqual(await adb.mdnsServices(), [
    { service: '_adb-tls-pairing._tcp', host: '192.168.1.42', port: 37123 },
  ]);
  assert.deepEqual(calls, [['mdns', 'services']]);
  assert.equal(adb.getMode(), 'wifi');
  assert.equal(adb.getSerial(), 'ACTIVE-WIFI');
});

test('disconnect asks adb to drop a wireless endpoint', async () => {
  const calls = [];
  const adb = createAdb(async (args) => { calls.push(args); return ''; });
  await adb.disconnect('192.168.1.19:5555');
  assert.deepEqual(calls, [['disconnect', '192.168.1.19:5555']]);
});
