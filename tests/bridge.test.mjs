import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../server/bridge.mjs';

const fakeAdb = {
  isOnline: async () => true,
  keyEvent: async (key) => { fakeAdb.last = key; },
};

async function withBridge(options, fn) {
  const bridge = createBridge({ adb: fakeAdb, port: 0, ...options });
  const { address } = await bridge.start();
  try {
    await fn(address, bridge);
  } finally {
    await bridge.stop();
  }
}

function postKey(address, key) {
  return fetch(`${address}/keyevent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
}

test('health reports online', async () => {
  await withBridge({}, async (address) => {
    const res = await fetch(`${address}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, online: true });
  });
});

test('health reports offline from adb', async () => {
  await withBridge({ adb: { isOnline: async () => false, keyEvent: fakeAdb.keyEvent } }, async (address) => {
    const res = await fetch(`${address}/health`);
    assert.deepEqual(await res.json(), { ok: true, online: false });
  });
});

test('keyevent accepts home and maps to adb', async () => {
  fakeAdb.last = undefined;
  await withBridge({}, async (address) => {
    const res = await postKey(address, 'home');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(fakeAdb.last, 'home');
  });
});

test('keyevent rejects unknown key', async () => {
  fakeAdb.last = undefined;
  await withBridge({}, async (address) => {
    const res = await postKey(address, 'f13');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'unknown key' });
    assert.equal(fakeAdb.last, undefined);
  });
});

test('keyevent returns 503 when device offline', async () => {
  fakeAdb.last = undefined;
  const offlineAdb = { isOnline: async () => false, keyEvent: async (key) => { offlineAdb.last = key; } };
  await withBridge({ adb: offlineAdb }, async (address) => {
    const res = await postKey(address, 'home');
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'device offline' });
    assert.equal(offlineAdb.last, undefined);
  });
});

test('address() reports the actually bound loopback address after start', async () => {
  const bridge = createBridge({ adb: fakeAdb, port: 0 });
  const { address } = await bridge.start();
  try {
    assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(bridge.address(), address);
    assert.notEqual(new URL(address).port, '0');
  } finally {
    await bridge.stop();
  }
});

test('oversized keyevent body is rejected without reaching adb', async () => {
  fakeAdb.last = undefined;
  await withBridge({}, async (address) => {
    const res = await fetch(`${address}/keyevent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(64 * 1024 + 1),
    });
    assert.equal(res.status, 413);
    assert.equal(fakeAdb.last, undefined);
  });
});

test('responses carry no CORS headers', async () => {
  await withBridge({}, async (address) => {
    const health = await fetch(`${address}/health`);
    const keyevent = await postKey(address, 'home');
    for (const res of [health, keyevent]) {
      assert.equal([...res.headers.keys()].some((name) => name.startsWith('access-control-')), false);
    }
  });
});
