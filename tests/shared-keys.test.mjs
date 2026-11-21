import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BITRATE_CHOICES,
  DEFAULT_SETTINGS,
  ENGINE_TEXT_KEYS,
  FPS_CHOICES,
  KEY_CODES,
  LANGUAGE_CHOICES,
  MESSAGES,
  RESOLUTION_CHOICES,
  SETTINGS_STORAGE_KEY,
  STREAM_SIZE_LADDER,
  buildStreamOptions,
  effectiveLanguage,
  isDegradedStream,
  isUsableContext,
  loadSettings,
  lockHint,
  negotiatedMaxDimension,
  normalizeSettings,
  saveSettings,
  sizeLadder,
  translate,
} from '../shared/keys.mjs';

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
  assert.equal(o.deviceKind, 'phone');
});

test('the size ladder runs best first and a fixed resolution is requestable', () => {
  assert.deepEqual(STREAM_SIZE_LADDER, [1280, 1080, 720]);
  assert.deepEqual(RESOLUTION_CHOICES, ['auto', '1280', '1080', '720']);
  assert.deepEqual(FPS_CHOICES, [15, 30, 60]);
  assert.deepEqual(BITRATE_CHOICES, [2_000_000, 4_000_000, 8_000_000, 16_000_000]);

  assert.deepEqual(sizeLadder({ resolution: 'auto' }), [1280, 1080, 720]);
  assert.deepEqual(sizeLadder({ resolution: '1080' }), [1080]);
  // A fixed resolution is used as-is: the user's explicit choice wins.
  assert.equal(buildStreamOptions({ resolution: '720' }).maxSize, 720);
  // The retry loop's per-attempt override does not reset other settings.
  const o = buildStreamOptions({ resolution: 'auto', maxFps: 60, audio: false, bitrate: 4_000_000 }, 1080);
  assert.equal(o.maxSize, 1080);
  assert.equal(o.maxFps, 60);
  assert.equal(o.audio, false);
  assert.equal(o.bitrate, 4_000_000);
});

test('settings are normalized before reaching the engine', () => {
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ resolution: 'bogus', maxFps: 999, bitrate: 'x', audio: 'yes', language: 'fr' }), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ resolution: '1080', maxFps: 60, bitrate: 16_000_000, audio: false, language: 'zh' }), {
    resolution: '1080', maxFps: 60, bitrate: 16_000_000, audio: false, language: 'zh',
  });
  // String values from a <select> are accepted after Number conversion.
  assert.equal(normalizeSettings({ maxFps: '30', bitrate: '4000000' }).maxFps, 30);
  assert.equal(normalizeSettings({ bitrate: '4000000' }).bitrate, 4_000_000);
});

test('settings persist in localStorage and bad data falls back to defaults', () => {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS);

  const chosen = saveSettings(storage, { resolution: '720', maxFps: 15, bitrate: 2_000_000, audio: false, language: 'en' });
  assert.deepEqual(chosen, { resolution: '720', maxFps: 15, bitrate: 2_000_000, audio: false, language: 'en' });
  assert.deepEqual(loadSettings(storage), chosen);
  assert.ok(data.has(SETTINGS_STORAGE_KEY));

  data.set(SETTINGS_STORAGE_KEY, 'not json');
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS);
  data.set(SETTINGS_STORAGE_KEY, JSON.stringify({ resolution: 'evil', maxFps: 999 }));
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS);
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

test('locked device produces an explicit hint in both languages', () => {
  assert.equal(lockHint({ awake: true, locked: true }), 'Phone is locked — unlock it to see the screen');
  assert.equal(lockHint({ awake: false, locked: false }), 'Phone is asleep — waking it');
  assert.equal(lockHint({ awake: true, locked: false }), '');
  assert.equal(lockHint({ awake: true, locked: true }, 'zh'), '手机已锁定 — 请解锁后查看屏幕');
  assert.equal(lockHint({ awake: false, locked: false }, 'zh'), '手机已休眠 — 正在唤醒');
});

test('language choices resolve from the setting or the browser', () => {
  assert.deepEqual(LANGUAGE_CHOICES, ['auto', 'zh', 'en']);
  assert.equal(effectiveLanguage({ language: 'zh' }, 'en-US'), 'zh');
  assert.equal(effectiveLanguage({ language: 'en' }, 'zh-CN'), 'en');
  assert.equal(effectiveLanguage({ language: 'auto' }, 'zh-CN'), 'zh');
  assert.equal(effectiveLanguage({ language: 'auto' }, 'zh'), 'zh');
  assert.equal(effectiveLanguage({ language: 'auto' }, 'en-US'), 'en');
  // Old saved settings without a language field fall back to auto.
  assert.equal(effectiveLanguage({}, 'zh-TW'), 'zh');
});

test('translations are complete and interpolate variables', () => {
  assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.zh).sort());
  for (const key of Object.keys(MESSAGES.en)) {
    assert.ok(MESSAGES.en[key].length > 0, `${key} has an English value`);
    assert.ok(MESSAGES.zh[key].length > 0, `${key} has a Chinese value`);
  }
  assert.equal(translate('en', 'status.keySent', { key: 'HOME' }), 'HOME key sent');
  assert.equal(translate('zh', 'status.keySent', { key: '主页' }), '已发送 主页 键');
  assert.equal(translate('zh', 'status.connected', { resolution: ' — 522x1080' }), '已连接 — 522x1080');
  // Unknown keys and languages degrade to the key name / English, never crash.
  assert.equal(translate('en', 'not.a.key'), 'not.a.key');
  assert.equal(translate('fr', 'status.connecting'), MESSAGES.en['status.connecting']);
});

test('every engine-owned English string has a translation in both languages', () => {
  for (const [source, key] of Object.entries(ENGINE_TEXT_KEYS)) {
    assert.ok(source.length > 0);
    assert.ok(MESSAGES.en[key], `${source} -> en.${key}`);
    assert.ok(MESSAGES.zh[key], `${source} -> zh.${key}`);
    assert.notEqual(MESSAGES.zh[key], source, `${source} must not stay English in Chinese`);
  }
  assert.equal(ENGINE_TEXT_KEYS['Take screenshot'], 'engine.screenshot');
  assert.equal(ENGINE_TEXT_KEYS['Device clipboard ready —'], 'engine.clipboardReady');
  assert.equal(ENGINE_TEXT_KEYS['device is locked — unlock it to see the screen'], 'engine.locked');
  assert.equal(translate('zh', ENGINE_TEXT_KEYS['Refresh stream']), '刷新画面');
});
