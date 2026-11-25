import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BITRATE_CHOICES,
  CHAT_DOCK_KEY,
  CHAT_SPLIT_KEY,
  CHAT_POSITION_KEY,
  DEFAULT_SETTINGS,
  ENGINE_TEXT_KEYS,
  FPS_CHOICES,
  KEY_CODES,
  LANGUAGE_CHOICES,
  MESSAGES,
  NAV_BUTTON_MODES,
  RAIL_SCALES,
  RESOLUTION_CHOICES,
  WHEEL_SCALE_CHOICES,
  DEFAULT_WHEEL_STEPS,
  SETTINGS_STORAGE_KEY,
  STREAM_SIZE_LADDER,
  STATS_FONT_SCALES,
  STATUS_SCALES,
  UI_FONT_SCALES,
  buildStreamOptions,
  canDock,
  CHAT_INPUT_MODE_IDS,
  chatInputModeTargets,
  clampDockStreamWidth,
  clampPanelPosition,
  effectiveLanguage,
  isDegradedStream,
  isUsableContext,
  loadSettings,
  lockHint,
  negotiatedMaxDimension,
  normalizeSettings,
  readChatDock,
  readChatSplitRatio,
  readChatPosition,
  saveSettings,
  shouldCenterDock,
  writeChatDock,
  writeChatSplitRatio,
  writeChatPosition,
  sizeLadder,
  translate,
  translateStatLine,
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

test('wheel steps are a small validated set, defaulting to 2', () => {
  assert.deepEqual(WHEEL_SCALE_CHOICES, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(DEFAULT_WHEEL_STEPS, 2);
  assert.equal(DEFAULT_SETTINGS.wheelSteps, 2);
  assert.equal(DEFAULT_SETTINGS.navButtonMode, 'icon', 'default nav shows icons only');
  assert.equal(normalizeSettings().wheelSteps, 2);
  assert.equal(normalizeSettings({ wheelSteps: 1 }).wheelSteps, 1);
  assert.equal(normalizeSettings({ wheelSteps: 5 }).wheelSteps, 5);
  assert.equal(normalizeSettings({ wheelSteps: 10 }).wheelSteps, 10);
  assert.equal(normalizeSettings({ volume: 50 }).volume, 50);
  assert.equal(normalizeSettings({ volume: 200 }).volume, 100);
  assert.equal(normalizeSettings({ volume: -5 }).volume, 0);
  assert.equal(normalizeSettings().volume, 100);
  assert.equal(normalizeSettings({ wheelSteps: 11 }).wheelSteps, 2);
  assert.equal(normalizeSettings({ wheelSteps: 0 }).wheelSteps, 2);
  assert.equal(normalizeSettings({ wheelSteps: '3' }).wheelSteps, 3);
});

test('settings are normalized before reaching the engine', () => {
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ resolution: 'bogus', maxFps: 999, bitrate: 'x', audio: 'yes', language: 'fr' }), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ resolution: '1080', maxFps: 60, bitrate: 16_000_000, audio: false, language: 'zh' }), {
    ...DEFAULT_SETTINGS, resolution: '1080', maxFps: 60, bitrate: 16_000_000, audio: false, language: 'zh',
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

  const chosen = saveSettings(storage, { resolution: '720', maxFps: 15, bitrate: 2_000_000, audio: false, language: 'en', wheelSteps: 5 });
  assert.deepEqual(chosen, {
    ...DEFAULT_SETTINGS, resolution: '720', maxFps: 15, bitrate: 2_000_000, audio: false, language: 'en', wheelSteps: 5,
  });
  assert.deepEqual(loadSettings(storage), chosen);
  assert.ok(data.has(SETTINGS_STORAGE_KEY));

  data.set(SETTINGS_STORAGE_KEY, 'not json');
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS);
  data.set(SETTINGS_STORAGE_KEY, JSON.stringify({ resolution: 'evil', maxFps: 999 }));
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS);
});

test('font size and color settings are validated', () => {
  assert.deepEqual(UI_FONT_SCALES, [0.85, 1, 1.2]);
  assert.deepEqual(STATS_FONT_SCALES, [0.75, 1, 1.4]);
  assert.deepEqual(RAIL_SCALES, [0.8, 1, 1.25]);
  assert.deepEqual(STATUS_SCALES, [0.8, 1, 1.25]);
  assert.deepEqual(NAV_BUTTON_MODES, ['icon', 'text', 'both']);

  const chosen = normalizeSettings({
    uiFontSize: '1.2', uiFontColor: '#ff9900',
    statsFontSize: '0.75', statsFontColor: '#00ffcc',
    railScale: '1.25', statusScale: '0.8', navButtonMode: 'text',
  });
  assert.equal(chosen.uiFontSize, 1.2);
  assert.equal(chosen.uiFontColor, '#ff9900');
  assert.equal(chosen.statsFontSize, 0.75);
  assert.equal(chosen.statsFontColor, '#00ffcc');
  assert.equal(chosen.railScale, 1.25);
  assert.equal(chosen.statusScale, 0.8);
  assert.equal(chosen.navButtonMode, 'text');

  // Out-of-range sizes and malformed colors fall back to defaults.
  const bad = normalizeSettings({ uiFontSize: 99, uiFontColor: 'red', statsFontSize: -1, statsFontColor: '#fff', railScale: 2, statusScale: 'x', navButtonMode: 'weird' });
  assert.equal(bad.uiFontSize, DEFAULT_SETTINGS.uiFontSize);
  assert.equal(bad.uiFontColor, DEFAULT_SETTINGS.uiFontColor);
  assert.equal(bad.statsFontSize, DEFAULT_SETTINGS.statsFontSize);
  assert.equal(bad.statsFontColor, DEFAULT_SETTINGS.statsFontColor);
  assert.equal(bad.railScale, DEFAULT_SETTINGS.railScale);
  assert.equal(bad.statusScale, DEFAULT_SETTINGS.statusScale);
  assert.equal(bad.navButtonMode, DEFAULT_SETTINGS.navButtonMode);
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

test('chat strings exist in both languages and interpolate', () => {
  // The chat feature owns its own key namespace; every chat.* key must be
  // shipped in both languages (the parity test enforces the sets, this one
  // enforces that the namespace actually exists and names the required UI
  // strings: button, title, placeholder, status, errors, settings labels).
  const chatKeys = Object.keys(MESSAGES.en).filter((key) => key.startsWith('chat.'));
  assert.ok(chatKeys.length >= 20, 'the chat feature ships its own strings');
  for (const key of chatKeys) {
    assert.ok(MESSAGES.zh[key], `${key} has a Chinese value`);
  }
  const required = [
    'chat.button', 'chat.title', 'chat.placeholder', 'chat.send', 'chat.clear',
    'chat.running', 'chat.error.network', 'chat.error.request', 'chat.error.disabled',
    'chat.settings.group', 'chat.settings.enabled', 'chat.settings.baseUrl',
    'chat.settings.model', 'chat.settings.apiKey', 'chat.settings.screenshot',
    'chat.settings.maxSteps', 'chat.settings.save',
  ];
  for (const key of required) {
    assert.ok(MESSAGES.en[key] && MESSAGES.zh[key], `${key} is shipped in both languages`);
  }
  assert.equal(translate('zh', 'chat.error.request', { status: 503, error: 'boom' }), '请求失败（503）— boom');
  assert.equal(translate('en', 'chat.settings.saveFailed', { error: 'nope' }), 'Save failed — nope');
});

test('canvas-drawn quality stats are translated without touching their values', () => {
  assert.equal(translateStatLine('Resolution:  522x1080', 'en'), 'Resolution:  522x1080');
  assert.equal(translateStatLine('Resolution:  522x1080', 'zh'), '分辨率:  522x1080');
  assert.equal(translateStatLine('Video codec: H265', 'zh'), '视频编码: H265');
  assert.equal(translateStatLine('Encoder:     c2.android.hevc.encoder', 'zh'), '编码器:     c2.android.hevc.encoder');
  assert.equal(translateStatLine('Bitrate:     8.0 MiB/s', 'zh'), '码率:     8.0 MiB/s');
  assert.equal(translateStatLine('Input bytes:  1.2 MiB (avg: 3.4 MiB/s)', 'zh'), '输入字节:  1.2 MiB（平均: 3.4 MiB/s）');
  assert.equal(translateStatLine('Input   FPS:  30 (avg: 29.8)', 'zh'), '输入帧率:  30（平均: 29.8）');
  assert.equal(translateStatLine('Dropped FPS:   0 (avg:  0.0)', 'zh'), '丢帧率:   0（平均:  0.0）');
  assert.equal(translateStatLine('Decoded FPS:  30 (avg: 29.9)', 'zh'), '解码帧率:  30（平均: 29.9）');
  assert.equal(translateStatLine('Not supported', 'zh'), '不支持');
  assert.equal(translateStatLine('something else', 'zh'), 'something else');
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

test('chat drag: clampPanelPosition keeps part of the panel on screen', () => {
  // 340x440 panel in a 1280x800 viewport with a 40px visible margin.
  assert.deepEqual(clampPanelPosition(100, 120, 340, 440, 1280, 800), { x: 100, y: 120 });
  // The drag handle (head) must remain reachable, so y never goes above 0.
  assert.deepEqual(clampPanelPosition(-1000, -1000, 340, 440, 1280, 800), { x: -300, y: 0 });
  assert.deepEqual(clampPanelPosition(9999, 9999, 340, 440, 1280, 800), { x: 1240, y: 760 });
});

test('chat drag: position storage accepts finite numbers, rejects garbage', () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
  assert.equal(readChatPosition(storage), null);
  writeChatPosition(storage, { x: 12, y: 34 });
  assert.deepEqual(readChatPosition(storage), { x: 12, y: 34 });
  assert.ok(store.has(CHAT_POSITION_KEY));
  store.set(CHAT_POSITION_KEY, '{"x":"bad","y":34}');
  assert.equal(readChatPosition(storage), null);
  store.set(CHAT_POSITION_KEY, 'not json');
  assert.equal(readChatPosition(storage), null);
});

test('chat dock: width gate, persistence and centering rule', () => {
  assert.equal(canDock(719), false);
  assert.equal(canDock(720), true);
  assert.equal(canDock(1280), true);

  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
  assert.equal(readChatDock(storage), false);
  writeChatDock(storage, true);
  assert.equal(readChatDock(storage), true);
  assert.ok(store.has(CHAT_DOCK_KEY));
  writeChatDock(storage, false);
  assert.equal(readChatDock(storage), false);
  store.set(CHAT_DOCK_KEY, 'garbage');
  assert.equal(readChatDock(storage), false);

  assert.equal(shouldCenterDock(300, 500), true, 'wider chat centers the pair');
  assert.equal(shouldCenterDock(500, 300), false, 'narrower chat stays left');
  assert.equal(shouldCenterDock(400, 400), false);
});

test('chat dock splitter: clamp stream width to 400 min and chat 240 min', () => {
  assert.equal(clampDockStreamWidth(399, 1200), 400, 'below min lifts to 400');
  assert.equal(clampDockStreamWidth(400, 1200), 400, 'exact min is preserved');
  assert.equal(clampDockStreamWidth(900, 1200), 900, 'within range untouched');
  assert.equal(clampDockStreamWidth(2000, 1200), 960, 'above max leaves 240 for chat');
  assert.equal(clampDockStreamWidth(100, 600), 400, 'too-narrow stage still keeps 400');
  assert.ok(clampDockStreamWidth(700, 1200) >= 400);
});

test('chat dock splitter: ratio persistence validates 0..1', () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
  assert.equal(readChatSplitRatio(storage), null);
  writeChatSplitRatio(storage, 0.42);
  assert.equal(readChatSplitRatio(storage), 0.42);
  assert.ok(store.has(CHAT_SPLIT_KEY));
  writeChatSplitRatio(storage, 2);
  assert.equal(readChatSplitRatio(storage), null, 'out-of-range rejected');
  store.set(CHAT_SPLIT_KEY, 'not a number');
  assert.equal(readChatSplitRatio(storage), null);
});

test('chat input mode targets: chat open unchecks all, close restores defaults', () => {
  assert.deepEqual(chatInputModeTargets(true), { keyboard: false, uhid: false, touch: false });
  assert.deepEqual(chatInputModeTargets(false), { keyboard: true, uhid: false, touch: true });
  // ids must be language-independent prefixes used to find engine checkboxes
  assert.deepEqual(CHAT_INPUT_MODE_IDS, {
    keyboard: 'input_capture_keyboard_',
    uhid: 'input_uhid_input_',
    touch: 'input_input_mode_',
  });
});
