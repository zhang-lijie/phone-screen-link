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
export const UI_FONT_SCALES = [0.85, 1, 1.2];
export const STATS_FONT_SCALES = [0.75, 1, 1.4];
export const RAIL_SCALES = [0.8, 1, 1.25];
export const STATUS_SCALES = [0.8, 1, 1.25];
export const NAV_BUTTON_MODES = ['icon', 'text', 'both'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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
    'settings.uiFontSize': 'UI font size',
    'settings.statsFontSize': 'Stats font size',
    'settings.uiFontColor': 'UI text color',
    'settings.statsFontColor': 'Stats text color',
    'settings.railScale': 'Nav bar max size',
    'settings.statusScale': 'Status bar max size',
    'settings.wheelSteps': 'Wheel scroll multiplier',
    'settings.volume': 'Browser volume',
    'settings.autoResizeWindow': 'Resize window on orientation change',
    'status.windowResizeUnsupported': 'This tab cannot resize windows — use the fullscreen button at the top right',
    'fullscreen.browserEnter': 'Browser fullscreen',
    'fullscreen.browserExit': 'Exit browser full',
    'status.fullscreenFailed': 'Fullscreen was blocked by the browser',
    'settings.wheel1': '1x',
    'settings.wheel2': '2x',
    'settings.wheel3': '3x',
    'settings.wheel4': '4x',
    'settings.wheel5': '5x',
    'settings.wheel6': '6x',
    'settings.wheel7': '7x',
    'settings.wheel8': '8x',
    'settings.wheel9': '9x',
    'settings.wheel10': '10x',
    'settings.groupStream': 'Stream',
    'settings.groupControl': 'Control',
    'settings.groupDisplay': 'Display',
    'settings.groupLanguage': 'Language',
    'settings.navButtonMode': 'Nav button display',
    'settings.navIcon': 'Icon',
    'settings.navText': 'Text',
    'settings.navBoth': 'Icon & text',
    'settings.fontSmall': 'Small',
    'settings.fontNormal': 'Default',
    'settings.fontLarge': 'Large',
    'fullscreen.enter': 'Window fullscreen',
    'fullscreen.exit': 'Exit window fullscreen',
    'settings.note': 'Auto tries 1280 first and steps down if the phone rejects it. Applying restarts the picture.',
    'settings.reset': 'Reset',
    'settings.apply': 'Apply & restart',
    // Chat feature: floating button, panel and the settings group. The
    // config itself lives on the backend; these are display strings only.
    'chat.button': 'Chat assistant',
    'chat.title': 'Chat assistant',
    'chat.close': 'Close chat',
    'chat.placeholder': 'Ask something, e.g. "go to the home screen"',
    'chat.send': 'Send',
    'chat.clear': 'Clear chat',
    'chat.empty': 'Send a message to control the phone.',
    'chat.running': 'Working…',
    'chat.error.network': 'Cannot reach the chat service — {error}',
    'chat.error.request': 'Request failed ({status}) — {error}',
    'chat.error.disabled': 'Chat is disabled or the model name is empty — set it in the chat settings.',
    'chat.error.unavailable': 'Chat service unavailable — is the control bridge running?',
    'chat.settings.group': 'Chat',
    'chat.settings.enabled': 'Enable chat',
    'chat.settings.baseUrl': 'Model base URL',
    'chat.settings.model': 'Model name',
    'chat.settings.apiKey': 'API Key',
    'chat.settings.apiKeyHint': 'Optional',
    'chat.settings.apiKeySet': 'Saved — leave blank to keep',
    'chat.settings.screenshot': 'Send screenshots to the model',
    'chat.settings.maxSteps': 'Max steps per request',
    'chat.settings.note': 'Chat settings are stored by the local backend and the API Key never travels back to the page. An empty model name disables chat. Saving does not restart the stream.',
    'chat.settings.save': 'Save chat settings',
    'chat.settings.saved': 'Chat settings saved',
    'chat.settings.saveFailed': 'Save failed — {error}',
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
    // Strings owned by the engine's DOM (toolbox tooltips and notices).
    'engine.power': 'Power',
    'engine.volumeUp': 'Volume up',
    'engine.volumeDown': 'Volume down',
    'engine.back': 'Back',
    'engine.home': 'Home',
    'engine.overview': 'Overview',
    'engine.screenshot': 'Take screenshot',
    'engine.keyboard': 'Capture keyboard',
    'engine.uhid': 'UHID Input (keyboard + mouse)',
    'engine.stats': 'Display quality stats',
    'engine.dpad': 'D-pad mode (click for Touch mode)',
    'engine.touch': 'Touch mode (click for D-pad mode)',
    'engine.reload': 'Refresh stream',
    'engine.copy': 'copy device selection to host clipboard',
    'engine.paste': 'push host clipboard to device',
    'engine.dismiss': 'dismiss',
    'engine.clipboardReady': 'Device clipboard ready —',
    'engine.clickToCopy': 'click to copy',
    'engine.locked': 'device is locked — unlock it to see the screen',
    'engine.sketch': 'Created with Sketch.',
    // Quality stats are drawn directly onto the touch canvas with fillText.
    'stat.resolution': 'Resolution:',
    'stat.videoCodec': 'Video codec:',
    'stat.encoder': 'Encoder:',
    'stat.bitrate': 'Bitrate:',
    'stat.inputBytes': 'Input bytes:',
    'stat.inputFps': 'Input   FPS:',
    'stat.droppedFps': 'Dropped FPS:',
    'stat.decodedFps': 'Decoded FPS:',
    'stat.notSupported': 'Not supported',
    'stat.avg': 'avg:',
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
    'settings.uiFontSize': '界面字体大小',
    'settings.statsFontSize': '统计字体大小',
    'settings.uiFontColor': '界面文字颜色',
    'settings.statsFontColor': '统计文字颜色',
    'settings.railScale': '导航条最大尺寸',
    'settings.statusScale': '状态条最大尺寸',
    'settings.wheelSteps': '滚轮滚动倍率',
    'settings.volume': '浏览器播放音量',
    'settings.autoResizeWindow': '画面方向变化时调整窗口',
    'status.windowResizeUnsupported': '当前标签页无法调整窗口大小 — 请使用右上角的全屏按钮',
    'fullscreen.browserEnter': '浏览器全屏',
    'fullscreen.browserExit': '退出浏览器全屏',
    'status.fullscreenFailed': '浏览器拒绝了全屏请求',
    'settings.wheel1': '1×',
    'settings.wheel2': '2×',
    'settings.wheel3': '3×',
    'settings.wheel4': '4×',
    'settings.wheel5': '5×',
    'settings.wheel6': '6×',
    'settings.wheel7': '7×',
    'settings.wheel8': '8×',
    'settings.wheel9': '9×',
    'settings.wheel10': '10×',
    'settings.groupStream': '投屏设置',
    'settings.groupControl': '控制设置',
    'settings.groupDisplay': '显示设置',
    'settings.groupLanguage': '语言设置',
    'settings.navButtonMode': '导航按钮显示',
    'settings.navIcon': '图标',
    'settings.navText': '文字',
    'settings.navBoth': '图标&文字',
    'settings.fontSmall': '小',
    'settings.fontNormal': '默认',
    'settings.fontLarge': '大',
    'fullscreen.enter': '窗口全屏',
    'fullscreen.exit': '退出窗口全屏',
    'settings.note': '自动模式先尝试 1280，被手机拒绝时会自动降档。应用设置会重启画面。',
    'settings.reset': '恢复默认',
    'settings.apply': '应用并重启',
    'chat.button': '聊天助手',
    'chat.title': '聊天助手',
    'chat.close': '关闭聊天',
    'chat.placeholder': '输入指令，例如「回到桌面」',
    'chat.send': '发送',
    'chat.clear': '清空对话',
    'chat.empty': '发送消息即可指挥手机。',
    'chat.running': '正在执行…',
    'chat.error.network': '无法连接聊天服务 — {error}',
    'chat.error.request': '请求失败（{status}）— {error}',
    'chat.error.disabled': '聊天未启用或模型名为空 — 请在设置的聊天分组中填写。',
    'chat.error.unavailable': '聊天服务不可用 — 控制桥是否已启动？',
    'chat.settings.group': '聊天',
    'chat.settings.enabled': '启用聊天',
    'chat.settings.baseUrl': '模型服务地址',
    'chat.settings.model': '模型名',
    'chat.settings.apiKey': 'API Key',
    'chat.settings.apiKeyHint': '可选',
    'chat.settings.apiKeySet': '已保存，留空则不修改',
    'chat.settings.screenshot': '截图发给模型',
    'chat.settings.maxSteps': '单次最大步数',
    'chat.settings.note': '聊天设置保存在本机后端，API Key 不会回传到页面；模型名为空时聊天禁用。保存设置不会重启投屏画面。',
    'chat.settings.saved': '聊天设置已保存',
    'chat.settings.save': '保存聊天设置',
    'chat.settings.saveFailed': '保存失败 — {error}',
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
    'engine.power': '电源',
    'engine.volumeUp': '音量+',
    'engine.volumeDown': '音量−',
    'engine.back': '返回',
    'engine.home': '主页',
    'engine.overview': '多任务',
    'engine.screenshot': '截图',
    'engine.keyboard': '捕获键盘输入',
    'engine.uhid': 'UHID 输入（键盘 + 鼠标）',
    'engine.stats': '显示画质统计',
    'engine.dpad': '方向键模式（点击切换为触摸模式）',
    'engine.touch': '触摸模式（点击切换为方向键模式）',
    'engine.reload': '刷新画面',
    'engine.copy': '复制所选设备到电脑剪贴板',
    'engine.paste': '把电脑剪贴板推送到手机',
    'engine.dismiss': '关闭',
    'engine.clipboardReady': '手机剪贴板已就绪 —',
    'engine.clickToCopy': '点击复制',
    'engine.locked': '手机已锁定 — 请解锁后查看屏幕',
    'engine.sketch': '由 Sketch 创建。',
    'stat.resolution': '分辨率:',
    'stat.videoCodec': '视频编码:',
    'stat.encoder': '编码器:',
    'stat.bitrate': '码率:',
    'stat.inputBytes': '输入字节:',
    'stat.inputFps': '输入帧率:',
    'stat.droppedFps': '丢帧率:',
    'stat.decodedFps': '解码帧率:',
    'stat.notSupported': '不支持',
    'stat.avg': '平均:',
  },
};

// The engine ships English strings in its own DOM. Each source string maps to
// a message key so app.js can replace tooltips and notices in place, keeping
// the original around so switching back to English restores them.
export const ENGINE_TEXT_KEYS = Object.freeze({
  Power: 'engine.power',
  'Volume up': 'engine.volumeUp',
  'Volume down': 'engine.volumeDown',
  Back: 'engine.back',
  Home: 'engine.home',
  Overview: 'engine.overview',
  'Take screenshot': 'engine.screenshot',
  'Capture keyboard': 'engine.keyboard',
  'UHID Input (keyboard + mouse)': 'engine.uhid',
  'Display quality stats': 'engine.stats',
  'D-pad mode (click for Touch mode)': 'engine.dpad',
  'Touch mode (click for D-pad mode)': 'engine.touch',
  'Refresh stream': 'engine.reload',
  'copy device selection to host clipboard': 'engine.copy',
  'push host clipboard to device': 'engine.paste',
  dismiss: 'engine.dismiss',
  'Device clipboard ready —': 'engine.clipboardReady',
  'click to copy': 'engine.clickToCopy',
  'device is locked — unlock it to see the screen': 'engine.locked',
  'Created with Sketch.': 'engine.sketch',
});

// The stats overlay draws its own English labels with canvas.fillText, so it
// never shows up in a DOM audit. Translate each line by its label prefix.
const STAT_LABELS = [
  ['Resolution:', 'stat.resolution'],
  ['Video codec:', 'stat.videoCodec'],
  ['Encoder:', 'stat.encoder'],
  ['Bitrate:', 'stat.bitrate'],
  ['Input bytes:', 'stat.inputBytes'],
  ['Input   FPS:', 'stat.inputFps'],
  ['Dropped FPS:', 'stat.droppedFps'],
  ['Decoded FPS:', 'stat.decodedFps'],
];

export function translateStatLine(text, lang) {
  const line = String(text ?? '');
  if (lang === 'en' || !line) return line;
  if (line.trim() === MESSAGES.en['stat.notSupported']) return translate(lang, 'stat.notSupported');
  let result = line;
  for (const [source, key] of STAT_LABELS) {
    if (result.startsWith(source)) {
      result = translate(lang, key) + result.slice(source.length);
      break;
    }
  }
  return result.replace(/\s*\(avg: ([^)]*)\)/g, `（${translate(lang, 'stat.avg')} $1）`);
}

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
  uiFontSize: 1,
  uiFontColor: '#e8eaf0',
  statsFontSize: 1,
  statsFontColor: '#ec6a13',
  railScale: 1,
  statusScale: 1,
  navButtonMode: 'both',
  wheelSteps: 2,
  volume: 100,
  autoResizeWindow: true,
};
export const SETTINGS_STORAGE_KEY = 'phone-link-settings';

// Wheel-scroll amplification: how many engine scroll steps the phone is
// scrolled per browser wheel event. The engine converts one browser wheel
// tick into a single "swipe" message, so the phone screen (1152 CSS px tall)
// needs ~20 ticks to scroll fully — hence a multiplier here.
export const WHEEL_SCALE_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const DEFAULT_WHEEL_STEPS = 2;

function pick(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.volume;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function normalizeSettings(raw = {}) {
  return {
    resolution: pick(raw?.resolution, RESOLUTION_CHOICES, DEFAULT_SETTINGS.resolution),
    maxFps: pick(Number(raw?.maxFps), FPS_CHOICES, DEFAULT_SETTINGS.maxFps),
    bitrate: pick(Number(raw?.bitrate), BITRATE_CHOICES, DEFAULT_SETTINGS.bitrate),
    audio: typeof raw?.audio === 'boolean' ? raw.audio : DEFAULT_SETTINGS.audio,
    language: pick(raw?.language, LANGUAGE_CHOICES, DEFAULT_SETTINGS.language),
    uiFontSize: pick(Number(raw?.uiFontSize), UI_FONT_SCALES, DEFAULT_SETTINGS.uiFontSize),
    uiFontColor: HEX_COLOR.test(raw?.uiFontColor ?? '') ? raw.uiFontColor : DEFAULT_SETTINGS.uiFontColor,
    statsFontSize: pick(Number(raw?.statsFontSize), STATS_FONT_SCALES, DEFAULT_SETTINGS.statsFontSize),
    statsFontColor: HEX_COLOR.test(raw?.statsFontColor ?? '') ? raw.statsFontColor : DEFAULT_SETTINGS.statsFontColor,
    railScale: pick(Number(raw?.railScale), RAIL_SCALES, DEFAULT_SETTINGS.railScale),
    statusScale: pick(Number(raw?.statusScale), STATUS_SCALES, DEFAULT_SETTINGS.statusScale),
    navButtonMode: pick(raw?.navButtonMode, NAV_BUTTON_MODES, DEFAULT_SETTINGS.navButtonMode),
    wheelSteps: pick(Number(raw?.wheelSteps), WHEEL_SCALE_CHOICES, DEFAULT_SETTINGS.wheelSteps),
    volume: clampVolume(raw?.volume),
    autoResizeWindow: typeof raw?.autoResizeWindow === 'boolean' ? raw.autoResizeWindow : DEFAULT_SETTINGS.autoResizeWindow,
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
