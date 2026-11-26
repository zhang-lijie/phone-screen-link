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
    'tool.wireless': 'WIFI',
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
    // Wireless ADB pairing. The backend owns connection state; the browser
    // only mirrors it and persists the user-entered pairing form.
    'wireless.title': 'Wireless debugging',
    'wireless.close': 'Close wireless debugging',
    'wireless.current': 'Mode: {mode} · Address: {address} · {online}',
    'wireless.mode.usb': 'USB',
    'wireless.mode.wifi': 'Wireless',
    'wireless.mode.unknown': 'Unknown',
    'wireless.online.online': 'online',
    'wireless.online.offline': 'offline',
    'wireless.loading': 'Loading wireless status…',
    'wireless.groupPair': 'Pair (Android 11+)',
    'wireless.pairHint': 'Open Developer options → Wireless debugging → Pair device with pairing code.',
    'wireless.auto': 'Auto-fetch over USB',
    'wireless.autoHint': 'Connect the phone by USB, enable Wireless debugging, and open the pairing-code dialog. Auto-fetch reads the IP and ports; enter the 6-digit pairing code manually.',
    'wireless.auto.loading': 'Fetching wireless details…',
    'wireless.auto.fetched': 'Wireless details fetched — enter the pairing code.',
    'wireless.auto.partial': 'Only partial wireless details were fetched. Check the fields before pairing.{warnings}',
    'wireless.warning.wifiIpUnavailable': 'Could not read the phone Wi-Fi IP address.',
    'wireless.warning.connectPortUnavailable': 'Wireless connect port is unavailable; make sure Wireless debugging is enabled.',
    'wireless.warning.pairingPortUnavailable': 'Wireless pairing port is unavailable; open the Android pairing dialog and try again.',
    'wireless.pairHost': 'Pair IP',
    'wireless.pairPort': 'Pair port',
    'wireless.pairCode': '6-digit pairing code',
    'wireless.groupConnect': 'Connect',
    'wireless.connectHint': 'Use the IP address and port on the main Wireless debugging screen.',
    'wireless.connectHost': 'Connect IP',
    'wireless.connectPort': 'Connect port',
    'wireless.submit': 'Pair & connect',
    'wireless.usb': 'Switch to USB',
    'wireless.clear': 'Clear saved pairing information',
    'wireless.cleared': 'Saved pairing information cleared',
    'wireless.pairing': 'Pairing and connecting…',
    'wireless.switchingUsb': 'Switching to USB…',
    'wireless.connected': 'Wireless connected — restarting stream…',
    'wireless.usbConnected': 'USB selected — restarting stream…',
    'wireless.error.request': 'Wireless request failed ({status}) — {error}',
    'wireless.error.network': 'Cannot reach the control bridge — {error}',
    'wireless.error.invalidResponse': 'The control bridge returned an invalid wireless response',
    'wireless.error.offline': 'The wireless device is offline — it was not activated',
    'wireless.error.usbOffline': 'The USB device is offline — connect and authorize it before auto-fetching',
    'wireless.error.storage': 'Cannot access browser storage — saved pairing information was not removed',
    'wireless.error.save': 'Browser storage is unavailable — pairing still works, but the form will be lost on reload',
    'wireless.warning': 'Warning: the full form, including the pairing code, is saved in plain text in this browser\'s localStorage. Anyone with access to this browser profile can read it. Pairing codes expire; if pairing fails, get the current code from the phone. Use “Clear saved pairing information” to remove it.',
    'wireless.modeLabel': 'Connection mode',
    'wireless.mode.pair': 'Android 11+ pairing code',
    'wireless.mode.legacy': 'Legacy 5555 (no pairing code)',
    'wireless.groupLegacy': 'Legacy TCP connection',
    'wireless.legacyHint': 'For devices without a pairing-code dialog. Use the phone IP shown on its Wireless debugging screen; port 5555 is the default.',
    'wireless.legacyHost': 'Phone IP',
    'wireless.legacyPort': 'Port',
    'wireless.legacyAuto': 'Auto-fetch & connect',
    'wireless.legacyAuto.loading': 'Fetching IP and enabling TCP mode…',
    'wireless.legacyConnect': 'Connect',
    'wireless.legacy.connecting': 'Connecting…',
    'wireless.legacy.connected': 'Legacy wireless connected — restarting stream…',
    'wireless.error.legacyUsbOffline': 'The USB device is offline — connect and authorize it before auto-connecting',
    'wireless.error.legacyAutoNoIp': 'Could not read the phone Wi-Fi IP address over USB — enter the IP manually and try again',
    'wireless.legacyWarning': 'Warning: legacy mode is unencrypted and has no authentication. Use it only on a trusted LAN.',
    'wireless.activeMethod.legacy': 'Active method: legacy (unencrypted, no authentication)',
    // Chat feature: floating button, panel and the settings group. The
    // config itself lives on the backend; these are display strings only.
    'chat.button': 'Chat assistant',
    'chat.title': 'Chat assistant',
    'chat.close': 'Close chat',
    'chat.dock': 'Dock chat beside the screen',
    'chat.undock': 'Undock chat',
    'chat.dockNarrow': 'Side-by-side needs a window at least 720px wide',
    'chat.splitter': 'Drag to resize the two panels',
    'chat.placeholder': 'Ask anything, or type / for quick commands',
    'chat.send': 'Send',
    'chat.cmdDone': 'Done: {name}',
    'chat.cmdFailed': 'Command failed: {error}',
    'chat.clear': 'Clear chat',
    'chat.empty': 'Send a message to control the phone.',
    'chat.expand': 'Double-click to expand',
    'chat.collapse': 'Double-click to collapse',
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
    'tool.wireless': '无线',
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
    'wireless.title': '无线调试',
    'wireless.close': '关闭无线调试',
    'wireless.current': '模式：{mode} · 地址：{address} · {online}',
    'wireless.mode.usb': 'USB',
    'wireless.mode.wifi': '无线',
    'wireless.mode.unknown': '未知',
    'wireless.online.online': '在线',
    'wireless.online.offline': '离线',
    'wireless.loading': '正在读取无线状态…',
    'wireless.groupPair': '配对（Android 11+）',
    'wireless.pairHint': '打开开发者选项 → 无线调试 → 使用配对码配对设备。',
    'wireless.auto': 'USB 自动获取',
    'wireless.autoHint': '请用 USB 连接手机，开启无线调试并打开配对码弹窗。自动获取只读取 IP 和端口，6 位配对码仍需手动输入。',
    'wireless.auto.loading': '正在获取无线调试信息…',
    'wireless.auto.fetched': '已获取无线调试信息 — 请输入配对码。',
    'wireless.auto.partial': '仅获取到部分无线调试信息，请检查表单后再配对。{warnings}',
    'wireless.warning.wifiIpUnavailable': '无法读取手机 Wi-Fi IP 地址。',
    'wireless.warning.connectPortUnavailable': '无法获取无线连接端口；请确认已开启无线调试。',
    'wireless.warning.pairingPortUnavailable': '无法获取无线配对端口；请打开 Android 配对弹窗后重试。',
    'wireless.pairHost': '配对 IP',
    'wireless.pairPort': '配对端口',
    'wireless.pairCode': '6 位配对码',
    'wireless.groupConnect': '连接',
    'wireless.connectHint': '请使用无线调试主界面显示的 IP 地址和端口。',
    'wireless.connectHost': '连接 IP',
    'wireless.connectPort': '连接端口',
    'wireless.submit': '配对并连接',
    'wireless.usb': '切回 USB',
    'wireless.clear': '清除已保存配对信息',
    'wireless.cleared': '已清除保存的配对信息',
    'wireless.pairing': '正在配对并连接…',
    'wireless.switchingUsb': '正在切回 USB…',
    'wireless.connected': '无线连接成功 — 正在重启画面…',
    'wireless.usbConnected': '已选择 USB — 正在重启画面…',
    'wireless.error.request': '无线请求失败（{status}）— {error}',
    'wireless.error.network': '无法连接控制桥 — {error}',
    'wireless.error.invalidResponse': '控制桥返回了无效的无线状态',
    'wireless.error.offline': '无线设备已离线 — 未切换活动设备',
    'wireless.error.usbOffline': 'USB 设备已离线 — 请连接并授权 USB 调试后再自动获取',
    'wireless.error.storage': '无法访问浏览器存储 — 未删除已保存的配对信息',
    'wireless.error.save': '浏览器存储不可用 — 仍可正常配对，但表单会在刷新后丢失',
    'wireless.warning': '警告：完整表单（含配对码）会以明文保存到此浏览器的 localStorage。能够访问此浏览器配置文件的任何人都可读取。配对码会过期；如果配对失败，请从手机获取最新配对码。使用“清除已保存配对信息”可删除。',
    'wireless.modeLabel': '连接方式',
    'wireless.mode.pair': 'Android 11+ 配对码',
    'wireless.mode.legacy': '传统 5555（无需配对码）',
    'wireless.groupLegacy': '传统 TCP 连接',
    'wireless.legacyHint': '适用于没有配对码弹窗的设备。手机 IP 见「无线调试」主页面，端口默认 5555。',
    'wireless.legacyHost': '手机 IP',
    'wireless.legacyPort': '端口',
    'wireless.legacyAuto': '自动获取并连接',
    'wireless.legacyAuto.loading': '正在获取 IP 并开启 TCP 模式…',
    'wireless.legacyConnect': '连接',
    'wireless.legacy.connecting': '正在连接…',
    'wireless.legacy.connected': '传统无线连接成功 — 正在重启画面…',
    'wireless.error.legacyUsbOffline': 'USB 设备已离线 — 请先连接并授权 USB 调试后再自动获取并连接',
    'wireless.error.legacyAutoNoIp': '无法通过 USB 读取手机 Wi-Fi IP 地址 — 请手动输入 IP 后重试',
    'wireless.legacyWarning': '警告：传统模式未加密、无认证，仅可在可信局域网中使用。',
    'wireless.activeMethod.legacy': '当前方式：传统（未加密、无认证）',
    'chat.button': '聊天助手',
    'chat.title': '聊天助手',
    'chat.close': '关闭聊天',
    'chat.dock': '与画面并排显示',
    'chat.undock': '取消并排显示',
    'chat.dockNarrow': '窗口宽度至少 720px 才能并排显示',
    'chat.splitter': '拖动调整两侧大小',
    'chat.placeholder': '输入指令，或输入 / 查看快捷命令',
    'chat.send': '发送',
    'chat.cmdDone': '已执行：{name}',
    'chat.cmdFailed': '命令执行失败：{error}',
    'chat.clear': '清空对话',
    'chat.empty': '发送消息即可指挥手机。',
    'chat.expand': '双击展开',
    'chat.collapse': '双击收起',
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
  navButtonMode: 'icon',
  wheelSteps: 2,
  volume: 100,
  autoResizeWindow: true,
};
export const SETTINGS_STORAGE_KEY = 'phone-link-settings';

export const WIRELESS_AUTO_WARNING_CODES = Object.freeze({
  WIFI_IP_UNAVAILABLE: 'WIFI_IP_UNAVAILABLE',
  CONNECT_PORT_UNAVAILABLE: 'CONNECT_PORT_UNAVAILABLE',
  PAIRING_PORT_UNAVAILABLE: 'PAIRING_PORT_UNAVAILABLE',
});
// The user explicitly requested that the complete wireless pairing form,
// including its short-lived pairing code, survive browser reloads. Keep this
// separate from backend connection config: the backend never stores the code.
export const WIRELESS_PAIRING_STORAGE_KEY = 'phone-link-wireless-pairing';
export const WIRELESS_PAIRING_FIELDS = Object.freeze([
  'pairHost',
  'pairPort',
  'pairCode',
  'connectHost',
  'connectPort',
]);
export const DEFAULT_WIRELESS_PAIRING = Object.freeze({
  pairHost: '',
  pairPort: '',
  pairCode: '',
  connectHost: '',
  connectPort: '',
});

// The selected method and legacy form live in the SAME localStorage entry as
// the pairing form. Keeping them alongside the pair fields means one clear
// action removes everything, and a mode switch can never overwrite the code.
export const WIRELESS_METHODS = Object.freeze({ PAIR: 'pair', LEGACY: 'legacy' });
export const WIRELESS_MODE_FIELDS = Object.freeze(['method', 'legacyHost', 'legacyPort']);
export const DEFAULT_WIRELESS_MODE = Object.freeze({
  method: WIRELESS_METHODS.PAIR,
  legacyHost: '',
  legacyPort: '5555',
});

function normalizeWirelessPairing(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(WIRELESS_PAIRING_FIELDS.map((field) => [
    field,
    typeof source[field] === 'string' ? source[field] : DEFAULT_WIRELESS_PAIRING[field],
  ]));
}

function normalizeWirelessMode(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawPort = typeof source.legacyPort === 'string'
    ? source.legacyPort
    : (Number.isInteger(source.legacyPort) ? String(source.legacyPort) : '');
  const legacyPort = /^\d{1,5}$/.test(rawPort)
    && Number(rawPort) >= 1 && Number(rawPort) <= 65535
    ? rawPort
    : DEFAULT_WIRELESS_MODE.legacyPort;
  return {
    method: source.method === WIRELESS_METHODS.LEGACY ? WIRELESS_METHODS.LEGACY : WIRELESS_METHODS.PAIR,
    legacyHost: typeof source.legacyHost === 'string' ? source.legacyHost : DEFAULT_WIRELESS_MODE.legacyHost,
    legacyPort,
  };
}

function resolveWirelessStorage(storageOrProvider) {
  return typeof storageOrProvider === 'function' ? storageOrProvider() : storageOrProvider;
}

function readStoredWirelessMode(storage) {
  try {
    const raw = JSON.parse(storage?.getItem(WIRELESS_PAIRING_STORAGE_KEY));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(WIRELESS_MODE_FIELDS
      .filter((field) => Object.hasOwn(raw, field))
      .map((field) => [field, raw[field]]));
  } catch {
    return {};
  }
}

export function loadWirelessPairing(storageOrProvider) {
  try {
    const storage = resolveWirelessStorage(storageOrProvider);
    return normalizeWirelessPairing(JSON.parse(storage?.getItem(WIRELESS_PAIRING_STORAGE_KEY)));
  } catch {
    return { ...DEFAULT_WIRELESS_PAIRING };
  }
}

export function saveWirelessPairing(storageOrProvider, values) {
  const normalized = normalizeWirelessPairing(values);
  try {
    const storage = resolveWirelessStorage(storageOrProvider);
    if (!storage || typeof storage.setItem !== 'function') {
      return { saved: false, values: normalized };
    }
    // Preserve the selected method and legacy fields: saving the pair form
    // happens on every keystroke, so it must not silently reset the mode.
    // Normalize only the fields that were actually stored, so a malformed
    // entry is repaired instead of written back verbatim, while a form-only
    // entry keeps its original shape.
    const storedMode = readStoredWirelessMode(storage);
    const normalizedMode = normalizeWirelessMode(storedMode);
    const modePatch = Object.fromEntries(WIRELESS_MODE_FIELDS
      .filter((field) => Object.hasOwn(storedMode, field))
      .map((field) => [field, normalizedMode[field]]));
    storage.setItem(WIRELESS_PAIRING_STORAGE_KEY, JSON.stringify({
      ...normalized,
      ...modePatch,
    }));
    return { saved: true, values: normalized };
  } catch {
    // Private browsing or a full quota: pairing remains usable for this
    // session, but the caller must not claim the form will survive reload.
    return { saved: false, values: normalized };
  }
}

export function loadWirelessMode(storageOrProvider) {
  try {
    const storage = resolveWirelessStorage(storageOrProvider);
    return normalizeWirelessMode(JSON.parse(storage?.getItem(WIRELESS_PAIRING_STORAGE_KEY)));
  } catch {
    return { ...DEFAULT_WIRELESS_MODE };
  }
}

export function saveWirelessMode(storageOrProvider, values) {
  const normalized = normalizeWirelessMode(values);
  try {
    const storage = resolveWirelessStorage(storageOrProvider);
    if (!storage || typeof storage.setItem !== 'function') {
      return { saved: false, values: normalized };
    }
    let pairValues;
    try {
      pairValues = normalizeWirelessPairing(JSON.parse(storage.getItem(WIRELESS_PAIRING_STORAGE_KEY)));
    } catch {
      pairValues = { ...DEFAULT_WIRELESS_PAIRING };
    }
    storage.setItem(WIRELESS_PAIRING_STORAGE_KEY, JSON.stringify({ ...pairValues, ...normalized }));
    return { saved: true, values: normalized };
  } catch {
    return { saved: false, values: normalized };
  }
}

export function isWirelessPairingSuccess(payload) {
  return Boolean(
    payload
    && payload.mode === 'wifi'
    && typeof payload.serial === 'string'
    && payload.serial.trim() !== ''
    && payload.online === true,
  );
}

// A legacy connect returns the same whitelisted status payload as pairing, so
// the activation rules are identical: only an online wifi target may replace
// DEVICE_ID and restart the stream.
export function isLegacyConnectSuccess(payload) {
  return isWirelessPairingSuccess(payload);
}

function normalizeWirelessAutoHost(value) {
  if (typeof value !== 'string') return '';
  const host = value.trim();
  if (host === '' || host.length > 253 || /\s/.test(host)) return '';
  if (/^[\d.]+$/.test(host)) {
    const parts = host.split('.');
    return parts.length === 4 && parts.every((part) => (
      /^\d{1,3}$/.test(part) && Number(part) <= 255
    )) ? host : '';
  }
  return host.split('.').every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  )) ? host : '';
}

function normalizeWirelessAutoPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? String(value) : '';
}

export function wirelessAutoWarningKey(code) {
  return Object.hasOwn(WIRELESS_AUTO_WARNING_CODES, code)
    ? `wireless.warning.${{
      WIFI_IP_UNAVAILABLE: 'wifiIpUnavailable',
      CONNECT_PORT_UNAVAILABLE: 'connectPortUnavailable',
      PAIRING_PORT_UNAVAILABLE: 'pairingPortUnavailable',
    }[code]}`
    : null;
}

// The auto endpoint is read-only and may return partial data. Validate its
// envelope, keep only usable address fields, and never accept a pairing code
// from it: the user must always enter that short-lived credential manually.
export function parseWirelessAutoResult(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || typeof payload.usbSerial !== 'string' || payload.usbSerial.trim() === ''
      || !Array.isArray(payload.warnings)) {
    return null;
  }

  const updates = {};
  const pairHost = normalizeWirelessAutoHost(payload.pairHost);
  const pairPort = normalizeWirelessAutoPort(payload.pairPort);
  const connectHost = normalizeWirelessAutoHost(payload.connectHost);
  const connectPort = normalizeWirelessAutoPort(payload.connectPort);
  if (pairHost) updates.pairHost = pairHost;
  if (pairPort) updates.pairPort = pairPort;
  if (connectHost) updates.connectHost = connectHost;
  if (connectPort) updates.connectPort = connectPort;

  const warnings = [...new Set(payload.warnings
    .map((warning) => (wirelessAutoWarningKey(warning) ? warning : ''))
    .filter(Boolean))];

  return {
    usbSerial: payload.usbSerial.trim(),
    updates,
    warnings,
    complete: Boolean(updates.pairHost && updates.pairPort && updates.connectHost && updates.connectPort),
  };
}

export function clearWirelessPairing(storageOrProvider) {
  try {
    const storage = resolveWirelessStorage(storageOrProvider);
    if (!storage || typeof storage.removeItem !== 'function') return false;
    storage.removeItem(WIRELESS_PAIRING_STORAGE_KEY);
    return true;
  } catch {
    // The caller must not claim removal succeeded when storage is inaccessible.
    return false;
  }
}

export function clearWirelessPairingResult(storageOrProvider) {
  const cleared = clearWirelessPairing(storageOrProvider);
  return {
    cleared,
    feedbackKey: cleared ? 'wireless.cleared' : 'wireless.error.storage',
    isError: !cleared,
  };
}

// A modal-open status refresh can overlap a pair/USB mutation. Only the newest
// refresh may update the display, and mutations invalidate refreshes both when
// they start and when they settle. Refreshes started during a mutation never run.
export function createWirelessRequestGuard() {
  let version = 0;
  let mutationActive = false;

  async function settle(request, token) {
    try {
      const value = await request();
      return token === version ? { stale: false, value } : { stale: true };
    } catch (error) {
      return token === version ? { stale: false, error } : { stale: true };
    }
  }

  return {
    refresh(request) {
      if (mutationActive) return Promise.resolve({ stale: true });
      const token = ++version;
      return settle(request, token);
    },
    async mutate(request) {
      mutationActive = true;
      version += 1;
      const token = version;
      try {
        return await settle(request, token);
      } finally {
        version += 1;
        mutationActive = false;
      }
    },
  };
}

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
// Input-mode checkboxes the engine builds in its toolbox. Matched by input-id
// prefix (title is translated, id is not). While chat is open all three are
// unchecked so key/mouse/touch input stops reaching the phone; closing chat
// restores the fixed defaults.
export const CHAT_INPUT_MODE_IDS = Object.freeze({
  keyboard: 'input_capture_keyboard_',
  uhid: 'input_uhid_input_',
  touch: 'input_input_mode_',
});

export function chatInputModeTargets(chatOpen) {
  return chatOpen
    ? { keyboard: false, uhid: false, touch: false }
    : { keyboard: true, uhid: false, touch: true };
}

// Chat dock (side-by-side) mode. Kept in localStorage like the drag position.
export const CHAT_DOCK_KEY = 'phone-link-chat-docked';
export const MIN_DOCK_WIDTH = 720;

export function canDock(viewportWidth) {
  return Number.isFinite(viewportWidth) && viewportWidth >= MIN_DOCK_WIDTH;
}

export function readChatDock(storage) {
  try {
    return storage?.getItem(CHAT_DOCK_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeChatDock(storage, docked) {
  try {
    storage?.setItem(CHAT_DOCK_KEY, docked ? 'true' : 'false');
  } catch {
    // Storage disabled: the dock mode simply won't survive a reload.
  }
}

export function shouldCenterDock(streamWidth, chatWidth) {
  return chatWidth > streamWidth;
}

// Docked splitter: how much of the stage the stream side takes. Stored as a
// ratio so it survives window resizes. Stream keeps at least 400px, chat 240px.
export const CHAT_SPLIT_KEY = 'phone-link-chat-split-ratio';
export const MIN_DOCK_STREAM = 400;
export const MIN_DOCK_CHAT = 240;

export function clampDockStreamWidth(requested, available) {
  const max = available - MIN_DOCK_CHAT;
  if (max < MIN_DOCK_STREAM) return MIN_DOCK_STREAM;
  return Math.min(Math.max(requested, MIN_DOCK_STREAM), max);
}

export function readChatSplitRatio(storage) {
  try {
    const raw = storage?.getItem(CHAT_SPLIT_KEY);
    if (!raw) return null;
    const ratio = Number(raw);
    return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : null;
  } catch {
    return null;
  }
}

export function writeChatSplitRatio(storage, ratio) {
  try {
    storage?.setItem(CHAT_SPLIT_KEY, String(ratio));
  } catch {
    // Storage disabled: the split ratio simply won't survive a reload.
  }
}

// Chat panel drag position. The panel is non-modal and can be moved freely,
// but its head (the drag handle, ~40px tall) must stay on screen so the user
// can always grab it again. Horizontally a 40px strip stays visible.
export const CHAT_POSITION_KEY = 'phone-link-chat-position';

export function clampPanelPosition(x, y, width, height, viewportWidth, viewportHeight) {
  const margin = 40;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  return {
    x: clamp(x, margin - width, viewportWidth - margin),
    y: clamp(y, 0, viewportHeight - margin),
  };
}

export function readChatPosition(storage) {
  try {
    const raw = storage?.getItem(CHAT_POSITION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    // Corrupt or unavailable storage: fall back to the docked position.
  }
  return null;
}

export function writeChatPosition(storage, position) {
  try {
    storage?.setItem(CHAT_POSITION_KEY, JSON.stringify({ x: position.x, y: position.y }));
  } catch {
    // Storage disabled: the position simply won't survive a reload.
  }
}

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
