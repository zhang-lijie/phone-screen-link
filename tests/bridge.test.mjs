import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

function postKey(address, key, extraHeaders = {}) {
  return fetch(`${address}/keyevent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ key }),
  });
}

const ALLOWED_ORIGIN = 'http://127.0.0.1:8000';

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

test('multi-chunk oversized body returns a single 413 without crashing the bridge', async () => {
  fakeAdb.last = undefined;
  await withBridge({}, async (address) => {
    const { port, hostname } = new URL(address);
    const responses = [];
    let requestError;

    await new Promise((resolve) => {
      const req = http.request({
        hostname,
        port,
        path: '/keyevent',
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          responses.push({ status: res.statusCode, body });
          resolve();
        });
      });
      req.on('error', (err) => { requestError = err; resolve(); });

      // 2 MiB in 64 KiB writes, so the cap is crossed well before the final chunk.
      const chunk = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 32; i += 1) req.write(chunk);
      req.end();
    });

    assert.equal(requestError, undefined);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 413);
    assert.deepEqual(JSON.parse(responses[0].body), { error: 'payload too large' });
    assert.equal(fakeAdb.last, undefined);

    // The service must still be alive and serving after the oversized POST.
    const res = await fetch(`${address}/health`);
    assert.deepEqual(await res.json(), { ok: true, online: true });
  });
});

test('authorized origin receives ACAO on success and error responses', async () => {
  const originHeaders = { origin: ALLOWED_ORIGIN };
  await withBridge({}, async (address) => {
    const health = await fetch(`${address}/health`, { headers: originHeaders });
    assert.equal(health.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);

    const ok = await postKey(address, 'home', originHeaders);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);

    const unknown = await postKey(address, 'f13', originHeaders);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);

    const oversized = await fetch(`${address}/keyevent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...originHeaders },
      body: 'x'.repeat(64 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  });

  await withBridge({ adb: { isOnline: async () => false, keyEvent: async () => {} } }, async (address) => {
    const offline = await postKey(address, 'home', originHeaders);
    assert.equal(offline.status, 503);
    assert.equal(offline.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  });
});

test('unauthorized and absent origins receive no ACAO', async () => {
  await withBridge({}, async (address) => {
    for (const headers of [{ origin: 'http://evil.example' }, {}]) {
      const health = await fetch(`${address}/health`, { headers });
      assert.equal(health.headers.get('access-control-allow-origin'), null);
      const keyevent = await postKey(address, 'home', headers);
      assert.equal(keyevent.headers.get('access-control-allow-origin'), null);
      const preflight = await fetch(`${address}/keyevent`, { method: 'OPTIONS', headers });
      assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    }
  });
});

test('OPTIONS preflight for the authorized origin returns 204 with narrow allow headers', async () => {
  await withBridge({}, async (address) => {
    const keyevent = await fetch(`${address}/keyevent`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    assert.equal(keyevent.status, 204);
    assert.equal(keyevent.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal(keyevent.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
    assert.equal(keyevent.headers.get('access-control-allow-headers'), 'content-type');

    const health = await fetch(`${address}/health`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'GET' },
    });
    assert.equal(health.status, 204);
    assert.equal(health.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal(health.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  });
});
