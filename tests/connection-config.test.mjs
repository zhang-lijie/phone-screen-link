import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConnectionConfigStore, isWirelessSerial, resolveInitialConnection } from '../server/connection-config.mjs';

const DEFAULT_CONFIG = { mode: 'usb', method: 'pair', address: '' };

function tempStore(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'connection-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'connection.json');
  if (contents !== undefined) writeFileSync(file, contents);
  return { file, store: createConnectionConfigStore({ file }) };
}

test('connection config: first load defaults to USB and pair without creating a file', (t) => {
  const { file, store } = tempStore(t);
  assert.deepEqual(store.load(), DEFAULT_CONFIG);
  assert.deepEqual(store.publicConfig(), DEFAULT_CONFIG);
  assert.equal(existsSync(file), false);
});

test('connection config: save persists and reloads a wireless pair address', (t) => {
  const { file, store } = tempStore(t);
  const wifi = { mode: 'wifi', method: 'pair', address: '192.168.3.123:5555' };

  assert.deepEqual(store.save(wifi), wifi);
  assert.deepEqual(store.publicConfig(), wifi);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), wifi);
  assert.deepEqual(createConnectionConfigStore({ file }).load(), wifi);
});

test('connection config: save persists and reloads the legacy method', (t) => {
  const { file, store } = tempStore(t);
  const legacy = { mode: 'wifi', method: 'legacy', address: '192.168.3.123:5555' };

  assert.deepEqual(store.save(legacy), legacy);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), legacy);
  assert.deepEqual(createConnectionConfigStore({ file }).load(), legacy);
});

test('connection config: an address-only patch preserves the legacy method', (t) => {
  const { store } = tempStore(t);
  store.save({ mode: 'wifi', method: 'legacy', address: '192.168.3.123:5555' });

  assert.deepEqual(store.save({ address: '192.168.3.124:5555' }), {
    mode: 'wifi',
    method: 'legacy',
    address: '192.168.3.124:5555',
  });
  assert.deepEqual(store.load(), {
    mode: 'wifi',
    method: 'legacy',
    address: '192.168.3.124:5555',
  });
});

test('connection config: a method patch can switch legacy back to pair', (t) => {
  const { store } = tempStore(t);
  store.save({ mode: 'wifi', method: 'legacy', address: '192.168.3.123:5555' });

  assert.deepEqual(store.save({ method: 'pair' }), {
    mode: 'wifi',
    method: 'pair',
    address: '192.168.3.123:5555',
  });
});

test('connection config: old wireless configs without a method default to pair', (t) => {
  const { store } = tempStore(t, JSON.stringify({ mode: 'wifi', address: '192.168.3.123:5555' }));

  assert.deepEqual(store.load(), { mode: 'wifi', method: 'pair', address: '192.168.3.123:5555' });
  assert.deepEqual(resolveInitialConnection({
    env: {},
    stored: store.load(),
    usbSerial: 'USB-FALLBACK',
  }), { mode: 'wifi', method: 'pair', serial: '192.168.3.123:5555' });
});

test('connection config: save returns the committed config without a post-commit reread', (t) => {
  const { file } = tempStore(t);
  let reads = 0;
  const store = createConnectionConfigStore({ file }, {
    readFile(path, encoding) {
      reads += 1;
      if (reads > 1) throw Object.assign(new Error('post-commit read failed'), { code: 'EACCES' });
      return readFileSync(path, encoding);
    },
  });
  const wifi = { mode: 'wifi', method: 'pair', address: ' phone.local:5555 ' };

  assert.deepEqual(store.save(wifi), { mode: 'wifi', method: 'pair', address: 'phone.local:5555' });
  assert.equal(reads, 1, 'a completed atomic write must not depend on reading the file back');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mode: 'wifi', method: 'pair', address: 'phone.local:5555' });
});

test('connection config: public config and disk never retain a pairing code', (t) => {
  const { file, store } = tempStore(t);
  store.save({ mode: 'wifi', method: 'pair', address: 'phone.local:5555', pairCode: '654321' });

  assert.deepEqual(store.publicConfig(), { mode: 'wifi', method: 'pair', address: 'phone.local:5555' });
  assert.equal(JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))).includes('654321'), false);
});

test('connection config: malformed or structurally invalid files fall back to USB', (t) => {
  for (const contents of [
    '{not valid json',
    'null',
    '[]',
    '{"mode":"bluetooth","address":"x"}',
    '{"mode":"wifi","address":42}',
    '{"mode":"wifi","method":"bluetooth","address":"10.0.0.5:5555"}',
  ]) {
    const { store } = tempStore(t, contents);
    assert.deepEqual(store.load(), DEFAULT_CONFIG, contents);
  }
});

test('connection config: save atomically replaces the file with owner-only 0600 permissions', (t) => {
  const { file, store } = tempStore(t);
  store.save({ mode: 'wifi', method: 'pair', address: '10.0.0.8:5555' });

  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    chmodSync(file, 0o644);
    store.save({ mode: 'wifi', method: 'pair', address: '10.0.0.9:5555' });
    assert.equal(statSync(file).mode & 0o777, 0o600, 'replacing a loose file must tighten its mode');
  }
  assert.deepEqual(readdirSync(dirname(file)), ['connection.json'], 'temp file must be renamed away');
  assert.deepEqual(store.load(), { mode: 'wifi', method: 'pair', address: '10.0.0.9:5555' });
});

test('resolveInitialConnection treats PHONE_SERIAL host:port as wireless pair', () => {
  assert.deepEqual(
    resolveInitialConnection({
      env: { PHONE_SERIAL: '10.0.0.5:37123' },
      stored: { mode: 'usb', method: 'pair', address: '' },
      usbSerial: 'USB-FALLBACK',
    }),
    { mode: 'wifi', method: 'pair', serial: '10.0.0.5:37123' },
  );
});

test('resolveInitialConnection recognizes a hostname endpoint and trims it', () => {
  assert.deepEqual(
    resolveInitialConnection({ env: { PHONE_SERIAL: ' phone.local:5555 ' }, stored: {}, usbSerial: 'USB' }),
    { mode: 'wifi', method: 'pair', serial: 'phone.local:5555' },
  );
});

test('isWirelessSerial explicitly rejects emulator USB serials', () => {
  for (const serial of ['emulator-5554', 'emulator-5555', 'emulator-12345']) {
    assert.equal(isWirelessSerial(serial), false, serial);
  }
});

test('resolveInitialConnection uses a stored wireless pair address without an environment override', () => {
  assert.deepEqual(
    resolveInitialConnection({
      env: {},
      stored: { mode: 'wifi', method: 'pair', address: '192.168.1.20:5555' },
      usbSerial: 'USB-FALLBACK',
    }),
    { mode: 'wifi', method: 'pair', serial: '192.168.1.20:5555' },
  );
});

test('resolveInitialConnection preserves a stored legacy wireless method', () => {
  assert.deepEqual(
    resolveInitialConnection({
      env: {},
      stored: { mode: 'wifi', method: 'legacy', address: '192.168.1.20:5555' },
      usbSerial: 'USB-FALLBACK',
    }),
    { mode: 'wifi', method: 'legacy', serial: '192.168.1.20:5555' },
  );
});

test('resolveInitialConnection gives an explicit USB environment serial precedence over stored wifi', () => {
  assert.deepEqual(
    resolveInitialConnection({
      env: { PHONE_SERIAL: 'USB-OVERRIDE' },
      stored: { mode: 'wifi', method: 'legacy', address: '192.168.1.20:5555' },
      usbSerial: 'USB-FALLBACK',
    }),
    { mode: 'usb', method: 'pair', serial: 'USB-OVERRIDE' },
  );
});

test('resolveInitialConnection prefers PHONE_USB_SERIAL over a non-wireless PHONE_SERIAL', () => {
  assert.deepEqual(
    resolveInitialConnection({
      env: { PHONE_USB_SERIAL: 'USB-NEW', PHONE_SERIAL: 'USB-OLD' },
      stored: {},
      usbSerial: 'USB-FALLBACK',
    }),
    { mode: 'usb', method: 'pair', serial: 'USB-NEW' },
  );
});

test('resolveInitialConnection falls back to non-wireless PHONE_SERIAL then the existing default', () => {
  assert.deepEqual(
    resolveInitialConnection({ env: { PHONE_SERIAL: 'USB-OLD' }, stored: {}, usbSerial: 'USB-FALLBACK' }),
    { mode: 'usb', method: 'pair', serial: 'USB-OLD' },
  );
  assert.deepEqual(resolveInitialConnection({ env: {}, stored: {}, usbSerial: 'USB-FALLBACK' }), {
    mode: 'usb',
    method: 'pair',
    serial: 'USB-FALLBACK',
  });
  assert.deepEqual(resolveInitialConnection({ env: {}, stored: {} }), {
    mode: 'usb',
    method: 'pair',
    serial: '2FD0221C09004177',
  });
});

test('resolveInitialConnection does not mistake USB serials or invalid endpoints for wireless', () => {
  for (const serial of ['emulator-5554', '2FD0221C09004177', '192.168.1.5', 'host:abc', 'host:0', 'host:65536', ':5555']) {
    assert.deepEqual(
      resolveInitialConnection({ env: { PHONE_SERIAL: serial }, stored: {}, usbSerial: 'USB-FALLBACK' }),
      { mode: 'usb', method: 'pair', serial },
      serial,
    );
  }
});

test('resolveInitialConnection ignores a stored wifi address that is not an endpoint', () => {
  assert.deepEqual(
    resolveInitialConnection({
      env: {},
      stored: { mode: 'wifi', method: 'legacy', address: 'not-an-endpoint' },
      usbSerial: 'USB-FALLBACK',
    }),
    { mode: 'usb', method: 'pair', serial: 'USB-FALLBACK' },
  );
});
