// The shared module is copied into the engine's public dir as keys.js: the
// engine's static server has no .mjs MIME type and sends nosniff, so a .mjs
// import would be refused by the browser.
import {
  DEFAULT_SETTINGS,
  ENGINE_TEXT_KEYS,
  buildStreamOptions,
  effectiveLanguage,
  isDegradedStream,
  isUsableContext,
  loadSettings,
  lockHint,
  normalizeSettings,
  saveSettings,
  sizeLadder,
  translate,
  translateStatLine,
} from './keys.js';

const DEVICE_ID = '2FD0221C09004177';
const BRIDGE_URL = 'http://127.0.0.1:8100/keyevent';
const SCREEN_STATE_POLL_MS = 3000;

const streamEl = document.getElementById('stream');
const statusEl = document.getElementById('status');

// The browser menu must never pop up over the mirrored phone: the engine uses
// right-click as the phone's Back button, and a native menu would swallow the
// click and cover the picture. Keep the mousedown control, drop only the menu.
document.addEventListener('contextmenu', (event) => event.preventDefault());

// The engine builds its own toolbox (screenshot, clipboard, stats, input
// modes). Its icons carry an English tooltip but no visible text, so the
// labels are mapped here to translation keys and rendered via data-label.
const TOOLBOX_LABELS = new Map([
  ['Take screenshot', 'tool.shot'],
  ['Capture keyboard', 'tool.keys'],
  ['UHID Input (keyboard + mouse)', 'tool.mouse'],
  ['Display quality stats', 'tool.stats'],
  ['D-pad mode (click for Touch mode)', 'tool.dpad'],
  ['Touch mode (click for D-pad mode)', 'tool.dpad'],
  ['Refresh stream', 'tool.reload'],
  ['copy device selection to host clipboard', 'tool.copy'],
  ['push host clipboard to device', 'tool.paste'],
]);

// Settings come from localStorage and are validated before they reach the
// engine — a stale/tampered value must not break the stream or the UI.
let settings = loadSettings(localStorage);
let ladder = sizeLadder(settings);
let lang = effectiveLanguage(settings, navigator.language);
let screenState = {};
let lockMessage = '';
let statusKey = 'status.connecting';
let statusVars = {};

function t(key, vars) {
  return translate(lang, key, vars);
}

const GEAR_SVG = '<svg viewBox="0 0 24 24" width="48" height="48" aria-hidden="true">' +
  '<path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.15 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.05.31-.08.63-.08.94s.03.63.08.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.61.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.09.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/>' +
  '</svg>';

const overlay = document.getElementById('settings-overlay');
const formFields = {
  resolution: document.getElementById('set-resolution'),
  maxFps: document.getElementById('set-fps'),
  bitrate: document.getElementById('set-bitrate'),
  audio: document.getElementById('set-audio'),
  language: document.getElementById('set-language'),
};

function fillSettingsForm(values = settings) {
  formFields.resolution.value = values.resolution;
  formFields.maxFps.value = String(values.maxFps);
  formFields.bitrate.value = String(values.bitrate);
  formFields.audio.checked = values.audio;
  formFields.language.value = values.language;
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
    language: formFields.language.value,
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
document.getElementById('settings-apply').addEventListener('click', applySettings);

// Apply the active language to every static element, then rebuild the dynamic
// strings (status line, lock hint and toolbox labels) that depend on it.
function applyLanguage() {
  lang = effectiveLanguage(settings, navigator.language);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
  lockMessage = lockHint(screenState, lang);
  renderStatus();
  labelToolbox();
  localizeEngineDom();
}

// Every status update funnels through here as a key + variables, so a language
// switch re-renders the same message instead of a stale English string.
function renderStatus() {
  const text = t(statusKey, statusVars);
  statusEl.textContent = lockMessage ? `${lockMessage} — ${text}` : text;
}

function setStatus(key, vars) {
  statusKey = key;
  statusVars = vars ?? {};
  renderStatus();
}

// The toolbox is created by the engine once the player attaches, so it can
// appear after our first paint — and again after a stream restart. Label every
// copy as soon as it shows up, for as long as the page lives.
function labelToolbox() {
  const list = streamEl.querySelector('.control-buttons-list');
  if (!list) return;
  for (const el of list.querySelectorAll('.control-button')) {
    if (el.classList.contains('settings-button')) continue;
    // The engine's title is translated in place, so remember its original
    // English value before looking up our label key.
    const title = el.dataset.sourceTitle ?? el.getAttribute('title');
    const labelKey = TOOLBOX_LABELS.get(title);
    if (labelKey) el.setAttribute('data-label', t(labelKey));
  }
  addSettingsButton(list);
}

// The engine also puts English text in tooltips, the lock notice and the
// clipboard prompt. Translate those in place, keeping the original source so
// a later language switch can restore it. Only childList mutations are
// observed, so writing a text node here cannot retrigger the observer.
const engineTextSources = new WeakMap();
const engineAttrSources = new WeakMap();

function localizeEngineDom() {
  for (const el of streamEl.querySelectorAll('[title], [aria-label]')) {
    if (el.classList.contains('settings-button')) continue;
    let sources = engineAttrSources.get(el);
    if (!sources) {
      sources = new Map();
      engineAttrSources.set(el, sources);
    }
    for (const attr of ['title', 'aria-label']) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      if (!sources.has(attr)) {
        if (!ENGINE_TEXT_KEYS[value]) continue;
        sources.set(attr, value);
        if (attr === 'title') el.dataset.sourceTitle = value;
      }
      const key = ENGINE_TEXT_KEYS[sources.get(attr)];
      if (key) el.setAttribute(attr, t(key));
    }
  }

  const walker = document.createTreeWalker(streamEl, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    let source = engineTextSources.get(node);
    if (source === undefined) {
      const value = node.nodeValue.trim();
      if (!ENGINE_TEXT_KEYS[value]) continue;
      source = value;
      engineTextSources.set(node, source);
    }
    const key = ENGINE_TEXT_KEYS[source];
    if (key) node.nodeValue = node.nodeValue.replace(source, t(key));
  }

  localizeStatsCanvas();
}

// Quality stats are painted with fillText on the touch canvas, not in the DOM.
// Wrap that canvas's context so the engine keeps drawing its numbers but the
// labels come out in the active language. The closure reads `lang` at draw
// time, so a language switch needs no re-patching.
const patchedStatsCanvases = new WeakSet();

function localizeStatsCanvas() {
  const canvas = streamEl.querySelector('canvas.touch-layer');
  if (!canvas || patchedStatsCanvases.has(canvas)) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const originalFillText = ctx.fillText.bind(ctx);
  ctx.fillText = (text, x, y, ...rest) => originalFillText(translateStatLine(text, lang), x, y, ...rest);
  patchedStatsCanvases.add(canvas);
}

// The engine owns the rail, so our entry is injected into its DOM. It is a
// plain toolbox button (same class/label rules), just with our own handler.
function addSettingsButton(list) {
  let button = list.querySelector('.settings-button');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'control-button settings-button';
    button.innerHTML = GEAR_SVG;
    button.addEventListener('click', openSettings);
    list.appendChild(button);
  }
  button.title = t('settings.title');
  button.dataset.label = t('tool.settings');
  button.setAttribute('aria-label', t('settings.title'));
}

const toolboxObserver = new MutationObserver(() => {
  labelToolbox();
  localizeEngineDom();
});
toolboxObserver.observe(streamEl, { childList: true, subtree: true });

async function pollScreenState() {
  try {
    // Same origin as the page (port 8000), so no CORS or bridge is involved.
    const res = await fetch(`/api/devices/screen-state?udid=${encodeURIComponent(DEVICE_ID)}`);
    if (!res.ok) return;
    screenState = await res.json();
    const hint = lockHint(screenState, lang);
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
    const keyName = t(`key.${key}`);
    try {
      const res = await fetch(BRIDGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (res.status === 503) {
        setStatus('status.offline');
        return;
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        setStatus('status.keyFailed', {
          key: keyName,
          code: res.status,
          detail: detail.error ? ` — ${detail.error}` : '',
        });
        return;
      }
      setStatus('status.keySent', { key: keyName });
    } catch (err) {
      setStatus('status.bridgeDown', { error: messageOf(err) });
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
      setStatus('status.retrying', { resolution: info.resolution });
      try {
        window.phoneLinkHandle?.stop();
      } catch {
        // The session is already gone; starting a new one is all that matters.
      }
      setTimeout(startStream, RETRY_DELAY_MS);
      return;
    }
    const resolution = info?.resolution ? ` — ${info.resolution}` : '';
    setStatus('status.connected', {
      resolution: `${resolution}${degraded ? t('status.lowRes') : ''}`,
    });
  };
  options.onDisconnect = (reason) => {
    if (gen !== generation) return;
    setStatus('status.disconnected', { reason: reason ? ` — ${reason}` : '' });
  };
  options.onError = (err) => {
    if (gen !== generation) return;
    setStatus('status.error', { error: messageOf(err) });
  };

  window.phoneLinkHandle = window.WsScrcpy.startStream(streamEl, DEVICE_ID, options);
}

function applySettings() {
  settings = saveSettings(localStorage, readSettingsForm());
  ladder = sizeLadder(settings);
  applyLanguage();
  closeSettings();
  generation += 1; // ignore the old stream's late callbacks
  attempts = 0;
  try {
    window.phoneLinkHandle?.stop();
  } catch {
    // It may already be gone; the new session is what matters.
  }
  if (!isUsableContext(location.protocol, location.hostname) || !window.WsScrcpy) {
    setStatus('status.engineDown');
    return;
  }
  setStatus('status.applying');
  setTimeout(startStream, 250);
}

applyLanguage();

if (!isUsableContext(location.protocol, location.hostname)) {
  setStatus('status.insecure');
} else if (!window.WsScrcpy || typeof window.WsScrcpy.startStream !== 'function') {
  setStatus('status.engineDown');
} else {
  setStatus('status.connectPhone');
  try {
    startStream();
  } catch (err) {
    setStatus('status.engineDownError', { error: messageOf(err) });
  }
}
