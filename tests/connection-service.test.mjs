import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdb } from '../server/adb.mjs';
import { createConnectionConfigStore } from '../server/connection-config.mjs';
import { createConnectionService } from '../server/connection-service.mjs';

const USB_SERIAL = 'USB-DEFAULT';
const WIRELESS_ADDRESS = 'phone.local:5555';
const PAIR_INPUT = Object.freeze({
  pairHost: '192.168.1.20',
  pairPort: '37123',
  pairCode: '123456',
  connectHost: 'phone.local',
  connectPort: '5555',
});

function setup(t, { runner, initial, stored } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'connection-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'connection.json');
  const store = createConnectionConfigStore({ file });
  store.save(stored ?? { mode: 'usb', address: '' });
  const adb = createAdb(runner ?? (async () => ''), initial ?? { mode: 'usb', serial: 'USB-ORIGINAL' });
  const service = createConnectionService({ adb, store, usbSerial: USB_SERIAL });
  return { adb, store, service, file };
}

test('connection service: status reports the active wireless device without enumerating USB devices', async (t) => {
  const calls = [];
  const { service } = setup(t, {
    initial: { mode: 'wifi', serial: WIRELESS_ADDRESS },
    stored: { mode: 'wifi', address: WIRELESS_ADDRESS },
    runner: async (args) => { calls.push(args); return 'device\n'; },
  });

  assert.deepEqual(await service.status(), { mode: 'wifi', serial: WIRELESS_ADDRESS, online: true });
  assert.deepEqual(calls, [['-s', WIRELESS_ADDRESS, 'get-state']]);
});

test('connection service: pairAndConnect pairs, connects, confirms online, then switches and persists', async (t) => {
  const calls = [];
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => { calls.push(args); return 'device\n'; },
  });

  const result = await service.pairAndConnect(PAIR_INPUT);

  assert.deepEqual(calls.slice(0, 3), [
    ['pair', '192.168.1.20:37123', '123456'],
    ['connect', 'phone.local:5555'],
    ['-s', 'phone.local:5555', 'get-state'],
  ]);
  assert.equal(calls.some((args) => args[0] === 'devices'), false);
  assert.equal(adb.getMode(), 'wifi');
  assert.equal(adb.getSerial(), WIRELESS_ADDRESS);
  assert.deepEqual(store.load(), { mode: 'wifi', address: WIRELESS_ADDRESS });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mode: 'wifi', address: WIRELESS_ADDRESS });
  assert.deepEqual(result, { mode: 'wifi', serial: WIRELESS_ADDRESS, online: true });
  assert.equal(JSON.stringify(result).includes(PAIR_INPUT.pairCode), false);
});

test('connection service: a pair failure leaves the active device and persisted config unchanged', async (t) => {
  const calls = [];
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => {
      calls.push(args);
      throw new Error('pair rejected');
    },
  });
  const before = readFileSync(file);

  await assert.rejects(service.pairAndConnect(PAIR_INPUT), /pair rejected/);

  assert.deepEqual(calls, [['pair', '192.168.1.20:37123', '123456']]);
  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: a connect failure after pairing leaves the active device and persisted config unchanged', async (t) => {
  const calls = [];
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => {
      calls.push(args);
      if (args[0] === 'connect') throw new Error('connect rejected');
      return '';
    },
  });
  const before = readFileSync(file);

  await assert.rejects(service.pairAndConnect(PAIR_INPUT), /connect rejected/);

  assert.deepEqual(calls, [
    ['pair', '192.168.1.20:37123', '123456'],
    ['connect', 'phone.local:5555'],
  ]);
  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: an offline device after connect is not activated or persisted', async (t) => {
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => {
      if (args[0] === '-s') throw new Error('device offline');
      return '';
    },
  });
  const before = readFileSync(file);

  await assert.rejects(service.pairAndConnect(PAIR_INPUT), /offline after connect/i);

  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: invalid pairing input is rejected before any ADB command or persistence', async (t) => {
  const calls = [];
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => { calls.push(args); return ''; },
  });
  const before = readFileSync(file);
  const invalidInputs = [
    [{ pairHost: '' }, /pairHost/],
    [{ pairHost: 'bad host' }, /pairHost/],
    [{ pairHost: '192.168.1.999' }, /pairHost/],
    [{ pairPort: 0 }, /pairPort/],
    [{ pairPort: 65536 }, /pairPort/],
    [{ pairPort: 'abc' }, /pairPort/],
    [{ pairCode: '12345' }, /pairCode/],
    [{ pairCode: '1234567' }, /pairCode/],
    [{ pairCode: 'abcdef' }, /pairCode/],
    [{ connectHost: '' }, /connectHost/],
    [{ connectPort: -1 }, /connectPort/],
    [{ connectPort: '65536' }, /connectPort/],
  ];

  for (const [patch, expected] of invalidInputs) {
    await assert.rejects(service.pairAndConnect({ ...PAIR_INPUT, ...patch }), expected);
  }

  assert.deepEqual(calls, []);
  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: surfaced ADB errors never contain the pairing code', async (t) => {
  const { service } = setup(t, {
    runner: async () => {
      throw new Error(`pair command failed for code ${PAIR_INPUT.pairCode}`);
    },
  });

  await assert.rejects(service.pairAndConnect(PAIR_INPUT), (err) => {
    assert.match(err.message, /pair command failed/);
    assert.equal(err.message.includes(PAIR_INPUT.pairCode), false);
    return true;
  });
});

test('connection service: switchToUsb restores the supplied USB serial and clears the stored address', async (t) => {
  const calls = [];
  const { adb, store, service } = setup(t, {
    initial: { mode: 'wifi', serial: WIRELESS_ADDRESS },
    stored: { mode: 'wifi', address: WIRELESS_ADDRESS },
    runner: async (args) => {
      calls.push(args);
      return args[0] === 'devices' ? `List of devices attached\n${USB_SERIAL} device\n` : 'device\n';
    },
  });

  const result = await service.switchToUsb();

  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), USB_SERIAL);
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
  assert.deepEqual(result, { mode: 'usb', serial: USB_SERIAL, online: true });
  assert.deepEqual(calls, [['devices']]);
});
