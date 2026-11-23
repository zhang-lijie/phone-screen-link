import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CHAT_CONFIG, createChatConfigStore } from '../server/chat-config.mjs';

const EXPECTED_DEFAULT = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: '',
  maxSteps: 100,
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
    maxSteps: 100,
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
  assert.equal(pub.maxSteps, 100);
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

test('chat config: save clamps integer maxSteps to 1..100 and drops non-integers', (t) => {
  const store = tempStore(t);
  assert.equal(store.save({ maxSteps: 0 }).maxSteps, 1);
  assert.equal(store.save({ maxSteps: -5 }).maxSteps, 1);
  assert.equal(store.save({ maxSteps: 100 }).maxSteps, 100);
  assert.equal(store.save({ maxSteps: 1 }).maxSteps, 1);
  assert.equal(store.save({ maxSteps: 32 }).maxSteps, 32);
  assert.equal(store.save({ maxSteps: 200 }).maxSteps, 100);
  assert.equal(store.save({ maxSteps: 5 }).maxSteps, 5);
  // Non-integers are dropped like any other type mismatch: the stored value stays.
  assert.equal(store.save({ maxSteps: 2.5 }).maxSteps, 5);
  assert.equal(store.save({ maxSteps: '9' }).maxSteps, 5);
  assert.equal(store.save({ maxSteps: NaN }).maxSteps, 5);
  assert.equal(store.save({ maxSteps: Infinity }).maxSteps, 5);
  assert.equal(store.load().maxSteps, 5);
});

test('chat config: save writes owner-only (0600) via temp-file rename', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-config-mode-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'chat.json');
  const store = createChatConfigStore({ file });

  store.save({ apiKey: 'sk-x' });
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600, 'config holds the API key: owner-only');
  }
  assert.equal(existsSync(`${file}.tmp`), false, 'temp file must be renamed away');
  assert.equal(store.load().apiKey, 'sk-x');

  // Replacing a pre-existing world-readable file must tighten it too.
  if (process.platform !== 'win32') {
    chmodSync(file, 0o644);
    store.save({ model: 'qwen3' });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(store.load().model, 'qwen3');
  }
});

test('chat config: load falls back to defaults for corrupt JSON', (t) => {
  const store = tempStore(t, '{not valid json');
  assert.deepEqual(store.load(), EXPECTED_DEFAULT);
});

test('chat config: load merges an old file with missing fields', (t) => {
  const store = tempStore(t, JSON.stringify({ model: 'legacy-model' }));
  assert.deepEqual(store.load(), { ...EXPECTED_DEFAULT, model: 'legacy-model' });
});
