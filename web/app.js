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
const BRIDGE_BASE = 'http://127.0.0.1:8100';
const BRIDGE_URL = `${BRIDGE_BASE}/keyevent`;
const CHAT_CONFIG_URL = `${BRIDGE_BASE}/api/chat-config`;
const CHAT_URL = `${BRIDGE_BASE}/chat`;
const SCREEN_STATE_POLL_MS = 3000;

const streamEl = document.getElementById('stream');
const statusEl = document.getElementById('status');

// The browser menu must never pop up over the mirrored phone: the engine uses
// right-click as the phone's Back button, and a native menu would swallow the
// click and cover the picture. Keep the mousedown control, drop only the menu.
document.addEventListener('contextmenu', (event) => event.preventDefault());

// Wheel-scroll amplitude: a single wheel tick maps to `wheelSteps` times the
// engine's default scroll distance. The engine reads window.__wheelScrollScale
// (patched in via scripts/setup.mjs), so changing the setting takes effect
// immediately without re-dispatching N events or restarting the stream.
function applyWheelScale() {
  window.__wheelScrollScale = Math.max(1, Number(settings.wheelSteps) || 1);
}

// The engine builds its own toolbox (screenshot, clipboard, stats, input
// modes). Its icons carry an English tooltip but no visible text, so the
// labels are mapped here to translation keys and rendered via data-label.
const TOOLBOX_LABELS = new Map([
  ['Power', 'engine.power'],
  ['Volume up', 'engine.volumeUp'],
  ['Volume down', 'engine.volumeDown'],
  ['Back', 'engine.back'],
  ['Home', 'engine.home'],
  ['Overview', 'engine.overview'],
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
applyWheelScale();
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
  uiFontSize: document.getElementById('set-ui-font-size'),
  uiFontColor: document.getElementById('set-ui-font-color'),
  statsFontSize: document.getElementById('set-stats-font-size'),
  statsFontColor: document.getElementById('set-stats-font-color'),
  railScale: document.getElementById('set-rail-scale'),
  statusScale: document.getElementById('set-status-scale'),
  navButtonMode: document.getElementById('set-nav-button-mode'),
  wheelSteps: document.getElementById('set-wheel-steps'),
  volume: document.getElementById('set-volume'),
};

function fillSettingsForm(values = settings) {
  formFields.resolution.value = values.resolution;
  formFields.maxFps.value = String(values.maxFps);
  formFields.bitrate.value = String(values.bitrate);
  formFields.audio.checked = values.audio;
  formFields.volume.value = String(values.volume ?? 100);
  formFields.language.value = values.language;
  formFields.uiFontSize.value = String(values.uiFontSize);
  formFields.uiFontColor.value = values.uiFontColor;
  formFields.statsFontSize.value = String(values.statsFontSize);
  formFields.statsFontColor.value = values.statsFontColor;
  formFields.railScale.value = String(values.railScale);
  formFields.statusScale.value = String(values.statusScale);
  formFields.navButtonMode.value = values.navButtonMode;
  formFields.wheelSteps.value = String(values.wheelSteps);
}

function openSettings() {
  fillSettingsForm();
  fillChatForm();
  overlay.hidden = false;
  formFields.resolution.focus();
}

function closeSettings() {
  overlay.hidden = true;
}

// Windowed/letterboxed fullscreen for the phone picture only: the tool rail
// is hidden so nothing sits beside the mirrored screen.
const fullscreenToggle = document.getElementById('fullscreen-toggle');

function setFullscreen(active) {
  document.body.classList.toggle('screen-fullscreen', active);
  const label = t(active ? 'fullscreen.exit' : 'fullscreen.enter');
  fullscreenToggle.title = label;
  fullscreenToggle.setAttribute('aria-label', label);
}

fullscreenToggle.addEventListener('click', () => {
  setFullscreen(!document.body.classList.contains('screen-fullscreen'));
});

// Phone audio plays in the browser via the engine's AudioPlayer; its volume is
// a browser-local setting (0..100) applied immediately, no stream restart.
function applyAudioVolume() {
  const v = Math.max(0, Math.min(1, Number(settings.volume ?? 100) / 100));
  window.phoneLinkHandle?.setAudioVolume?.(v);
}
document.getElementById('set-volume').addEventListener('input', (event) => {
  const v = Number(event.target.value);
  window.phoneLinkHandle?.setAudioVolume?.(v / 100);
});

function readSettingsForm() {
  return normalizeSettings({
    resolution: formFields.resolution.value,
    maxFps: Number(formFields.maxFps.value),
    bitrate: Number(formFields.bitrate.value),
    audio: formFields.audio.checked,
    language: formFields.language.value,
    uiFontSize: Number(formFields.uiFontSize.value),
    uiFontColor: formFields.uiFontColor.value,
    statsFontSize: Number(formFields.statsFontSize.value),
    statsFontColor: formFields.statsFontColor.value,
    railScale: Number(formFields.railScale.value),
    statusScale: Number(formFields.statusScale.value),
    navButtonMode: formFields.navButtonMode.value,
    wheelSteps: Number(formFields.wheelSteps.value),
    volume: Number(formFields.volume.value),
  });
}

document.getElementById('settings-close').addEventListener('click', closeSettings);
overlay.addEventListener('click', (event) => {
  if (event.target === overlay) closeSettings();
});
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!overlay.hidden) closeSettings();
  else if (!chatPanel.hidden) chatPanel.hidden = true;
  else if (document.body.classList.contains('screen-fullscreen')) setFullscreen(false);
});
document.getElementById('settings-reset').addEventListener('click', () => {
  fillSettingsForm(DEFAULT_SETTINGS);
});
document.getElementById('settings-apply').addEventListener('click', applySettings);

function applyTypography() {
  applyWheelScale();
  const root = document.documentElement;
  root.style.setProperty('--ui-font-scale', String(settings.uiFontSize));
  root.style.setProperty('--ui-text-color', settings.uiFontColor);
  root.style.setProperty('--rail-scale', String(settings.railScale));
  root.style.setProperty('--status-scale', String(settings.statusScale));
  document.body.classList.toggle('nav-icon-only', settings.navButtonMode === 'icon');
  document.body.classList.toggle('nav-text-only', settings.navButtonMode === 'text');
  statsFontScale = settings.statsFontSize;
  statsFontColor = settings.statsFontColor;
}

// Apply the active language to every static element, then rebuild the dynamic
// strings (status line, lock hint and toolbox labels) that depend on it.
function applyLanguage() {
  lang = effectiveLanguage(settings, navigator.language);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  applyTypography();
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  }
  lockMessage = lockHint(screenState, lang);
  renderStatus();
  setFullscreen(document.body.classList.contains('screen-fullscreen'));
  labelToolbox();
  localizeEngineDom();
  updateChatLabels();
  renderChatStatus();
  renderChatSaveStatus();
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
  swapStatsAndDpad(list);
  addSettingsButton(list);
}

// The engine emits the stats toggle before the touch/D-pad toggle. Put touch
// first, moving each label together with its hidden checkbox. Mark the list so
// the MutationObserver does not repeat (or fight with) this rearrangement.
function swapStatsAndDpad(list) {
  if (list.dataset.swapped === '1') return;
  const find = (key) => [...list.querySelectorAll('label.control-button')].find((el) => {
    const title = el.dataset.sourceTitle ?? el.getAttribute('title');
    return TOOLBOX_LABELS.get(title) === key;
  });
  const statsLabel = find('tool.stats');
  const dpadLabel = find('tool.dpad');
  if (!statsLabel || !dpadLabel) return;
  const statsInput = statsLabel.previousElementSibling;
  const dpadInput = dpadLabel.previousElementSibling;
  if (!statsInput || statsInput.tagName !== 'INPUT' || !dpadInput || dpadInput.tagName !== 'INPUT') return;

  list.insertBefore(dpadLabel, statsInput);
  list.insertBefore(dpadInput, dpadLabel);
  list.dataset.swapped = '1';
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
let statsFontScale = 1;
let statsFontColor = '';

// The engine sets ctx.font/fillStyle before drawing each stats line. Wrap the
// drawing calls so our size/color win for those lines only; the engine's own
// values are restored immediately afterwards.
function withStatsFont(ctx, draw) {
  const font = ctx.font;
  if (statsFontScale !== 1) {
    const match = /(\d+(?:\.\d+)?)px/.exec(font);
    if (match) {
      const size = (Number(match[1]) * statsFontScale).toFixed(1);
      ctx.font = font.replace(match[0], `${size}px`);
    }
  }
  try {
    return draw();
  } finally {
    ctx.font = font;
  }
}

function localizeStatsCanvas() {
  const canvas = streamEl.querySelector('canvas.touch-layer');
  if (!canvas || patchedStatsCanvases.has(canvas)) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const originalFillText = ctx.fillText.bind(ctx);
  const originalMeasureText = ctx.measureText.bind(ctx);
  ctx.measureText = (text) => withStatsFont(ctx, () => originalMeasureText(translateStatLine(text, lang)));
  ctx.fillText = (text, x, y, ...rest) => {
    const color = ctx.fillStyle;
    if (statsFontColor) ctx.fillStyle = statsFontColor;
    try {
      return withStatsFont(ctx, () => originalFillText(translateStatLine(text, lang), x, y, ...rest));
    } finally {
      ctx.fillStyle = color;
    }
  };
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

// ---------------------------------------------------------------------------
// Chat. The configuration lives on the backend (/api/chat-config); this page
// only mirrors it. Chat is a separate entry point: every call here is guarded
// and reports into the chat panel only, so a broken chat can never take the
// stream, the toolbox or the key buttons down.
// ---------------------------------------------------------------------------
const CHAT_MAX_BUBBLES = 100;

const chatFab = document.getElementById('chat-fab');
const chatPanel = document.getElementById('chat-panel');
const chatMessagesEl = document.getElementById('chat-messages');
const chatEmptyEl = document.getElementById('chat-empty');
const chatStatusEl = document.getElementById('chat-status');
const chatInput = document.getElementById('chat-input');
const chatSendButton = document.getElementById('chat-send');
const chatSaveStatusEl = document.getElementById('chat-settings-status');
const chatFormFields = {
  enabled: document.getElementById('set-chat-enabled'),
  baseUrl: document.getElementById('set-chat-base-url'),
  model: document.getElementById('set-chat-model'),
  apiKey: document.getElementById('set-chat-api-key'),
  screenshot: document.getElementById('set-chat-screenshot'),
  maxSteps: document.getElementById('set-chat-max-steps'),
};

// Last publicConfig from the backend ({enabled, baseUrl, model, maxSteps,
// screenshot, hasApiKey}); null until the first GET succeeds. History is
// display-only and lives until reload, per the design doc.
let chatConfig = null;
let chatRunning = false;
let chatSaveStatus = { key: '', vars: {} };

function applyChatVisibility() {
  // Icon hidden while disabled: no entry point means no accidental 503s.
  const show = Boolean(chatConfig?.enabled);
  chatFab.hidden = !show;
  if (!show) chatPanel.hidden = true;
}

function updateChatLabels() {
  const label = t('chat.button');
  chatFab.title = label;
  chatFab.setAttribute('aria-label', label);
  // The backend never echoes the key back, only whether one is stored.
  chatFormFields.apiKey.placeholder = chatConfig?.hasApiKey
    ? t('chat.settings.apiKeySet')
    : t('chat.settings.apiKeyHint');
}

function renderChatStatus() {
  chatStatusEl.textContent = chatRunning ? t('chat.running') : '';
  chatSendButton.disabled = chatRunning;
  chatInput.disabled = chatRunning;
}

function renderChatSaveStatus() {
  chatSaveStatusEl.textContent = chatSaveStatus.key ? t(chatSaveStatus.key, chatSaveStatus.vars) : '';
}

function syncChatEmpty() {
  chatEmptyEl.hidden = Boolean(chatMessagesEl.querySelector('.chat-msg'));
}

function addChatBubble(kind, text, steps) {
  const bubble = document.createElement('div');
  bubble.className = `chat-msg chat-msg--${kind}`;
  const body = document.createElement('p');
  body.textContent = text;
  bubble.appendChild(body);
  if (Array.isArray(steps) && steps.length > 0) {
    const line = document.createElement('div');
    line.className = 'chat-steps';
    for (const step of steps) {
      const chip = document.createElement('span');
      chip.className = step.ok ? 'chat-step' : 'chat-step chat-step--fail';
      chip.textContent = `${step.tool ?? '?'} ${step.ok ? '✓' : '✗'}`;
      line.appendChild(chip);
    }
    bubble.appendChild(line);
  }
  chatMessagesEl.appendChild(bubble);
  // A long session only ever keeps the tail on screen.
  let count = chatMessagesEl.querySelectorAll('.chat-msg').length;
  while (count-- > CHAT_MAX_BUBBLES) {
    chatMessagesEl.querySelector('.chat-msg').remove();
  }
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  syncChatEmpty();
}

function chatErrorText(res, payload) {
  const error = typeof payload?.error === 'string' ? payload.error : '';
  if (error === 'chat disabled') return t('chat.error.disabled');
  if (error === 'chat unavailable') return t('chat.error.unavailable');
  return t('chat.error.request', { status: res.status, error });
}

async function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message || chatRunning) return;
  chatInput.value = '';
  addChatBubble('user', message);
  chatRunning = true;
  renderChatStatus();
  try {
    // lang carries the UI language so the backend answers in kind.
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, lang }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      addChatBubble('error', chatErrorText(res, payload));
    } else {
      // runAgentTurn always answers with a non-empty string; anything else
      // means the backend is not what we expect.
      const reply = typeof payload.reply === 'string' && payload.reply !== ''
        ? payload.reply
        : t('chat.error.unavailable');
      addChatBubble('assistant', reply, payload.steps);
    }
  } catch (err) {
    addChatBubble('error', t('chat.error.network', { error: messageOf(err) }));
  } finally {
    chatRunning = false;
    renderChatStatus();
    chatInput.focus();
  }
}

document.getElementById('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  sendChatMessage();
});
chatFab.addEventListener('click', () => {
  if (chatPanel.hidden) {
    chatPanel.hidden = false;
    chatInput.focus();
  } else {
    chatPanel.hidden = true;
  }
});
document.getElementById('chat-close').addEventListener('click', () => {
  chatPanel.hidden = true;
});
document.getElementById('chat-clear').addEventListener('click', () => {
  for (const el of chatMessagesEl.querySelectorAll('.chat-msg')) el.remove();
  syncChatEmpty();
  chatInput.focus();
});

async function refreshChatConfig() {
  try {
    const res = await fetch(CHAT_CONFIG_URL);
    chatConfig = res.ok ? await res.json() : null;
  } catch {
    // Bridge down: no chat icon, everything else unaffected.
    chatConfig = null;
  }
  applyChatVisibility();
  updateChatLabels();
}

function fillChatForm() {
  chatFormFields.enabled.checked = Boolean(chatConfig?.enabled);
  chatFormFields.baseUrl.value = chatConfig?.baseUrl ?? '';
  chatFormFields.model.value = chatConfig?.model ?? '';
  chatFormFields.apiKey.value = '';
  chatFormFields.screenshot.checked = chatConfig?.screenshot ?? true;
  chatFormFields.maxSteps.value = String(chatConfig?.maxSteps ?? 8);
  updateChatLabels();
}

async function saveChatSettings() {
  const patch = {
    enabled: chatFormFields.enabled.checked,
    baseUrl: chatFormFields.baseUrl.value.trim(),
    model: chatFormFields.model.value.trim(),
    screenshot: chatFormFields.screenshot.checked,
  };
  // Mirror the backend maxSteps policy: integers clamped to 1..32 (the
  // input's min/max), garbage dropped rather than posted. The key is sent
  // only when the user typed one, so the stored value survives every other
  // edit untouched.
  const maxSteps = Number.parseInt(chatFormFields.maxSteps.value, 10);
  if (Number.isFinite(maxSteps)) patch.maxSteps = Math.min(32, Math.max(1, maxSteps));
  if (chatFormFields.apiKey.value !== '') patch.apiKey = chatFormFields.apiKey.value;
  try {
    const res = await fetch(CHAT_CONFIG_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error ? `${res.status} — ${detail.error}` : String(res.status));
    }
    chatConfig = await res.json();
    applyChatVisibility();
    fillChatForm();
    chatSaveStatus = { key: 'chat.settings.saved', vars: {} };
  } catch (err) {
    chatSaveStatus = { key: 'chat.settings.saveFailed', vars: { error: messageOf(err) } };
  }
  renderChatSaveStatus();
}

document.getElementById('chat-settings-save').addEventListener('click', saveChatSettings);

refreshChatConfig();

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
    applyAudioVolume();
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
  applyAudioVolume();
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
