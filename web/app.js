// The shared module is copied into the engine's public dir as keys.js: the
// engine's static server has no .mjs MIME type and sends nosniff, so a .mjs
// import would be refused by the browser.
import { buildStreamOptions, isUsableContext, lockHint } from './keys.js';

const DEVICE_ID = '2FD0221C09004177';
const BRIDGE_URL = 'http://127.0.0.1:8100/keyevent';
const SCREEN_STATE_POLL_MS = 3000;
const ENGINE_UNAVAILABLE = 'Engine unavailable — is the service running?';

const streamEl = document.getElementById('stream');
const statusEl = document.getElementById('status');

let baseStatus = 'Connecting…';
let lockMessage = '';

// Every status update (stream events, key presses and the lock hint) funnels
// through here. The hint is prepended so it never destroys the current status.
function renderStatus() {
  statusEl.textContent = lockMessage ? `${lockMessage} — ${baseStatus}` : baseStatus;
}

function setStatus(text) {
  baseStatus = text;
  renderStatus();
}

async function pollScreenState() {
  try {
    // Same origin as the page (port 8000), so no CORS or bridge is involved.
    const res = await fetch(`/api/devices/screen-state?udid=${encodeURIComponent(DEVICE_ID)}`);
    if (!res.ok) return;
    const hint = lockHint(await res.json());
    if (hint !== lockMessage) {
      lockMessage = hint;
      renderStatus();
    }
  } catch {
    // Endpoint not reachable yet; keep the last known hint.
  }
}

pollScreenState();
setInterval(pollScreenState, SCREEN_STATE_POLL_MS);

function messageOf(value) {
  return value instanceof Error ? value.message : String(value ?? '');
}

for (const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('click', async () => {
    const key = button.dataset.key;
    try {
      const res = await fetch(BRIDGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (res.status === 503) {
        setStatus('Phone is offline — check the USB connection');
        return;
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        setStatus(`${key} key failed (${res.status})${detail.error ? ` — ${detail.error}` : ''}`);
        return;
      }
      setStatus(`${key} key sent`);
    } catch (err) {
      setStatus(`Control bridge unavailable — ${messageOf(err)}`);
    }
  });
}

if (!isUsableContext(location.protocol, location.hostname)) {
  setStatus('Insecure origin — open http://127.0.0.1:8000/ (or https) so the browser can decode the stream.');
} else if (!window.WsScrcpy || typeof window.WsScrcpy.startStream !== 'function') {
  setStatus(ENGINE_UNAVAILABLE);
} else {
  setStatus('Connecting to phone…');
  try {
    const options = buildStreamOptions({ deviceId: DEVICE_ID });
    options.onConnect = (info) => {
      setStatus(`Connected${info?.resolution ? ` — ${info.resolution}` : ''}`);
    };
    options.onDisconnect = (reason) => {
      setStatus(`Disconnected${reason ? ` — ${reason}` : ''}`);
    };
    options.onError = (err) => {
      setStatus(`Stream error — ${messageOf(err)}`);
    };
    window.phoneLinkHandle = window.WsScrcpy.startStream(streamEl, DEVICE_ID, options);
  } catch (err) {
    setStatus(`${ENGINE_UNAVAILABLE} ${messageOf(err)}`);
  }
}
