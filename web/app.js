import { buildStreamOptions, isUsableContext } from './keys.mjs';

const DEVICE_ID = '2FD0221C09004177';
const BRIDGE_URL = 'http://127.0.0.1:8100/keyevent';
const ENGINE_UNAVAILABLE = 'Engine unavailable — is the service running?';

const streamEl = document.getElementById('stream');
const statusEl = document.getElementById('status');

// Single write path for every status update (stream events and key presses).
function setStatus(text) {
  statusEl.textContent = text;
}

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
