export const KEY_CODES = { home: 3, back: 4, power: 26 };

// The device id is passed to startStream separately; codec stays omitted so
// the engine auto-selects. A fresh object is returned on every call.
export function buildStreamOptions(_config = {}) {
  return {
    keyboard: true,
    fitToScreen: true,
    maxFps: 30,
    audio: true,
  };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// WebCodecs needs a secure context; plain http is only usable on loopback.
export function isUsableContext(protocol, hostname) {
  if (protocol === 'https:') return true;
  return protocol === 'http:' && LOOPBACK_HOSTS.has(hostname);
}
