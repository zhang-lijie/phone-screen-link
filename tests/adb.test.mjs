import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  parseDevices,
  parseDeviceList,
  createAdb,
  WIFI_ADDRESS,
  DEFAULT_USB_SERIAL,
  bundledAdbPath,
  isMissingAdbError,
  resolveAdbCommand,
} from '../server/adb.mjs';

const devicesText = `List of devices attached
2FD0221C09004177       device usb:1-5 product:NOH-AN01
192.168.3.123:5555     device product:NOH-AN01
`;

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
