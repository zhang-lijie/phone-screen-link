// The shared module is copied into the engine's public dir as keys.js: the
// engine's static server has no .mjs MIME type and sends nosniff, so a .mjs
// import would be refused by the browser.
import { STREAM_SIZE_LADDER, buildStreamOptions, isDegradedStream, isUsableContext, lockHint } from './keys.js';

const DEVICE_ID = '2FD0221C09004177';
const BRIDGE_URL = 'http://127.0.0.1:8100/keyevent';
const SCREEN_STATE_POLL_MS = 3000;
const ENGINE_UNAVAILABLE = 'Engine unavailable — is the service running?';

// The engine builds its own toolbox (screenshot, clipboard, stats, input
// modes). Its icons carry a tooltip but no visible text, so the labels are
// mapped here and rendered by CSS through data-label.
const TOOLBOX_LABELS = new Map([
  ['Take screenshot', 'SHOT'],
  ['Capture keyboard', 'KEYS'],
  ['UHID Input (keyboard + mouse)', 'MOUSE'],
  ['Display quality stats', 'STATS'],
  ['D-pad mode (click for Touch mode)', 'DPAD'],
  ['Refresh stream', 'RELOAD'],
  ['copy device selection to host clipboard', 'COPY'],
  ['push host clipboard to device', 'PASTE'],
]);

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

// The toolbox is created by the engine once the player attaches, so it can
// appear after our first paint — and again after a stream restart. Label every
// copy as soon as it shows up, for as long as the page lives.
function labelToolbox() {
  const list = streamEl.querySelector('.control-buttons-list');
  if (!list) return;
  for (const el of list.querySelectorAll('.control-button')) {
    const label = TOOLBOX_LABELS.get(el.getAttribute('title'));
    if (label) el.setAttribute('data-label', label);
  }
}

const toolboxObserver = new MutationObserver(() => labelToolbox());
toolboxObserver.observe(streamEl, { childList: true, subtree: true });

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

const RETRY_DELAY_MS = 1200;

// Each attempt gets a generation. Stopping a stream fires its disconnect
// callback asynchronously, so a retry bumps the generation first and the stale
// callback is ignored instead of overwriting the new status.
let generation = 0;
let attempts = 0;

function startStream() {
  const gen = ++generation;
  const size = STREAM_SIZE_LADDER[Math.min(attempts, STREAM_SIZE_LADDER.length - 1)];
  attempts += 1;

  const options = buildStreamOptions({ deviceId: DEVICE_ID, maxSize: size });

  options.onConnect = (info) => {
    if (gen !== generation) return;
    labelToolbox();
    const degraded = isDegradedStream(info?.resolution, size);
    const canRetry = attempts < STREAM_SIZE_LADDER.length;
    if (degraded && canRetry) {
      generation += 1;
      setStatus(`Stream came back at ${info.resolution} — retrying…`);
      try {
        window.phoneLinkHandle?.stop();
      } catch {
        // The session is already gone; starting a new one is all that matters.
      }
      setTimeout(startStream, RETRY_DELAY_MS);
      return;
    }
    const resolution = info?.resolution ? ` — ${info.resolution}` : '';
    setStatus(`Connected${resolution}${degraded ? ' (low resolution — press RELOAD)' : ''}`);
  };
  options.onDisconnect = (reason) => {
    if (gen !== generation) return;
    setStatus(`Disconnected${reason ? ` — ${reason}` : ''}`);
  };
  options.onError = (err) => {
    if (gen !== generation) return;
    setStatus(`Stream error — ${messageOf(err)}`);
  };

  window.phoneLinkHandle = window.WsScrcpy.startStream(streamEl, DEVICE_ID, options);
}

if (!isUsableContext(location.protocol, location.hostname)) {
  setStatus('Insecure origin — open http://127.0.0.1:8000/ (or https) so the browser can decode the stream.');
} else if (!window.WsScrcpy || typeof window.WsScrcpy.startStream !== 'function') {
  setStatus(ENGINE_UNAVAILABLE);
} else {
  setStatus('Connecting to phone…');
  try {
    startStream();
  } catch (err) {
    setStatus(`${ENGINE_UNAVAILABLE} ${messageOf(err)}`);
  }
}
