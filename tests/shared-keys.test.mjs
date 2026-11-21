import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY_CODES, STREAM_SIZE_LADDER, buildStreamOptions, isDegradedStream, isUsableContext, lockHint, negotiatedMaxDimension } from '../shared/keys.mjs';

test('key codes match android', () => {
  assert.deepEqual(KEY_CODES, {
    home: 3,
    back: 4,
    power: 26,
    volume_up: 24,
    volume_down: 25,
    overview: 187,
  });
});

test('stream options pin keyboard, a fixed max size and 30fps', () => {
  const o = buildStreamOptions({ deviceId: '2FD0221C09004177' });
  assert.equal(o.keyboard, true);
  // fitToScreen off + fixed maxSize: the device answers a viewport-derived
  // request with a frame capped at 512 (measured 248x512 on a 1152x2376
  // screen), which is visibly soft once scaled up.
  assert.equal(o.fitToScreen, false);
  assert.equal(o.maxSize, 1280);
  assert.equal(o.maxFps, 30);
  assert.equal(o.audio, true);
});

test('the size ladder runs best first and each step is requestable', () => {
  assert.deepEqual(STREAM_SIZE_LADDER, [1280, 1080, 720]);
  // The encoder's ceiling moves with device state, so the caller steps down
  // rather than pinning one size.
  assert.equal(buildStreamOptions({ maxSize: 1080 }).maxSize, 1080);
  assert.equal(buildStreamOptions({ maxSize: 720 }).maxSize, 720);
  assert.equal(buildStreamOptions().maxSize, STREAM_SIZE_LADDER[0]);
});

test('insecure lan origin is rejected', () => {
  assert.equal(isUsableContext('http:', '127.0.0.1'), true);
  assert.equal(isUsableContext('http:', 'localhost'), true);
  assert.equal(isUsableContext('http:', '192.168.3.50'), false);
  assert.equal(isUsableContext('https:', 'example.com'), true);
});

test('a grossly downscaled stream is detected as degraded', () => {
  assert.equal(negotiatedMaxDimension('620x1280'), 1280);
  assert.equal(negotiatedMaxDimension('1280x620'), 1280);
  assert.equal(negotiatedMaxDimension(''), 0);
  assert.equal(negotiatedMaxDimension(undefined), 0);
  assert.equal(negotiatedMaxDimension('garbage'), 0);

  // The measured failure: 1280 requested, 248x512 encoded.
  assert.equal(isDegradedStream('248x512', 1280), true);
  // An aspect-ratio-broken fallback (1024 requested, 300x150 encoded).
  assert.equal(isDegradedStream('300x150', 1024), true);
  // What the same request returns when it works, and a small legitimate clamp.
  assert.equal(isDegradedStream('620x1280', 1280), false);
  assert.equal(isDegradedStream('556x1152', 1280), false);
  // Unknown sizes are not treated as bad — there is nothing to compare.
  assert.equal(isDegradedStream(undefined, 1280), false);
  assert.equal(isDegradedStream('620x1280', 0), false);
});

test('locked device produces an explicit hint', () => {
  assert.equal(lockHint({ awake: true, locked: true }), 'Phone is locked — unlock it to see the screen');
  assert.equal(lockHint({ awake: false, locked: false }), 'Phone is asleep — waking it');
  assert.equal(lockHint({ awake: true, locked: false }), '');
});
