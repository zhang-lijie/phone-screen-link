import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CHAT_CONFIG, createChatConfigStore } from '../server/chat-config.mjs';

const EXPECTED_DEFAULT = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: '',
  maxSteps: 8,
  screenshot: true,
  apiKey: '',
};

function tempStore(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'chat.json');
  if (contents !== undefined) writeFileSync(file, contents);
  return createChatConfigStore({ file });
}

test('chat config: defaults are returned on first load', (t) => {
  const store = tempStore(t);
  assert.deepEqual(DEFAULT_CHAT_CONFIG, EXPECTED_DEFAULT);
  assert.deepEqual(store.load(), EXPECTED_DEFAULT);
});

test('chat config: save persists patched fields and keeps unspecified defaults', (t) => {
  const store = tempStore(t);
  const saved = store.save({ model: 'qwen3', apiKey: 'sk-x' });

  assert.equal(saved.model, 'qwen3');
  assert.equal(Object.hasOwn(saved, 'apiKey'), false);
  assert.equal(saved.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes('sk-x'), false);
  assert.equal(store.load().model, 'qwen3');
  assert.equal(store.load().apiKey, 'sk-x');
  assert.deepEqual(store.load(), { ...EXPECTED_DEFAULT, model: 'qwen3', apiKey: 'sk-x' });
});

test('chat config: save filters unknown fields but accepts enabled', (t) => {
  const store = tempStore(t);
  store.save({ enabled: true, model: 'qwen3', injected: 'nope' });

  assert.deepEqual(store.load(), { ...EXPECTED_DEFAULT, enabled: true, model: 'qwen3' });
  assert.equal(Object.hasOwn(store.load(), 'injected'), false);
});

test('chat config: save({ enabled: true }) turns the agent on', (t) => {
  const store = tempStore(t);
  assert.equal(store.load().enabled, false);

  const saved = store.save({ enabled: true });
  assert.equal(store.load().enabled, true);
  assert.equal(saved.enabled, true);
});

test('chat config: publicConfig hides apiKey and reports hasApiKey', (t) => {
  const store = tempStore(t);
  const emptyPub = store.publicConfig();
  assert.equal(Object.hasOwn(emptyPub, 'apiKey'), false);
  assert.deepEqual(emptyPub, {
    enabled: false,
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    maxSteps: 8,
    screenshot: true,
    hasApiKey: false,
  });

  store.save({ model: 'qwen3', apiKey: 'sk-x' });
  const pub = store.publicConfig();

  assert.equal(Object.hasOwn(pub, 'apiKey'), false);
  assert.equal(pub.hasApiKey, true);
  assert.equal(pub.model, 'qwen3');
  assert.equal(pub.enabled, false);
  assert.equal(pub.baseUrl, EXPECTED_DEFAULT.baseUrl);
  assert.equal(pub.maxSteps, 8);
  assert.equal(pub.screenshot, true);
  assert.equal(JSON.stringify(pub).includes('sk-x'), false);
});

test('chat config: enabled is read from disk and can be turned back off', (t) => {
  const store = tempStore(t, JSON.stringify({ enabled: true, apiKey: 'sk-x' }));
  assert.equal(store.load().enabled, true);
  assert.equal(store.publicConfig().enabled, true);

  const saved = store.save({ enabled: false, model: 'qwen3' });
  assert.equal(store.load().enabled, false);
  assert.equal(store.load().model, 'qwen3');
  assert.equal(saved.enabled, false);
});

test('chat config: load falls back to defaults for corrupt JSON', (t) => {
  const store = tempStore(t, '{not valid json');
  assert.deepEqual(store.load(), EXPECTED_DEFAULT);
});

test('chat config: load merges an old file with missing fields', (t) => {
  const store = tempStore(t, JSON.stringify({ model: 'legacy-model' }));
  assert.deepEqual(store.load(), { ...EXPECTED_DEFAULT, model: 'legacy-model' });
});
