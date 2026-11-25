import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../server/bridge.mjs';
import { DEFAULT_USB_SERIAL } from '../server/adb.mjs';
import { DEFAULT_CHAT_CONFIG, createChatConfigStore } from '../server/chat-config.mjs';

const fakeDevice = {
  serial: DEFAULT_USB_SERIAL,
  state: 'device',
  model: 'NOH AN01',
  product: 'NOH-AN01',
  transport: 'usb:1-5',
  selectable: true,
};

const fakeAdb = {
  listDevices: async () => [fakeDevice],
  isOnline: async () => true,
  keyEvent: async (key) => { fakeAdb.last = key; },
};

function usb(serial, state = 'device', model = 'Phone') {
  return {
    serial,
    state,
    model,
    product: '',
    transport: 'usb:1-1',
    selectable: state === 'device',
  };
}

// A device list that is independent of DEFAULT_USB_SERIAL, for selection tests.
function deviceAdb(devices, overrides = {}) {
  const adb = {
    listDevices: async () => devices,
    isOnline: async (serial) => devices.some((device) => device.serial === serial && device.selectable),
    keyEvent: async (key, serial) => { adb.last = { key, serial }; },
    wakeScreen: async (serial) => { adb.woke = serial; },
    getScreenTimeout: async () => 30000,
    setScreenTimeout: async (ms, serial) => { adb.lastSet = { ms, serial }; },
    ...overrides,
  };
  return adb;
}

async function getDevices(address, extraHeaders = {}) {
  return fetch(`${address}/api/devices`, { headers: extraHeaders });
}

async function selectDevice(address, body, extraHeaders = {}) {
  return fetch(`${address}/api/devices/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

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
    assert.deepEqual(await res.json(), {
      ok: true, online: true, serial: DEFAULT_USB_SERIAL, devices: 1, preferred: DEFAULT_USB_SERIAL,
    });
  });
});

test('health reports offline from adb', async () => {
  await withBridge({ adb: { listDevices: async () => [fakeDevice], isOnline: async () => false, keyEvent: fakeAdb.keyEvent } }, async (address) => {
    const res = await fetch(`${address}/health`);
    assert.deepEqual(await res.json(), {
      ok: true, online: false, serial: DEFAULT_USB_SERIAL, devices: 1, preferred: DEFAULT_USB_SERIAL,
    });
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
  const offlineAdb = { listDevices: async () => [fakeDevice], isOnline: async () => false, keyEvent: async (key) => { offlineAdb.last = key; } };
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
    assert.deepEqual(await res.json(), {
      ok: true, online: true, serial: DEFAULT_USB_SERIAL, devices: 1, preferred: DEFAULT_USB_SERIAL,
    });
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

  await withBridge({ adb: { listDevices: async () => [fakeDevice], isOnline: async () => false, keyEvent: async () => {} } }, async (address) => {
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
      const preflight = await fetch(`${address}/keyevent`, { method: 'OPTIONS', headers });
      assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    }
  });
});

test('keyevent: a cross-origin POST is rejected with 403 and never reaches adb', async () => {
  fakeAdb.last = undefined;
  await withBridge({}, async (address) => {
    // A malicious page can send a "simple request" (text/plain, no preflight);
    // CORS alone would not stop it, so the bridge must reject the Origin.
    for (const contentType of ['application/json', 'text/plain']) {
      const res = await fetch(`${address}/keyevent`, {
        method: 'POST',
        headers: { 'content-type': contentType, origin: 'http://evil.example' },
        body: JSON.stringify({ key: 'home' }),
      });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: 'origin not allowed' });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      assert.equal(fakeAdb.last, undefined);
    }

    // curl and other non-browser clients send no Origin and keep working.
    const noOrigin = await postKey(address, 'home');
    assert.equal(noOrigin.status, 200);
    assert.equal(fakeAdb.last, 'home');
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
  maxSteps: 100,
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

test('chat config: a cross-origin POST is rejected with 403 and the config is unchanged', async (t) => {
  const chatConfig = tempChatConfig(t);
  await withBridge({ chatConfig }, async (address) => {
    // Reads stay open (no secrets in publicConfig), but a hostile page must
    // not be able to repoint the model URL or toggle the agent, even with a
    // preflight-free "simple request" content type.
    for (const contentType of ['application/json', 'text/plain']) {
      const post = await fetch(`${address}/api/chat-config`, {
        method: 'POST',
        headers: { 'content-type': contentType, origin: 'http://evil.example' },
        body: JSON.stringify({ enabled: true, baseUrl: 'http://evil.example/v1', model: 'sneaky', apiKey: 'sk-x' }),
      });
      assert.equal(post.status, 403);
      assert.deepEqual(await post.json(), { error: 'origin not allowed' });
      assert.equal(post.headers.get('access-control-allow-origin'), null);
      assert.deepEqual(chatConfig.load(), { ...DEFAULT_CHAT_CONFIG });
    }

    const get = await getChatConfig(address, { origin: 'http://evil.example' });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('access-control-allow-origin'), null);
    const preflight = await fetch(`${address}/api/chat-config`, {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example' },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  });
});

test('chat config: POST without an Origin (curl) still saves; no ACAO is emitted', async (t) => {
  const chatConfig = tempChatConfig(t);
  await withBridge({ chatConfig }, async (address) => {
    const post = await postChatConfig(address, { model: 'qwen3' });
    assert.equal(post.status, 200);
    assert.equal(post.headers.get('access-control-allow-origin'), null);
    assert.equal(chatConfig.load().model, 'qwen3');
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

// ---------------------------------------------------------------------------
// /chat route (Task 7)
// ---------------------------------------------------------------------------

function postChat(address, body, headers = {}) {
  return fetch(`${address}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// Fake agent: counts run() invocations so tests can prove the model layer is
// never reached when the backend config gates the request. Records the config
// the bridge hands over (M8: the gated load is reused, never re-read).
function fakeChat(result) {
  const chat = {
    calls: [],
    run: async (message, lang, config) => {
      chat.calls.push({ message, lang, config });
      return result ?? { reply: '好的，已回到桌面', steps: [{ tool: 'press_home', ok: true }] };
    },
  };
  return chat;
}

function enabledChatConfig(t) {
  const chatConfig = tempChatConfig(t);
  chatConfig.save({ enabled: true, model: 'qwen3' });
  return chatConfig;
}

test('chat: POST /chat returns reply and steps from the injected agent', async (t) => {
  const chatConfig = enabledChatConfig(t);
  const chat = fakeChat();
  await withBridge({ chatConfig, chat }, async (address) => {
    const res = await postChat(address, { message: '回到桌面', lang: 'zh' }, { origin: ALLOWED_ORIGIN });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.deepEqual(await res.json(), { reply: '好的，已回到桌面', steps: [{ tool: 'press_home', ok: true }] });
    assert.deepEqual(chat.calls, [{ message: '回到桌面', lang: 'zh', config: chatConfig.load() }]);
  });
});

test('chat: POST /chat passes only message and lang to the agent; body config fields are ignored', async (t) => {
  // Disabled backend config: nothing in the body may switch chat on.
  const chatConfig = tempChatConfig(t);
  const chat = fakeChat();
  const sneaky = {
    message: 'hi',
    lang: 'en',
    enabled: true,
    model: 'evil-model',
    baseUrl: 'http://evil.example',
    apiKey: 'sk-stolen',
  };
  await withBridge({ chatConfig, chat }, async (address) => {
    const res = await postChat(address, sneaky, { origin: ALLOWED_ORIGIN });
    assert.equal(res.status, 503);
    assert.deepEqual(chat.calls, []);

    // Now enable on the backend: the same body succeeds, and the agent still
    // receives only message, lang, and the backend config — never body fields.
    chatConfig.save({ enabled: true, model: 'qwen3' });
    const ok = await postChat(address, sneaky, { origin: ALLOWED_ORIGIN });
    assert.equal(ok.status, 200);
    assert.deepEqual(chat.calls, [{ message: 'hi', lang: 'en', config: chatConfig.load() }]);
    assert.equal(chat.calls[0].config.model, 'qwen3');
    assert.equal(chat.calls[0].config.baseUrl, DEFAULT_CHAT_CONFIG.baseUrl);
    assert.equal(chat.calls[0].config.apiKey, '');
  });
});

test('chat: the gated config is loaded once per request and handed to the agent', async (t) => {
  const chatConfig = enabledChatConfig(t);
  let loads = 0;
  const innerLoad = chatConfig.load.bind(chatConfig);
  chatConfig.load = () => { loads += 1; return innerLoad(); };
  const chat = fakeChat();
  await withBridge({ chatConfig, chat }, async (address) => {
    const res = await postChat(address, { message: 'hi', lang: 'en' });
    assert.equal(res.status, 200);
    assert.equal(loads, 1, 'the gate load must be reused, not repeated (TOCTOU)');
    assert.deepEqual(chat.calls[0].config, innerLoad());
  });
});

test('chat: POST /chat returns 503 without running the agent when enabled is false', async (t) => {
  const chatConfig = tempChatConfig(t); // DEFAULT: enabled:false, model:''
  chatConfig.save({ model: 'qwen3' }); // model set, but still disabled
  const chat = fakeChat();
  await withBridge({ chatConfig, chat }, async (address) => {
    const res = await postChat(address, { message: '打开设置', lang: 'zh' });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'chat disabled' });
    assert.deepEqual(chat.calls, []);
  });
});

test('chat: POST /chat returns 503 without running the agent when model is empty', async (t) => {
  const chatConfig = tempChatConfig(t);
  chatConfig.save({ enabled: true }); // enabled, but model stays ''
  const chat = fakeChat();
  await withBridge({ chatConfig, chat }, async (address) => {
    const res = await postChat(address, { message: '打开设置', lang: 'zh' });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'chat disabled' });
    assert.deepEqual(chat.calls, []);
  });
});

test('chat: POST /chat returns 400 when message is missing or not a string', async (t) => {
  const chatConfig = enabledChatConfig(t);
  await withBridge({ chatConfig }, async (address) => {
    for (const body of [{}, { message: 42 }, { message: null }, { lang: 'zh' }]) {
      const res = await postChat(address, body);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'message required' });
    }
  });
});

test('chat: POST /chat rejects invalid json and oversized bodies', async (t) => {
  const chatConfig = enabledChatConfig(t);
  const chat = fakeChat();
  await withBridge({ chatConfig, chat }, async (address) => {
    const invalid = await postChat(address, '{not valid json');
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'invalid json' });

    const oversized = await fetch(`${address}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(64 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: 'payload too large' });
    assert.deepEqual(chat.calls, []);
  });
});

test('chat: POST /chat returns 503 when the agent or config store is not wired', async (t) => {
  const chatConfig = enabledChatConfig(t);
  const chat = fakeChat();
  await withBridge({ chatConfig }, async (address) => {
    const res = await postChat(address, { message: '回到桌面', lang: 'zh' });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'chat unavailable' });
  });

  await withBridge({ chat }, async (address) => {
    const res = await postChat(address, { message: '回到桌面', lang: 'zh' });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'chat unavailable' });
    assert.deepEqual(chat.calls, []);
  });
});

test('chat: a cross-origin POST is rejected with 403 and never runs the agent', async (t) => {
  const chatConfig = enabledChatConfig(t);
  const chat = fakeChat();
  await withBridge({ chatConfig, chat }, async (address) => {
    for (const contentType of ['application/json', 'text/plain']) {
      const res = await fetch(`${address}/chat`, {
        method: 'POST',
        headers: { 'content-type': contentType, origin: 'http://evil.example' },
        body: JSON.stringify({ message: 'tap everywhere', lang: 'en' }),
      });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: 'origin not allowed' });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      assert.deepEqual(chat.calls, []);
    }

    // No Origin (curl) keeps working.
    const ok = await postChat(address, { message: 'hi', lang: 'en' });
    assert.equal(ok.status, 200);
    assert.equal(chat.calls.length, 1);
  });
});

test('chat: agent failure surfaces as 502 with the readable error message', async (t) => {
  const chatConfig = enabledChatConfig(t);
  const chat = { run: async () => { throw new Error('Model API error 500: model not found'); } };
  await withBridge({ chatConfig, chat }, async (address) => {
    const res = await postChat(address, { message: '回到桌面', lang: 'zh' });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'Model API error 500: model not found' });
  });
});

test('chat: an unexpected backend bug still returns the generic 500', async (t) => {
  const chatConfig = enabledChatConfig(t);
  chatConfig.load = () => { throw new Error('secret internal detail'); };
  const chat = fakeChat();
  await withBridge({ chatConfig, chat }, async (address) => {
    const res = await postChat(address, { message: '回到桌面', lang: 'zh' });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal error' });
    assert.deepEqual(chat.calls, []);
  });
});

test('chat: OPTIONS preflight allows POST', async () => {
  await withBridge({}, async (address) => {
    for (const origin of [ALLOWED_ORIGIN, LOCALHOST_ORIGIN]) {
      const res = await fetch(`${address}/chat`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
      assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
      assert.equal(res.headers.get('access-control-allow-headers'), 'content-type');
    }
  });
});


test('chat-command: runs preset command via chat.runCommand and returns reply', async () => {
  let received;
  const chat = {
    runCommand: async (command, lang) => { received = [command, lang]; return { reply: 'done', ok: true, steps: [{ tool: 'press_key', ok: true }] }; },
  };
  await withBridge({ chat }, async (address) => {
    const res = await fetch(`${address}/api/chat-command`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'desktop', lang: 'zh' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reply, 'done');
    assert.equal(body.ok, true);
    assert.deepEqual(received, ['desktop', 'zh']);
  });
});

test('chat-command: rejects missing command and when chat unavailable', async () => {
  await withBridge({ chat: { runCommand: async () => ({ reply: 'x', ok: true }) } }, async (address) => {
    const bad = await fetch(`${address}/api/chat-command`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(bad.status, 400);
  });
  await withBridge({ chat: undefined }, async (address) => {
    const res = await fetch(`${address}/api/chat-command`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'desktop' }),
    });
    assert.equal(res.status, 503);
  });
});


test('chat-screen: wake saves timeout and sets 1h; restore writes original back', async () => {
  const fake = {
    listDevices: async () => [fakeDevice],
    isOnline: async () => true,
    keyEvent: async () => {},
    wakeScreen: async () => { fake.woke = true; },
    getScreenTimeout: async () => 30000,
    setScreenTimeout: async (ms) => { fake.lastSet = ms; },
  };
  await withBridge({ adb: fake }, async (address) => {
    const wake = await fetch(`${address}/api/chat-screen`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'wake' }),
    });
    assert.equal(wake.status, 200);
    assert.equal(fake.woke, true);
    assert.equal(fake.lastSet, 3600000);

    fake.lastSet = null;
    const restore = await fetch(`${address}/api/chat-screen`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'restore' }),
    });
    assert.equal(restore.status, 200);
    assert.equal(fake.lastSet, 30000, 'original timeout restored');
  });
});

test('chat-screen: rejects bad action and offline device', async () => {
  const fake = {
    listDevices: async () => [fakeDevice],
    isOnline: async () => false,
    wakeScreen: async () => {},
    getScreenTimeout: async () => 30000,
    setScreenTimeout: async () => {},
  };
  await withBridge({ adb: fake }, async (address) => {
    const bad = await fetch(`${address}/api/chat-screen`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'nonsense' }),
    });
    assert.equal(bad.status, 400);
    const wake = await fetch(`${address}/api/chat-screen`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'wake' }),
    });
    assert.equal(wake.status, 503);
  });
});


// --------------------------------------------------------------- device picking

test('GET /api/devices lists USB devices and auto-selects the only one', async () => {
  await withBridge({ adb: deviceAdb([usb('A', 'device', 'Pixel 7')]) }, async (address) => {
    const res = await getDevices(address);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      devices: [usb('A', 'device', 'Pixel 7')],
      selected: 'A',
      preferred: DEFAULT_USB_SERIAL,
      adbMissing: false,
    });
  });
});

test('GET /api/devices needs a choice when two devices are present', async () => {
  await withBridge({ adb: deviceAdb([usb('A'), usb('B')]), preferredSerial: null }, async (address) => {
    const res = await getDevices(address);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.deepEqual(payload.devices.map((device) => device.serial), ['A', 'B']);
    assert.equal(payload.selected, null);

    const key = await postKey(address, 'home');
    assert.equal(key.status, 409);
    assert.deepEqual(await key.json(), { error: 'device selection required' });
  });
});

test('POST /api/devices/select switches the serial used by keyevent', async () => {
  const adb = deviceAdb([usb('A'), usb('B')]);
  await withBridge({ adb, preferredSerial: null }, async (address) => {
    const res = await selectDevice(address, { serial: 'B' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, selected: 'B' });
    assert.equal((await postKey(address, 'home')).status, 200);
    assert.deepEqual(adb.last, { key: 'home', serial: 'B' });
  });
});

test('POST /api/devices/select rejects unknown or unauthorised devices', async () => {
  await withBridge({ adb: deviceAdb([usb('A'), usb('B', 'unauthorized')]), preferredSerial: null }, async (address) => {
    for (const serial of ['Z', 'B']) {
      const res = await selectDevice(address, { serial });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: 'device not available' });
    }
  });
});

test('POST /api/devices/select rejects a non-string serial', async () => {
  await withBridge({ adb: deviceAdb([usb('A')]), preferredSerial: null }, async (address) => {
    const res = await selectDevice(address, { serial: 42 });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'serial required' });
  });
});

test('POST /api/devices/select rejects a disallowed origin', async () => {
  await withBridge({ adb: deviceAdb([usb('A')]), preferredSerial: null }, async (address) => {
    const res = await selectDevice(address, { serial: 'A' }, { origin: 'http://evil.example' });
    assert.equal(res.status, 403);
  });
});

test('health reports the selected serial and its online state', async () => {
  await withBridge({
    adb: deviceAdb([usb('A'), usb('B')]),
    preferredSerial: null,
  }, async (address) => {
    let res = await fetch(`${address}/health`);
    assert.deepEqual(await res.json(), { ok: true, online: false, serial: null, devices: 2, preferred: null });
    await selectDevice(address, { serial: 'B' });
    res = await fetch(`${address}/health`);
    assert.deepEqual(await res.json(), { ok: true, online: true, serial: 'B', devices: 2, preferred: null });
  });
});

test('onSelectionChange fires once per actual change', async () => {
  const changes = [];
  const adb = deviceAdb([usb('A')]);
  await withBridge({ adb, onSelectionChange: (serial) => changes.push(serial) }, async (address) => {
    await getDevices(address);
    await getDevices(address);
    assert.deepEqual(changes, ['A']);
  });
});

test('GET /api/devices reports adbMissing while adb is still installing', async () => {
  const adb = deviceAdb([]);
  adb.listDevices = async () => {
    throw Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' });
  };
  await withBridge({ adb }, async (address) => {
    const res = await getDevices(address);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { devices: [], selected: null, preferred: DEFAULT_USB_SERIAL, adbMissing: true });
  });
});

test('chat-screen targets the selected serial', async () => {
  const adb = deviceAdb([usb('A'), usb('B')]);
  await withBridge({ adb, preferredSerial: null }, async (address) => {
    await selectDevice(address, { serial: 'B' });
    const res = await fetch(`${address}/api/chat-screen`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'wake' }),
    });
    assert.equal(res.status, 200);
    assert.equal(adb.woke, 'B');
    assert.deepEqual(adb.lastSet, { ms: 3600000, serial: 'B' });
  });
});

test('select does not restore the previous phone timeout onto the new one', async () => {
  const adb = deviceAdb([usb('A'), usb('B')]);
  adb.getScreenTimeout = async () => 15000;
  await withBridge({ adb, preferredSerial: null }, async (address) => {
    await selectDevice(address, { serial: 'A' });
    const wake = await fetch(`${address}/api/chat-screen`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'wake' }),
    });
    assert.equal(wake.status, 200);
    assert.deepEqual(adb.lastSet, { ms: 3600000, serial: 'A' });

    await selectDevice(address, { serial: 'B' });
    adb.lastSet = undefined;
    const restore = await fetch(`${address}/api/chat-screen`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'restore' }),
    });
    assert.equal(restore.status, 200);
    assert.equal(adb.lastSet, undefined, 'A\'s timeout must never be written to B');
  });
});

test('select skips the intermediate preferred device when announcing', async () => {
  const changes = [];
  await withBridge({
    adb: deviceAdb([usb('A'), usb('B')]),
    preferredSerial: 'A',
    onSelectionChange: (serial) => changes.push(serial),
  }, async (address) => {
    await selectDevice(address, { serial: 'B' });
    assert.deepEqual(changes, ['B']);
  });
});
