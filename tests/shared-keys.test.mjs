import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY_CODES, buildStreamOptions, isUsableContext } from '../shared/keys.mjs';

test('key codes match android', () => {
  assert.deepEqual(KEY_CODES, { home: 3, back: 4, power: 26 });
});

test('stream options pin keyboard, fit and 30fps', () => {
  const o = buildStreamOptions({ deviceId: '2FD0221C09004177' });
  assert.equal(o.keyboard, true);
  assert.equal(o.fitToScreen, true);
  assert.equal(o.maxFps, 30);
  assert.equal(o.audio, true);
});

test('insecure lan origin is rejected', () => {
  assert.equal(isUsableContext('http:', '127.0.0.1'), true);
  assert.equal(isUsableContext('http:', 'localhost'), true);
  assert.equal(isUsableContext('http:', '192.168.3.50'), false);
  assert.equal(isUsableContext('https:', 'example.com'), true);
});
