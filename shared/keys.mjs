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
export const DEFAULT_SETTINGS = {
  resolution: 'auto',
  maxFps: 30,
  bitrate: 8_000_000,
  audio: true,
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
export function lockHint({ locked, awake } = {}) {
  if (locked) return 'Phone is locked — unlock it to see the screen';
  if (awake === false) return 'Phone is asleep — waking it';
  return '';
}
