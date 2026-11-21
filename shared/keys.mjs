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

export function buildStreamOptions({ maxSize } = {}) {
  return {
    keyboard: true,
    fitToScreen: false,
    maxSize: maxSize ?? STREAM_SIZE_LADDER[0],
    maxFps: 30,
    audio: true,
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
