import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../server/bridge.mjs';
import { DEFAULT_CHAT_CONFIG, createChatConfigStore } from '../server/chat-config.mjs';

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
const LOCALHOST_ORIGIN = 'http://localhost:8000';

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

test('keyevent accepts the volume and overview keys', async () => {
  for (const key of ['volume_up', 'volume_down', 'overview']) {
    fakeAdb.last = undefined;
    await withBridge({}, async (address) => {
      const res = await postKey(address, key);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(fakeAdb.last, key);
    });
  }
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

test('localhost origin receives ACAO on keyevent responses', async () => {
  await withBridge({}, async (address) => {
    const ok = await postKey(address, 'home', { origin: LOCALHOST_ORIGIN });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), LOCALHOST_ORIGIN);
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

test('OPTIONS preflight for the localhost origin returns 204 with narrow allow headers', async () => {
  await withBridge({}, async (address) => {
    const keyevent = await fetch(`${address}/keyevent`, {
      method: 'OPTIONS',
      headers: { origin: LOCALHOST_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    assert.equal(keyevent.status, 204);
    assert.equal(keyevent.headers.get('access-control-allow-origin'), LOCALHOST_ORIGIN);
    assert.equal(keyevent.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
    assert.equal(keyevent.headers.get('access-control-allow-headers'), 'content-type');
  });
});

function tempChatConfig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-chat-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createChatConfigStore({ file: join(dir, 'chat.json') });
}

function getChatConfig(address, headers = {}) {
  return fetch(`${address}/api/chat-config`, { headers });
}

function postChatConfig(address, body, headers = {}) {
  return fetch(`${address}/api/chat-config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const PUBLIC_CHAT_CONFIG_DEFAULT = {
  enabled: false,
  baseUrl: DEFAULT_CHAT_CONFIG.baseUrl,
  model: '',
  maxSteps: 8,
  screenshot: true,
  hasApiKey: false,
};

test('chat config: GET returns the redacted public config for authorized origins', async (t) => {
  const chatConfig = tempChatConfig(t);
  await withBridge({ chatConfig }, async (address) => {
    for (const origin of [ALLOWED_ORIGIN, LOCALHOST_ORIGIN]) {
      const res = await getChatConfig(address, { origin });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
      const body = await res.json();
      assert.deepEqual(body, PUBLIC_CHAT_CONFIG_DEFAULT);
      assert.equal(Object.hasOwn(body, 'apiKey'), false);
    }
  });
});

test('chat config: POST persists model and apiKey; GET reports hasApiKey without leaking the key', async (t) => {
  const chatConfig = tempChatConfig(t);
  await withBridge({ chatConfig }, async (address) => {
    const headers = { origin: ALLOWED_ORIGIN };
    const post = await postChatConfig(address, { model: 'qwen3', apiKey: 'sk-x' }, headers);
    assert.equal(post.status, 200);
    assert.equal(post.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    const saved = await post.json();
    assert.equal(saved.model, 'qwen3');
    assert.equal(saved.hasApiKey, true);
    assert.equal(Object.hasOwn(saved, 'apiKey'), false);
    assert.equal(JSON.stringify(saved).includes('sk-x'), false);

    const res = await getChatConfig(address, headers);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.model, 'qwen3');
    assert.equal(body.hasApiKey, true);
    assert.equal(JSON.stringify(body).includes('sk-x'), false);

    assert.equal(chatConfig.load().apiKey, 'sk-x');
  });
});

test('chat config: POST {"enabled":true} toggles the agent on and back off', async (t) => {
  const chatConfig = tempChatConfig(t);
  await withBridge({ chatConfig }, async (address) => {
    const headers = { origin: ALLOWED_ORIGIN };

    const on = await postChatConfig(address, { enabled: true }, headers);
    assert.equal(on.status, 200);
    assert.equal((await on.json()).enabled, true);

    const res = await getChatConfig(address, headers);
    assert.equal((await res.json()).enabled, true);
    assert.equal(chatConfig.load().enabled, true);

    const off = await postChatConfig(address, { enabled: false }, headers);
    assert.equal((await off.json()).enabled, false);
    assert.equal(chatConfig.load().enabled, false);
  });
});

test('chat config: POST with invalid JSON returns 400 and changes nothing', async (t) => {
  const chatConfig = tempChatConfig(t);
  await withBridge({ chatConfig }, async (address) => {
    const res = await postChatConfig(address, '{not valid json', { origin: ALLOWED_ORIGIN });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid json' });
    assert.deepEqual(chatConfig.load(), { ...DEFAULT_CHAT_CONFIG });
  });
});

test('chat config: oversized POST body returns 413', async (t) => {
  const chatConfig = tempChatConfig(t);
  await withBridge({ chatConfig }, async (address) => {
    const res = await fetch(`${address}/api/chat-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: 'x'.repeat(64 * 1024 + 1),
    });
    assert.equal(res.status, 413);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.deepEqual(await res.json(), { error: 'payload too large' });
    assert.deepEqual(chatConfig.load(), { ...DEFAULT_CHAT_CONFIG });
  });
});

test('chat config: unauthorized and absent origins receive no ACAO', async (t) => {
  const chatConfig = tempChatConfig(t);
  await withBridge({ chatConfig }, async (address) => {
    for (const headers of [{ origin: 'http://evil.example' }, {}]) {
      const get = await getChatConfig(address, headers);
      assert.equal(get.status, 200);
      assert.equal(get.headers.get('access-control-allow-origin'), null);
      const post = await postChatConfig(address, { model: 'sneaky' }, headers);
      assert.equal(post.status, 200);
      assert.equal(post.headers.get('access-control-allow-origin'), null);
      const preflight = await fetch(`${address}/api/chat-config`, { method: 'OPTIONS', headers });
      assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    }
  });
});

test('chat config: OPTIONS preflight returns 204 with GET and POST allowed', async () => {
  await withBridge({}, async (address) => {
    for (const origin of [ALLOWED_ORIGIN, LOCALHOST_ORIGIN]) {
      const res = await fetch(`${address}/api/chat-config`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
      assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
      assert.equal(res.headers.get('access-control-allow-headers'), 'content-type');
      assert.equal(res.headers.get('access-control-max-age'), '600');
    }
  });
});

test('chat config: routes return 503 when no chatConfig store is wired', async () => {
  await withBridge({}, async (address) => {
    const get = await getChatConfig(address, { origin: ALLOWED_ORIGIN });
    assert.equal(get.status, 503);
    assert.deepEqual(await get.json(), { error: 'chat config unavailable' });

    const post = await postChatConfig(address, { model: 'qwen3' }, { origin: ALLOWED_ORIGIN });
    assert.equal(post.status, 503);
    assert.deepEqual(await post.json(), { error: 'chat config unavailable' });
  });
});
