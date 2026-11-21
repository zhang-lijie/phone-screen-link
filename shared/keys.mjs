export const KEY_CODES = {
  home: 3,
  back: 4,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  overview: 187,
};

// The device id is passed to startStream separately; codec stays omitted so
// the engine auto-selects. A fresh object is returned on every call.
//
// fitToScreen is off on purpose. With it on, the engine derives the requested
// size from the browser viewport and asks the device for that — but the
// device's HEVC encoder rejects some requests and silently falls back to a
// frame capped at 512 (measured on the Mate 40 Pro, screen 1152x2376: 248x512,
// i.e. 4.6x downscaled and visibly soft once the browser scales it up).
//
// The ceiling moves with device state: 1280 was accepted for a while and later
// rejected every time, while 1080 was accepted in both states. So the caller
// walks STREAM_SIZE_LADDER from best to safest instead of pinning one size.
// CSS still fits the picture to the window, because the engine's canvas layers
// are capped by the cell.
export const STREAM_SIZE_LADDER = [1280, 1080, 720];

// Stream settings exposed by the gear button in the right-hand rail. Values
// are kept as strings/numbers from the form; normalizeSettings is the single
// gate between untrusted form/localStorage data and the engine options.
export const RESOLUTION_CHOICES = ['auto', ...STREAM_SIZE_LADDER.map(String)];
export const FPS_CHOICES = [15, 30, 60];
export const BITRATE_CHOICES = [2_000_000, 4_000_000, 8_000_000, 16_000_000];
export const LANGUAGE_CHOICES = ['auto', 'zh', 'en'];

// All user-visible strings live here so the UI can switch language without a
// reload. "auto" follows the browser language (zh* -> Chinese, else English).
export const MESSAGES = {
  en: {
    'app.title': 'Phone Screen Link',
    'nav.controls': 'Phone controls',
    'nav.screen': 'Phone screen',
    'key.home': 'HOME',
    'key.back': 'BACK',
    'key.overview': 'APPS',
    'key.volume_down': 'VOL−',
    'key.volume_up': 'VOL+',
    'key.power': 'POWER',
    'tool.shot': 'SHOT',
    'tool.keys': 'KEYS',
    'tool.mouse': 'MOUSE',
    'tool.stats': 'STATS',
    'tool.dpad': 'DPAD',
    'tool.reload': 'RELOAD',
    'tool.copy': 'COPY',
    'tool.paste': 'PASTE',
    'tool.settings': 'SET',
    'settings.title': 'Stream settings',
    'settings.close': 'Close settings',
    'settings.resolution': 'Resolution',
    'settings.resAuto': 'Auto (recommended)',
    'settings.res1280': '1280 — sharpest',
    'settings.res1080': '1080 — reliable',
    'settings.res720': '720 — lightest',
    'settings.fps': 'Frame rate',
    'settings.fps15': '15 fps',
    'settings.fps30': '30 fps',
    'settings.fps60': '60 fps',
    'settings.bitrate': 'Bitrate',
    'settings.br2': '2 Mbps',
    'settings.br4': '4 Mbps',
    'settings.br8': '8 Mbps',
    'settings.br16': '16 Mbps',
    'settings.audio': 'Audio',
    'settings.language': 'Language',
    'settings.langAuto': 'Follow browser',
    'settings.langZh': '中文',
    'settings.langEn': 'English',
    'settings.note': 'Auto tries 1280 first and steps down if the phone rejects it. Applying restarts the picture.',
    'settings.reset': 'Reset',
    'settings.apply': 'Apply & restart',
    'status.connecting': 'Connecting…',
    'status.connectPhone': 'Connecting to phone…',
    'status.connected': 'Connected{resolution}',
    'status.lowRes': ' (low resolution — press RELOAD)',
    'status.retrying': 'Stream came back at {resolution} — retrying…',
    'status.disconnected': 'Disconnected{reason}',
    'status.error': 'Stream error — {error}',
    'status.keySent': '{key} key sent',
    'status.keyFailed': '{key} key failed ({code}){detail}',
    'status.offline': 'Phone is offline — check the USB connection',
    'status.bridgeDown': 'Control bridge unavailable — {error}',
    'status.engineDown': 'Engine unavailable — is the service running?',
    'status.engineDownError': 'Engine unavailable — {error}',
    'status.insecure': 'Insecure origin — open http://127.0.0.1:8000/ (or https) so the browser can decode the stream.',
    'status.applying': 'Applying settings…',
    'lock.locked': 'Phone is locked — unlock it to see the screen',
    'lock.asleep': 'Phone is asleep — waking it',
  },
  zh: {
    'app.title': '手机投屏联动',
    'nav.controls': '手机控制',
    'nav.screen': '手机画面',
    'key.home': '主页',
    'key.back': '返回',
    'key.overview': '多任务',
    'key.volume_down': '音量−',
    'key.volume_up': '音量+',
    'key.power': '电源',
    'tool.shot': '截图',
    'tool.keys': '键盘',
    'tool.mouse': '鼠标',
    'tool.stats': '统计',
    'tool.dpad': '触控',
    'tool.reload': '刷新',
    'tool.copy': '复制',
    'tool.paste': '粘贴',
    'tool.settings': '设置',
    'settings.title': '视频设置',
    'settings.close': '关闭设置',
    'settings.resolution': '分辨率',
    'settings.resAuto': '自动（推荐）',
    'settings.res1280': '1280 — 最清晰',
    'settings.res1080': '1080 — 稳定',
    'settings.res720': '720 — 流畅',
    'settings.fps': '帧率',
    'settings.fps15': '15 帧/秒',
    'settings.fps30': '30 帧/秒',
    'settings.fps60': '60 帧/秒',
    'settings.bitrate': '码率',
    'settings.br2': '2 Mbps',
    'settings.br4': '4 Mbps',
    'settings.br8': '8 Mbps',
    'settings.br16': '16 Mbps',
    'settings.audio': '音频',
    'settings.language': '显示语言',
    'settings.langAuto': '跟随浏览器',
    'settings.langZh': '中文',
    'settings.langEn': 'English',
    'settings.note': '自动模式先尝试 1280，被手机拒绝时会自动降档。应用设置会重启画面。',
    'settings.reset': '恢复默认',
    'settings.apply': '应用并重启',
    'status.connecting': '正在连接…',
    'status.connectPhone': '正在连接手机…',
    'status.connected': '已连接{resolution}',
    'status.lowRes': '（分辨率过低 — 请按 RELOAD）',
    'status.retrying': '画面协商为 {resolution} — 正在重试…',
    'status.disconnected': '已断开{reason}',
    'status.error': '视频流错误 — {error}',
    'status.keySent': '已发送 {key} 键',
    'status.keyFailed': '{key} 键发送失败（{code}）{detail}',
    'status.offline': '手机离线 — 请检查 USB 连接',
    'status.bridgeDown': '控制桥不可用 — {error}',
    'status.engineDown': '引擎不可用 — 服务是否已启动？',
    'status.engineDownError': '引擎不可用 — {error}',
    'status.insecure': '不安全来源 — 请用 http://127.0.0.1:8000/（或 https）打开，浏览器才能解码视频。',
    'status.applying': '正在应用设置…',
    'lock.locked': '手机已锁定 — 请解锁后查看屏幕',
    'lock.asleep': '手机已休眠 — 正在唤醒',
  },
};

export function translate(lang, key, vars = {}) {
  const template = (MESSAGES[lang] ?? MESSAGES.en)[key] ?? MESSAGES.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

export function effectiveLanguage(settings, browserLanguage = '') {
  const s = normalizeSettings(settings);
  if (s.language !== 'auto') return s.language;
  return /^zh\b/i.test(browserLanguage) ? 'zh' : 'en';
}

export const DEFAULT_SETTINGS = {
  resolution: 'auto',
  maxFps: 30,
  bitrate: 8_000_000,
  audio: true,
  language: 'auto',
};
export const SETTINGS_STORAGE_KEY = 'phone-link-settings';

function pick(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

export function normalizeSettings(raw = {}) {
  return {
    resolution: pick(raw?.resolution, RESOLUTION_CHOICES, DEFAULT_SETTINGS.resolution),
    maxFps: pick(Number(raw?.maxFps), FPS_CHOICES, DEFAULT_SETTINGS.maxFps),
    bitrate: pick(Number(raw?.bitrate), BITRATE_CHOICES, DEFAULT_SETTINGS.bitrate),
    audio: typeof raw?.audio === 'boolean' ? raw.audio : DEFAULT_SETTINGS.audio,
    language: pick(raw?.language, LANGUAGE_CHOICES, DEFAULT_SETTINGS.language),
  };
}

export function loadSettings(storage) {
  try {
    return normalizeSettings(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)));
  } catch {
    return normalizeSettings();
  }
}

export function saveSettings(storage, settings) {
  const normalized = normalizeSettings(settings);
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Private browsing or a full quota: the current session still uses them.
  }
  return normalized;
}

// "auto" walks the measured ladder; a fixed resolution is used as-is, so the
// user's explicit choice is not silently replaced.
export function sizeLadder(settings) {
  const s = normalizeSettings(settings);
  return s.resolution === 'auto' ? [...STREAM_SIZE_LADDER] : [Number(s.resolution)];
}

// maxSizeOverride is used by the retry loop; it must never bypass the other
// settings (fps, bitrate, audio) the user chose.
export function buildStreamOptions(raw = {}, maxSizeOverride) {
  const s = normalizeSettings(raw);
  const maxSize = maxSizeOverride
    ?? (s.resolution === 'auto' ? STREAM_SIZE_LADDER[0] : Number(s.resolution));
  return {
    keyboard: true,
    fitToScreen: false,
    maxSize,
    maxFps: s.maxFps,
    bitrate: s.bitrate,
    audio: s.audio,
    // Phone/tablet starts the engine in Touch mode. That makes the wheel
    // produce a real ScrollControlMessage (a finger swipe) instead of DPAD
    // key taps, and makes clicks behave like touches on the phone screen.
    deviceKind: 'phone',
  };
}

// The device's HEVC encoder intermittently rejects the requested size and
// silently falls back to a much smaller frame: measured on the Mate 40 Pro, a
// 1280 request came back as 248x512 (4.6x downscaled) with
// `IllegalArgumentException` in the server log, while the very same request
// succeeds on the next session. A stream that is this far below what we asked
// for is therefore worth restarting rather than showing.
const DEGRADED_RATIO = 0.6;

// "620x1280" -> 1280. Anything unparseable reports 0, which callers treat as
// "unknown", not "bad".
export function negotiatedMaxDimension(resolution) {
  const match = /^(\d+)\s*x\s*(\d+)$/.exec(resolution ?? '');
  return match ? Math.max(Number(match[1]), Number(match[2])) : 0;
}

// True only for a gross fallback. The device may legitimately clamp a request
// slightly (alignment, encoder limits), and that is still sharp, so the
// threshold is well below a normal clamp.
export function isDegradedStream(resolution, requestedMax) {
  const actual = negotiatedMaxDimension(resolution);
  return actual > 0 && requestedMax > 0 && actual < requestedMax * DEGRADED_RATIO;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// WebCodecs needs a secure context; plain http is only usable on loopback.
export function isUsableContext(protocol, hostname) {
  if (protocol === 'https:') return true;
  return protocol === 'http:' && LOOPBACK_HOSTS.has(hostname);
}

// A locked keyguard hands scrcpy a black surface, so explain that instead of
// letting a blank canvas look like a broken stream. Locked takes priority over
// asleep: a locked screen is dark for the keyguard, not only because it slept.
export function lockHint({ locked, awake } = {}, lang = 'en') {
  if (locked) return translate(lang, 'lock.locked');
  if (awake === false) return translate(lang, 'lock.asleep');
  return '';
}
