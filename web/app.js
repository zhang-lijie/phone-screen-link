// The shared module is copied into the engine's public dir as keys.js: the
// engine's static server has no .mjs MIME type and sends nosniff, so a .mjs
// import would be refused by the browser.
import {
  DEFAULT_SETTINGS,
  buildStreamOptions,
  isDegradedStream,
  isUsableContext,
  loadSettings,
  normalizeSettings,
  saveSettings,
  sizeLadder,
  lockHint,
} from './keys.js';

const DEVICE_ID = '2FD0221C09004177';
const BRIDGE_URL = 'http://127.0.0.1:8100/keyevent';
const SCREEN_STATE_POLL_MS = 3000;
const ENGINE_UNAVAILABLE = 'Engine unavailable — is the service running?';

const streamEl = document.getElementById('stream');
const statusEl = document.getElementById('status');

// The browser menu must never pop up over the mirrored phone: the engine uses
// right-click as the phone's Back button, and a native menu would swallow the
// click and cover the picture. Keep the mousedown control, drop only the menu.
document.addEventListener('contextmenu', (event) => event.preventDefault());

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

// Settings come from localStorage and are validated before they reach the
// engine — a stale/tampered value must not break the stream.
let settings = loadSettings(localStorage);
let ladder = sizeLadder(settings);

const GEAR_SVG = '<svg viewBox="0 0 24 24" width="48" height="48" aria-hidden="true">' +
  '<path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.15 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.05.31-.08.63-.08.94s.03.63.08.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.61.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.09.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/>' +
  '</svg>';

const overlay = document.getElementById('settings-overlay');
const formFields = {
  resolution: document.getElementById('set-resolution'),
  maxFps: document.getElementById('set-fps'),
  bitrate: document.getElementById('set-bitrate'),
  audio: document.getElementById('set-audio'),
};

function fillSettingsForm(values = settings) {
  formFields.resolution.value = values.resolution;
  formFields.maxFps.value = String(values.maxFps);
  formFields.bitrate.value = String(values.bitrate);
  formFields.audio.checked = values.audio;
}

function openSettings() {
  fillSettingsForm();
  overlay.hidden = false;
  formFields.resolution.focus();
}

function closeSettings() {
  overlay.hidden = true;
}

function readSettingsForm() {
  return normalizeSettings({
    resolution: formFields.resolution.value,
    maxFps: Number(formFields.maxFps.value),
    bitrate: Number(formFields.bitrate.value),
    audio: formFields.audio.checked,
  });
}

document.getElementById('settings-close').addEventListener('click', closeSettings);
overlay.addEventListener('click', (event) => {
  if (event.target === overlay) closeSettings();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !overlay.hidden) closeSettings();
});
document.getElementById('settings-reset').addEventListener('click', () => {
  fillSettingsForm(DEFAULT_SETTINGS);
});

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
  addSettingsButton(list);
}

// The engine owns the rail, so our entry is injected into its DOM. It is a
// plain toolbox button (same class/label rules), just with our own handler.
function addSettingsButton(list) {
  if (list.querySelector('.settings-button')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'control-button settings-button';
  button.title = 'Stream settings';
  button.dataset.label = 'SET';
  button.setAttribute('aria-label', 'Stream settings');
  button.innerHTML = GEAR_SVG;
  button.addEventListener('click', openSettings);
  list.appendChild(button);
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
  const size = ladder[Math.min(attempts, ladder.length - 1)];
  attempts += 1;

  // maxSize is the only per-attempt override; fps/bitrate/audio come from the
  // saved settings so changing one does not reset the others.
  const options = buildStreamOptions(settings, size);

  options.onConnect = (info) => {
    if (gen !== generation) return;
    labelToolbox();
    const degraded = isDegradedStream(info?.resolution, size);
    const canRetry = attempts < ladder.length;
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

function applySettings() {
  settings = saveSettings(localStorage, readSettingsForm());
  ladder = sizeLadder(settings);
  closeSettings();
  generation += 1; // ignore the old stream's late callbacks
  attempts = 0;
  try {
    window.phoneLinkHandle?.stop();
  } catch {
    // It may already be gone; the new session is what matters.
  }
  if (!isUsableContext(location.protocol, location.hostname) || !window.WsScrcpy) {
    setStatus(ENGINE_UNAVAILABLE);
    return;
  }
  setStatus('Applying settings…');
  setTimeout(startStream, 250);
}

document.getElementById('settings-apply').addEventListener('click', applySettings);

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
