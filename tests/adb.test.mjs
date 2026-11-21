import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDevices, createAdb, WIFI_ADDRESS, DEFAULT_USB_SERIAL } from '../server/adb.mjs';

const devicesText = `List of devices attached
2FD0221C09004177       device usb:1-5 product:NOH-AN01
192.168.3.123:5555     device product:NOH-AN01
`;

test('parseDevices returns both transports', () => {
  assert.deepEqual(parseDevices(devicesText), [DEFAULT_USB_SERIAL, WIFI_ADDRESS]);
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
