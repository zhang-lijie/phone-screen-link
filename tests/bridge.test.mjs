import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../server/bridge.mjs';
import { createAdb, DEFAULT_USB_SERIAL } from '../server/adb.mjs';
import { createConnectionConfigStore } from '../server/connection-config.mjs';
import { createConnectionService } from '../server/connection-service.mjs';
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
    assert.deepEqual(await res.json(), { ok: true, online: true, serial: DEFAULT_USB_SERIAL, mode: 'usb' });
  });
});

test('health reports offline from adb', async () => {
  await withBridge({ adb: { isOnline: async () => false, keyEvent: fakeAdb.keyEvent } }, async (address) => {
    const res = await fetch(`${address}/health`);
    assert.deepEqual(await res.json(), { ok: true, online: false, serial: DEFAULT_USB_SERIAL, mode: 'usb' });
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
    assert.deepEqual(await res.json(), { ok: true, online: true, serial: DEFAULT_USB_SERIAL, mode: 'usb' });
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
  model: DEFAULT_CHAT_CONFIG.model,
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
  chatConfig.save({ enabled: true, model: '' }); // explicitly empty still disables
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

// ---------------------------------------------------------------------------
// Wireless connection API (Task 4)
// ---------------------------------------------------------------------------

const WIRELESS_SERIAL = '192.168.1.50:5555';
const WIRELESS_STATUS = Object.freeze({ mode: 'wifi', serial: WIRELESS_SERIAL, online: true, usbOnline: true });
const USB_STATUS = Object.freeze({ mode: 'usb', serial: DEFAULT_USB_SERIAL, online: true, usbOnline: true });
const WIRELESS_DISCOVERY = Object.freeze({
  usbSerial: DEFAULT_USB_SERIAL,
  pairHost: '192.168.1.42',
  pairPort: 37123,
  connectHost: '192.168.1.42',
  connectPort: 42123,
  warnings: [],
});
const PAIR_INPUT = Object.freeze({
  pairHost: '192.168.1.20',
  pairPort: '37123',
  pairCode: '123456',
  connectHost: 'phone.local',
  connectPort: 5555,
});

function fakeConnectionService({
  status = WIRELESS_STATUS,
  pairResult = status,
  usbResult = USB_STATUS,
  discovery = WIRELESS_DISCOVERY,
} = {}) {
  const service = {
    pairCalls: [],
    usbCalls: 0,
    discoverCalls: 0,
    status: async () => ({ ...status }),
    pairAndConnect: async (input) => {
      service.pairCalls.push(input);
      return { ...pairResult };
    },
    switchToUsb: async () => {
      service.usbCalls += 1;
      return { ...usbResult };
    },
    discoverWirelessConfig: async () => {
      service.discoverCalls += 1;
      return { ...discovery };
    },
  };
  return service;
}

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function postWirelessPair(address, body, headers = {}) {
  return fetch(`${address}/api/wireless/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function postWirelessUsb(address, headers = {}) {
  return fetch(`${address}/api/wireless/usb`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function postWirelessAuto(address, headers = {}) {
  return fetch(`${address}/api/wireless/auto`, {
    method: 'POST',
    headers,
  });
}

test('wireless: GET returns the active connection status for an allowed origin', async () => {
  const connectionService = fakeConnectionService({
    status: { ...WIRELESS_STATUS, pairCode: PAIR_INPUT.pairCode, debug: 'must not be exposed' },
  });
  await withBridge({ connectionService }, async (address) => {
    const res = await fetch(`${address}/api/wireless`, { headers: { origin: ALLOWED_ORIGIN } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.deepEqual(await res.json(), { ok: true, ...WIRELESS_STATUS });
  });
});

test('wireless: GET reports targeted USB availability independently from active wireless status', async () => {
  const connectionService = fakeConnectionService({
    status: { ...WIRELESS_STATUS, usbOnline: false },
  });
  await withBridge({ connectionService }, async (address) => {
    const res = await fetch(`${address}/api/wireless`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ...WIRELESS_STATUS, usbOnline: false });
  });
});

test('wireless: routes return 503 when no connection service is wired', async () => {
  await withBridge({}, async (address) => {
    const status = await fetch(`${address}/api/wireless`);
    assert.equal(status.status, 503);
    assert.deepEqual(await status.json(), { error: 'wireless connection unavailable' });

    const pair = await postWirelessPair(address, PAIR_INPUT);
    assert.equal(pair.status, 503);
    assert.deepEqual(await pair.json(), { error: 'wireless connection unavailable' });

    const usb = await postWirelessUsb(address);
    assert.equal(usb.status, 503);
    assert.deepEqual(await usb.json(), { error: 'wireless connection unavailable' });

    const auto = await postWirelessAuto(address);
    assert.equal(auto.status, 503);
    assert.deepEqual(await auto.json(), { error: 'wireless connection unavailable' });
  });
});

test('wireless: POST pair forwards the five fields and returns only connection status', async () => {
  const connectionService = fakeConnectionService({
    pairResult: { ...WIRELESS_STATUS, pairCode: PAIR_INPUT.pairCode, debug: 'must not be exposed' },
  });
  await withBridge({ connectionService }, async (address) => {
    const res = await postWirelessPair(address, PAIR_INPUT, { origin: ALLOWED_ORIGIN });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { ok: true, ...WIRELESS_STATUS });
    assert.equal(text.includes(PAIR_INPUT.pairCode), false);
    assert.deepEqual(connectionService.pairCalls, [PAIR_INPUT]);
    assert.equal(connectionService.usbCalls, 0);
  });
});

test('wireless: POST pair rejects malformed input with 400 before calling the service', async () => {
  const connectionService = fakeConnectionService();
  const invalidInputs = [
    [null, 'pairing input'],
    [[], 'pairing input'],
    [JSON.stringify('not an object'), 'pairing input'],
    [{ ...PAIR_INPUT, pairHost: '' }, 'pairHost'],
    [{ ...PAIR_INPUT, pairHost: 'bad host' }, 'pairHost'],
    [{ ...PAIR_INPUT, pairHost: '192.168.1.999' }, 'pairHost'],
    [{ ...PAIR_INPUT, pairHost: 'a..b' }, 'pairHost'],
    [{ ...PAIR_INPUT, pairHost: '::1' }, 'pairHost'],
    [{ ...PAIR_INPUT, pairPort: 0 }, 'pairPort'],
    [{ ...PAIR_INPUT, pairPort: 65536 }, 'pairPort'],
    [{ ...PAIR_INPUT, pairPort: 1.5 }, 'pairPort'],
    [{ ...PAIR_INPUT, pairPort: 'abc' }, 'pairPort'],
    [{ ...PAIR_INPUT, pairPort: true }, 'pairPort'],
    [{ ...PAIR_INPUT, pairCode: '12345' }, 'pairCode'],
    [{ ...PAIR_INPUT, pairCode: '1234567' }, 'pairCode'],
    [{ ...PAIR_INPUT, pairCode: 'abcdef' }, 'pairCode'],
    [{ ...PAIR_INPUT, pairCode: '１２３４５６' }, 'pairCode'],
    [{ ...PAIR_INPUT, connectHost: '' }, 'connectHost'],
    [{ ...PAIR_INPUT, connectHost: '-phone.local' }, 'connectHost'],
    [{ ...PAIR_INPUT, connectPort: -1 }, 'connectPort'],
    [{ ...PAIR_INPUT, connectPort: '65536' }, 'connectPort'],
    [{ ...PAIR_INPUT, connectPort: '' }, 'connectPort'],
    [{ ...PAIR_INPUT, connectPort: false }, 'connectPort'],
  ];

  await withBridge({ connectionService }, async (address) => {
    for (const [body, field] of invalidInputs) {
      const res = await postWirelessPair(address, body);
      assert.equal(res.status, 400, `${field}: expected status 400, got ${res.status}`);
      const payload = await res.json();
      assert.match(payload.error, new RegExp(field));
      if (body && typeof body === 'object' && typeof body.pairCode === 'string') {
        assert.equal(JSON.stringify(payload).includes(body.pairCode), false);
      }
      assert.equal(connectionService.pairCalls.length, 0);
    }

    const invalidJson = await postWirelessPair(address, '{not valid json');
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), { error: 'invalid json' });
    assert.equal(connectionService.pairCalls.length, 0);
  });
});

test('wireless: POST pair maps service failures to 502 and redacts the pairing code', async () => {
  for (const failure of [
    new Error(`pair command failed for code ${PAIR_INPUT.pairCode}`),
    `connect command failed for code ${PAIR_INPUT.pairCode}`,
  ]) {
    const connectionService = fakeConnectionService();
    connectionService.pairAndConnect = async (input) => {
      connectionService.pairCalls.push(input);
      throw failure;
    };
    await withBridge({ connectionService }, async (address) => {
      const res = await postWirelessPair(address, PAIR_INPUT);
      assert.equal(res.status, 502);
      const text = await res.text();
      const payload = JSON.parse(text);
      assert.match(payload.error, /command failed for code \[redacted\]/);
      assert.equal(text.includes(PAIR_INPUT.pairCode), false);
      assert.equal(connectionService.usbCalls, 0);
    });
  }
});

test('wireless: status failures return 502 without exposing extra service data', async () => {
  const connectionService = fakeConnectionService();
  connectionService.status = async () => { throw new Error('device state unavailable'); };
  await withBridge({ connectionService }, async (address) => {
    const res = await fetch(`${address}/api/wireless`);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'device state unavailable' });
  });
});

test('wireless: POST usb restores USB status and maps service failures to 502', async () => {
  const connectionService = fakeConnectionService({ usbResult: { ...USB_STATUS, debug: 'must not be exposed' } });
  await withBridge({ connectionService }, async (address) => {
    const res = await postWirelessUsb(address, { origin: ALLOWED_ORIGIN });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.deepEqual(await res.json(), { ok: true, ...USB_STATUS });
    assert.equal(connectionService.usbCalls, 1);
  });

  connectionService.switchToUsb = async () => { throw new Error('usb switch failed'); };
  await withBridge({ connectionService }, async (address) => {
    const res = await postWirelessUsb(address);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'usb switch failed' });
  });
});

test('wireless: POST auto returns only full discovery fields for an allowed origin', async () => {
  const connectionService = fakeConnectionService({
    discovery: { ...WIRELESS_DISCOVERY, pairCode: PAIR_INPUT.pairCode, debug: 'must not be exposed' },
  });
  await withBridge({ connectionService }, async (address) => {
    const res = await postWirelessAuto(address, { origin: ALLOWED_ORIGIN });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), WIRELESS_DISCOVERY);
    assert.equal(text.includes(PAIR_INPUT.pairCode), false);
    assert.equal(connectionService.discoverCalls, 1);
    assert.equal(connectionService.pairCalls.length, 0);
    assert.equal(connectionService.usbCalls, 0);
  });
});

test('wireless: POST auto returns partial discovery data and warnings without pairing or switching', async () => {
  const discovery = {
    usbSerial: DEFAULT_USB_SERIAL,
    pairHost: '192.168.1.42',
    pairPort: null,
    connectHost: '192.168.1.42',
    connectPort: 42123,
    warnings: ['PAIRING_PORT_UNAVAILABLE'],
  };
  const connectionService = fakeConnectionService({ discovery });
  await withBridge({ connectionService }, async (address) => {
    const res = await postWirelessAuto(address);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), discovery);
    assert.equal(connectionService.discoverCalls, 1);
    assert.equal(connectionService.pairCalls.length, 0);
    assert.equal(connectionService.usbCalls, 0);
  });
});

test('wireless: POST auto exposes only stable warning codes', async () => {
  const discovery = {
    ...WIRELESS_DISCOVERY,
    pairPort: null,
    warnings: ['PAIRING_PORT_UNAVAILABLE', 'English warning from an untrusted service', 42, 'PAIRING_PORT_UNAVAILABLE'],
  };
  const connectionService = fakeConnectionService({ discovery });
  await withBridge({ connectionService }, async (address) => {
    const res = await postWirelessAuto(address);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ...discovery,
      warnings: ['PAIRING_PORT_UNAVAILABLE'],
    });
  });
});

test('wireless: POST auto maps an offline USB device to 409', async () => {
  const connectionService = fakeConnectionService();
  connectionService.discoverWirelessConfig = async () => {
    connectionService.discoverCalls += 1;
    throw Object.assign(new Error('USB device is offline'), { code: 'USB_OFFLINE' });
  };
  await withBridge({ connectionService }, async (address) => {
    const res = await postWirelessAuto(address, { origin: ALLOWED_ORIGIN });
    assert.equal(res.status, 409);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.deepEqual(await res.json(), { error: 'USB device is offline' });
    assert.equal(connectionService.discoverCalls, 1);
    assert.equal(connectionService.pairCalls.length, 0);
    assert.equal(connectionService.usbCalls, 0);
  });
});

test('wireless: POST auto maps ADB failures to 502', async () => {
  const connectionService = fakeConnectionService();
  connectionService.discoverWirelessConfig = async () => {
    connectionService.discoverCalls += 1;
    throw new Error('adb shell failed');
  };
  await withBridge({ connectionService }, async (address) => {
    const res = await postWirelessAuto(address);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'adb shell failed' });
    assert.equal(connectionService.discoverCalls, 1);
    assert.equal(connectionService.pairCalls.length, 0);
    assert.equal(connectionService.usbCalls, 0);
  });
});

test('wireless: POST auto distinguishes explicit USB absence from host-side get-state failures', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-wireless-get-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConnectionConfigStore({ file: join(dir, 'connection.json') });
  store.save({ mode: 'usb', address: '' });
  const cases = [
    {
      label: 'device not found',
      failure: Object.assign(new Error('Command failed: adb get-state'), {
        stderr: `error: device '${DEFAULT_USB_SERIAL}' not found\n`,
      }),
      status: 409,
      error: 'USB device is offline',
    },
    {
      label: 'adb-prefixed offline stdout',
      failure: Object.assign(new Error('Command failed: adb get-state'), {
        stdout: `adb: error: device '${DEFAULT_USB_SERIAL}' offline\n`,
      }),
      status: 409,
      error: 'USB device is offline',
    },
    {
      label: 'adb server failure',
      failure: Object.assign(new Error('adb server failure'), {
        stderr: "error: cannot connect to daemon at 'tcp:5037': Connection refused\n",
      }),
      status: 502,
      error: 'adb server failure',
    },
  ];

  for (const { label, failure, status, error } of cases) {
    const calls = [];
    const adb = createAdb(async (args) => {
      calls.push(args);
      throw failure;
    });
    const connectionService = createConnectionService({ adb, store, usbSerial: DEFAULT_USB_SERIAL });
    await withBridge({ adb, connectionService }, async (address) => {
      const res = await postWirelessAuto(address);
      assert.equal(res.status, status, label);
      assert.deepEqual(await res.json(), { error });
    });
    assert.deepEqual(calls, [['-s', DEFAULT_USB_SERIAL, 'get-state']]);
  }
});

test('wireless: concurrent pair and USB requests wait for serialized transactions and return fresh status', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-wireless-concurrency-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previousAddress = '10.0.0.9:5555';
  const store = createConnectionConfigStore({ file: join(dir, 'connection.json') });
  store.save({ mode: 'wifi', address: previousAddress });
  const pairGate = deferred();
  let markPairStarted;
  const pairStarted = new Promise((resolve) => { markPairStarted = resolve; });
  let markUsbInvoked;
  const usbInvoked = new Promise((resolve) => { markUsbInvoked = resolve; });
  const adb = createAdb(async (args) => {
    if (args[0] === 'pair') {
      markPairStarted();
      await pairGate.promise;
      return '';
    }
    if (args[0] === '-s') return 'device\n';
    if (args[0] === 'devices') return `List of devices attached\n${DEFAULT_USB_SERIAL} device\n`;
    return '';
  }, { mode: 'wifi', serial: previousAddress });
  const service = createConnectionService({ adb, store, usbSerial: DEFAULT_USB_SERIAL });
  const connectionService = {
    status: () => service.status(),
    pairAndConnect: (input) => service.pairAndConnect(input),
    switchToUsb: () => {
      markUsbInvoked();
      return service.switchToUsb();
    },
  };

  await withBridge({ adb, connectionService }, async (address) => {
    const pairResponse = postWirelessPair(address, PAIR_INPUT);
    let usbResponse;
    try {
      await pairStarted;
      usbResponse = postWirelessUsb(address);
      await usbInvoked;
      assert.equal(adb.getMode(), 'wifi', 'USB transaction must wait for pairing to commit');
      assert.deepEqual(store.load(), { mode: 'wifi', address: previousAddress });
    } finally {
      pairGate.resolve();
      await Promise.allSettled([pairResponse, usbResponse]);
    }

    const pair = await pairResponse;
    assert.equal(pair.status, 200);
    assert.deepEqual(await pair.json(), {
      ok: true, mode: 'wifi', serial: 'phone.local:5555', online: true, usbOnline: true,
    });

    const usb = await usbResponse;
    assert.equal(usb.status, 200);
    assert.deepEqual(await usb.json(), { ok: true, ...USB_STATUS });
    assert.deepEqual(store.load(), { mode: 'usb', address: '' });
  });
});

test('wireless: cross-origin POSTs are rejected before pairing or switching', async () => {
  const connectionService = fakeConnectionService();
  await withBridge({ connectionService }, async (address) => {
    for (const contentType of ['application/json', 'text/plain']) {
      const pair = await fetch(`${address}/api/wireless/pair`, {
        method: 'POST',
        headers: { 'content-type': contentType, origin: 'http://evil.example' },
        body: JSON.stringify(PAIR_INPUT),
      });
      assert.equal(pair.status, 403);
      assert.deepEqual(await pair.json(), { error: 'origin not allowed' });
      assert.equal(pair.headers.get('access-control-allow-origin'), null);
    }

    const usb = await postWirelessUsb(address, { origin: 'http://evil.example' });
    assert.equal(usb.status, 403);
    assert.deepEqual(await usb.json(), { error: 'origin not allowed' });
    assert.equal(usb.headers.get('access-control-allow-origin'), null);

    for (const contentType of ['application/json', 'text/plain']) {
      const auto = await fetch(`${address}/api/wireless/auto`, {
        method: 'POST',
        headers: { 'content-type': contentType, origin: 'http://evil.example' },
        body: '{}',
      });
      assert.equal(auto.status, 403);
      assert.deepEqual(await auto.json(), { error: 'origin not allowed' });
      assert.equal(auto.headers.get('access-control-allow-origin'), null);
    }
    assert.equal(connectionService.pairCalls.length, 0);
    assert.equal(connectionService.usbCalls, 0);
    assert.equal(connectionService.discoverCalls, 0);
  });
});

test('wireless: OPTIONS preflights advertise only the supported methods', async () => {
  await withBridge({}, async (address) => {
    for (const origin of [ALLOWED_ORIGIN, LOCALHOST_ORIGIN]) {
      for (const [path, methods] of [
        ['/api/wireless', 'GET, OPTIONS'],
        ['/api/wireless/pair', 'POST, OPTIONS'],
        ['/api/wireless/usb', 'POST, OPTIONS'],
        ['/api/wireless/auto', 'POST, OPTIONS'],
      ]) {
        const res = await fetch(`${address}${path}`, {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-headers': 'content-type' },
        });
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('access-control-allow-origin'), origin);
        assert.equal(res.headers.get('access-control-allow-methods'), methods);
        assert.equal(res.headers.get('access-control-allow-headers'), 'content-type');
        assert.equal(res.headers.get('access-control-max-age'), '600');
      }
    }
  });
});

test('health follows live adb serial and mode changes', async () => {
  let connection = { mode: 'usb', serial: 'USB-DYNAMIC', online: true };
  const dynamicAdb = {
    isOnline: async () => connection.online,
    keyEvent: async () => {},
    getMode: () => connection.mode,
    getSerial: () => connection.serial,
  };
  await withBridge({ adb: dynamicAdb }, async (address) => {
    const usb = await fetch(`${address}/health`);
    assert.deepEqual(await usb.json(), { ok: true, online: true, serial: 'USB-DYNAMIC', mode: 'usb' });

    connection = { mode: 'wifi', serial: WIRELESS_SERIAL, online: false };
    const wifi = await fetch(`${address}/health`);
    assert.deepEqual(await wifi.json(), { ok: true, online: false, serial: WIRELESS_SERIAL, mode: 'wifi' });
  });
});

test('health falls back independently when legacy adb getters are absent', async () => {
  const legacyAdb = { isOnline: async () => true, keyEvent: async () => {} };
  await withBridge({ adb: { ...legacyAdb, getSerial: () => 'USB-SERIAL-ONLY' } }, async (address) => {
    const res = await fetch(`${address}/health`);
    assert.deepEqual(await res.json(), { ok: true, online: true, serial: 'USB-SERIAL-ONLY', mode: 'usb' });
  });
  await withBridge({ adb: { ...legacyAdb, getMode: () => 'wifi' } }, async (address) => {
    const res = await fetch(`${address}/health`);
    assert.deepEqual(await res.json(), { ok: true, online: true, serial: DEFAULT_USB_SERIAL, mode: 'wifi' });
  });
});
