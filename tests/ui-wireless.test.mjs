import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as keys from '../shared/keys.mjs';
import { deferred, loadWirelessApp, response } from './ui-app-harness.mjs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test('wireless toolbar entry is injected beside the settings button', () => {
  assert.match(app, /function addWirelessButton\(list\)/);
  assert.match(app, /button\.className = 'control-button wireless-button'/);
  assert.match(app, /button\.addEventListener\('click', openWireless\)/);
  assert.match(app, /addSettingsButton\(list\);\s*addWirelessButton\(list\);/);
  assert.match(app, /button\.title = t\('wireless\.title'\)/);
  assert.match(app, /button\.dataset\.label = t\('tool\.wireless'\)/);
  assert.match(css, /#stream \.control-button\.wireless-button > svg/);
});

test('floating chat action leaves the toolbar rail clickable', () => {
  assert.match(css, /\.chat-fab\s*\{[^}]*right:\s*calc\(2\.75rem \* var\(--rail-scale, 1\) \+ 26px\);/);
  assert.match(css, /body\.chat-docked \.chat-fab\s*\{[^}]*right:\s*18px;/);
});

test('wireless modal contains every pairing, connect, action and warning control', () => {
  assert.match(html, /id="wireless-overlay"[^>]*hidden/);
  assert.match(html, /class="wireless-panel"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="wireless-title"/);
  for (const id of [
    'wireless-close',
    'wireless-status',
    'wireless-feedback',
    'wireless-pair-host',
    'wireless-pair-port',
    'wireless-pair-code',
    'wireless-connect-host',
    'wireless-connect-port',
    'wireless-submit',
    'wireless-usb',
    'wireless-clear',
    'wireless-warning',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is present`);
  }
  const codeTag = html.match(/<input[^>]*id="wireless-pair-code"[^>]*>/)?.[0];
  assert.ok(codeTag, 'pairing code input is present');
  assert.match(codeTag, /type="(?:text|password)"/);
  assert.match(codeTag, /maxlength="6"/);
  assert.match(html, /id="wireless-form"/);
  const submitTag = html.match(/<button[^>]*id="wireless-submit"[^>]*>/)?.[0];
  assert.ok(submitTag, 'pair submit button is present');
  assert.match(submitTag, /type="submit"/);
  assert.match(html, /id="wireless-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="wireless-feedback"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(css, /\.wireless-overlay\s*\{[^}]*position:\s*fixed;/);
  assert.match(css, /\.wireless-overlay\[hidden\]\s*\{[^}]*display:\s*none;/);
});

test('wireless toolbar button is excluded from engine-owned label translation', () => {
  assert.match(app, /function isAppToolbarButton\(el\)\s*\{[^}]*settings-button[^}]*wireless-button/s);
  const loopSkips = [...app.matchAll(/if \(isAppToolbarButton\(el\)\) continue;/g)];
  assert.equal(loopSkips.length, 2, 'toolbox labels and engine attributes must both skip app buttons');
});

test('stale wireless refreshes cannot overwrite a mode change or a newer refresh', async () => {
  assert.equal(typeof keys.createWirelessRequestGuard, 'function');
  const guard = keys.createWirelessRequestGuard();
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };

  const openingRefresh = deferred();
  const refreshPromise = guard.refresh(() => openingRefresh.promise);
  const pairRequest = deferred();
  const pairPromise = guard.mutate(() => pairRequest.promise);

  openingRefresh.resolve({ mode: 'usb', serial: 'old-usb', online: true });
  assert.deepEqual(await refreshPromise, { stale: true }, 'refresh started before pairing must be discarded');

  const refreshDuringPair = guard.refresh(() => Promise.resolve({ mode: 'usb', serial: 'stale-usb', online: true }));
  assert.deepEqual(await refreshDuringPair, { stale: true }, 'refreshes started during a mode change must be discarded');

  pairRequest.resolve({ mode: 'wifi', serial: '192.168.3.50:39541', online: true });
  assert.deepEqual(await pairPromise, {
    stale: false,
    value: { mode: 'wifi', serial: '192.168.3.50:39541', online: true },
  });

  const rejectedRefresh = guard.refresh(() => Promise.reject(new Error('old network failure')));
  const newerRefresh = deferred();
  const newerPromise = guard.refresh(() => newerRefresh.promise);
  assert.deepEqual(await rejectedRefresh, { stale: true }, 'an older failed refresh must not surface an error');
  newerRefresh.resolve({ mode: 'wifi', serial: '192.168.3.50:39541', online: true });
  assert.equal((await newerPromise).stale, false, 'the newest refresh remains current');
});

test('wireless request guard invalidates refreshes when a mode change completes', async () => {
  const guard = keys.createWirelessRequestGuard();
  const duringMutation = guard.refresh(() => Promise.resolve('ignored'));
  const usbRequest = Promise.resolve('usb');
  assert.equal((await guard.mutate(() => usbRequest)).value, 'usb');
  assert.deepEqual(await duringMutation, { stale: true });
});

test('wireless form persistence preserves every field, including the pairing code', () => {
  assert.equal(keys.WIRELESS_PAIRING_STORAGE_KEY, 'phone-link-wireless-pairing');
  assert.equal(typeof keys.loadWirelessPairing, 'function');
  assert.equal(typeof keys.saveWirelessPairing, 'function');
  assert.equal(typeof keys.clearWirelessPairing, 'function');

  const storage = memoryStorage();
  const form = {
    pairHost: '192.168.3.10',
    pairPort: '37123',
    pairCode: '654321',
    connectHost: '192.168.3.10',
    connectPort: '39541',
  };
  assert.deepEqual(keys.saveWirelessPairing(storage, form), { saved: true, values: form });
  assert.deepEqual(JSON.parse(storage.data.get('phone-link-wireless-pairing')), form);
  assert.deepEqual(keys.loadWirelessPairing(storage), form);
});

test('wireless form persistence tolerates missing, malformed and non-string values', () => {
  const empty = {
    pairHost: '',
    pairPort: '',
    pairCode: '',
    connectHost: '',
    connectPort: '',
  };
  const storage = memoryStorage();
  assert.deepEqual(keys.loadWirelessPairing(storage), empty);
  storage.data.set('phone-link-wireless-pairing', 'not json');
  assert.deepEqual(keys.loadWirelessPairing(storage), empty);
  storage.data.set('phone-link-wireless-pairing', JSON.stringify({ pairHost: 'phone.local', pairCode: 123456 }));
  assert.deepEqual(keys.loadWirelessPairing(storage), { ...empty, pairHost: 'phone.local' });
});

test('wireless form save reports success only when a storage provider accepts the write', () => {
  const values = { pairHost: 'phone.local', pairCode: '123456' };
  const normalized = {
    pairHost: 'phone.local', pairPort: '', pairCode: '123456', connectHost: '', connectPort: '',
  };
  assert.deepEqual(keys.saveWirelessPairing(undefined, values), { saved: false, values: normalized });
  assert.deepEqual(keys.saveWirelessPairing({}, values), { saved: false, values: normalized });
  assert.deepEqual(keys.saveWirelessPairing(() => { throw new Error('storage denied'); }, values), {
    saved: false, values: normalized,
  });

  const storage = memoryStorage();
  assert.deepEqual(keys.saveWirelessPairing(storage, values), { saved: true, values: normalized });
});

test('clear removes the saved wireless form and storage failures never break the UI', () => {
  const storage = memoryStorage();
  keys.saveWirelessPairing(storage, { pairHost: 'phone.local', pairCode: '123456' });
  assert.equal(keys.clearWirelessPairing(storage), true);
  assert.equal(storage.data.has('phone-link-wireless-pairing'), false);

  const unavailable = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.deepEqual(keys.loadWirelessPairing(unavailable), {
    pairHost: '', pairPort: '', pairCode: '', connectHost: '', connectPort: '',
  });
  assert.deepEqual(keys.saveWirelessPairing(unavailable, { pairCode: '123456' }), {
    saved: false,
    values: { pairHost: '', pairPort: '', pairCode: '123456', connectHost: '', connectPort: '' },
  });
  assert.equal(keys.clearWirelessPairing(unavailable), false);
});

test('failed wireless clear reports an error without claiming the code was removed', () => {
  assert.equal(typeof keys.clearWirelessPairingResult, 'function');
  const storage = memoryStorage();
  keys.saveWirelessPairing(storage, { pairCode: '654321' });
  storage.removeItem = () => { throw new Error('quota or security failure'); };

  assert.deepEqual(keys.clearWirelessPairingResult(storage), {
    cleared: false,
    feedbackKey: 'wireless.error.storage',
    isError: true,
  });
  assert.equal(storage.data.get('phone-link-wireless-pairing'), '{"pairHost":"","pairPort":"","pairCode":"654321","connectHost":"","connectPort":""}');

  const inaccessible = () => { throw new Error('localStorage getter denied'); };
  assert.deepEqual(keys.clearWirelessPairingResult(inaccessible), {
    cleared: false,
    feedbackKey: 'wireless.error.storage',
    isError: true,
  });
  assert.deepEqual(keys.loadWirelessPairing(inaccessible), {
    pairHost: '', pairPort: '', pairCode: '', connectHost: '', connectPort: '',
  });
  assert.equal(keys.saveWirelessPairing(inaccessible, { pairCode: '654321' }).values.pairCode, '654321');

  const successful = memoryStorage();
  keys.saveWirelessPairing(successful, { pairCode: '654321' });
  assert.deepEqual(keys.clearWirelessPairingResult(successful), {
    cleared: true,
    feedbackKey: 'wireless.cleared',
    isError: false,
  });
  assert.equal(successful.data.has('phone-link-wireless-pairing'), false);
  assert.match(keys.MESSAGES.en['wireless.error.storage'], /not removed/i);
  assert.match(keys.MESSAGES.zh['wireless.error.storage'], /未删除/);
});

test('wireless form automatically saves and reloads all inputs, and clear resets them', () => {
  assert.match(app, /loadWirelessPairing/);
  assert.match(app, /saveWirelessPairing/);
  assert.match(app, /clearWirelessPairingResult/);
  assert.match(app, /fillWirelessForm\(loadWirelessPairing\(\(\) => localStorage\)\)/);
  assert.match(app, /saveWirelessFormFromDom\(\)/);
  assert.match(app, /wirelessForm\.addEventListener\('input', saveWirelessFormFromDom\)/);
  assert.match(app, /for \(const field of WIRELESS_PAIRING_FIELDS\)\s*\{\s*values\[field\] = wirelessFields\[field\]\.value;/);
  assert.match(app, /wirelessClear\.addEventListener\('click', \(\) => \{[\s\S]*?clearWirelessPairingResult\(\(\) => localStorage\)[\s\S]*?if \(!result\.cleared\)[\s\S]*?fillWirelessForm\(DEFAULT_WIRELESS_PAIRING\);/);
});

test('wireless status and mode changes share the stale-response guard', () => {
  assert.match(app, /const wirelessRequests = createWirelessRequestGuard\(\);/);
  assert.match(app, /wirelessRequests\.refresh\(/);
  assert.equal([...app.matchAll(/wirelessRequests\.mutate\(/g)].length, 4, 'auto-fetch, pair, legacy and USB all exclude stale refreshes');
});

test('wireless panel calls the bridge APIs with the documented pairing payload', () => {
  assert.match(app, /const WIRELESS_STATUS_URL = `\$\{BRIDGE_BASE\}\/api\/wireless`;/);
  assert.match(app, /const WIRELESS_PAIR_URL = `\$\{BRIDGE_BASE\}\/api\/wireless\/pair`;/);
  assert.match(app, /const WIRELESS_USB_URL = `\$\{BRIDGE_BASE\}\/api\/wireless\/usb`;/);
  assert.match(app, /fetch\(WIRELESS_STATUS_URL\)/);
  assert.match(app, /fetch\(WIRELESS_PAIR_URL,\s*\{[\s\S]*?method: 'POST',[\s\S]*?body: JSON\.stringify\(body\)/);
  assert.match(app, /const body = \{[\s\S]*?pairHost:[\s\S]*?pairPort:[\s\S]*?pairCode:[\s\S]*?connectHost:[\s\S]*?connectPort:/);
  assert.match(app, /fetch\(WIRELESS_USB_URL,\s*\{[\s\S]*?method: 'POST'/);
});

test('successful pairing updates the active serial and uses the shared stream restart path', () => {
  assert.match(app, /function activateDevice\(serial\)\s*\{[\s\S]*?DEVICE_ID = serial;[\s\S]*?window\.__PHONE_SERIAL = serial;/);
  assert.match(app, /async function pairWireless\(\)\s*\{[\s\S]*?applyWirelessStatus\(payload\)[\s\S]*?activateDevice\(payload\.serial\)[\s\S]*?restartStream\('status\.applying'\);/);
  assert.match(app, /function restartStream\(statusKey = 'status\.applying'\)\s*\{[\s\S]*?generation \+= 1;[\s\S]*?attempts = 0;[\s\S]*?window\.phoneLinkHandle\?\.stop\(\);[\s\S]*?setTimeout\(startStream, 250\);/);
  assert.match(app, /function applySettings\(\)\s*\{[\s\S]*?restartStream\(\);/);
});

test('switching to USB updates the active serial and automatically restarts the stream', () => {
  assert.match(app, /async function switchToUsb\(\)\s*\{[\s\S]*?fetch\(WIRELESS_USB_URL,[\s\S]*?applyWirelessStatus\(payload\)[\s\S]*?activateDevice\(payload\.serial\)[\s\S]*?restartStream\('status\.applying'\);/);
});

test('wireless actions expose pending and error states instead of failing silently', () => {
  assert.match(app, /function setWirelessBusy\(busy\)\s*\{[\s\S]*?wirelessSubmit\.disabled = busy;[\s\S]*?wirelessUsb\.disabled = busy;/);
  assert.match(app, /function renderWirelessFeedback\(\)\s*\{[\s\S]*?wirelessFeedbackEl\.textContent = wirelessFeedbackKey[\s\S]*?classList\.toggle\('is-error', wirelessFeedbackIsError\);/);
  assert.match(app, /function wirelessRequestError\(res, payload\)/);
  assert.match(app, /setWirelessFeedback\('wireless\.error\.request'/);
  assert.match(app, /setWirelessFeedback\('wireless\.error\.network'/);
  assert.match(app, /setWirelessFeedback\('wireless\.error\.invalidResponse'/);
});

test('wireless storage failure is explicit, non-sensitive, and hides the plaintext persistence warning', () => {
  assert.match(html, /id="wireless-storage"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="wireless-warning"[^>]*hidden/);
  assert.match(app, /function saveWirelessFormFromDom\(\)\s*\{[\s\S]*?const result = saveWirelessPairing\(\(\) => localStorage, readWirelessForm\(\)\);[\s\S]*?wirelessWarning\.hidden = !result\.saved;/);
  assert.match(app, /if \(!result\.saved\)\s*\{\s*setWirelessStorageFeedback\('wireless\.error\.save'\);/);
  assert.match(keys.MESSAGES.en['wireless.error.save'], /pairing still works/i);
  assert.match(keys.MESSAGES.en['wireless.error.save'], /lost on reload/i);
  assert.match(keys.MESSAGES.zh['wireless.error.save'], /仍可.*配对/);
  assert.match(keys.MESSAGES.zh['wireless.error.save'], /刷新后丢失/);
});

test('wireless status refreshes only while the modal is visible', () => {
  assert.match(app, /function openWireless\(\)\s*\{[\s\S]*?refreshWirelessStatus\(\);[\s\S]*?wirelessRefreshTimer = setInterval\(refreshWirelessStatus, SCREEN_STATE_POLL_MS\);/);
  assert.match(app, /function closeWireless\(\)\s*\{[\s\S]*?clearInterval\(wirelessRefreshTimer\);/);
  assert.match(app, /wirelessRefreshTimer = null;/);
});

test('wireless pairing success requires an online wireless target before activating it', () => {
  assert.equal(typeof keys.isWirelessPairingSuccess, 'function');
  assert.equal(keys.isWirelessPairingSuccess({ mode: 'wifi', serial: 'phone.local:5555', online: true }), true);
  assert.equal(keys.isWirelessPairingSuccess({ mode: 'wifi', serial: 'phone.local:5555', online: false }), false);
  assert.equal(keys.isWirelessPairingSuccess({ mode: 'usb', serial: 'phone.local:5555', online: true }), false);
  assert.equal(keys.isWirelessPairingSuccess({ mode: 'wifi', serial: '', online: true }), false);
  assert.match(app, /if \(!isWirelessPairingSuccess\(payload\)\)\s*\{[\s\S]*?setWirelessFeedback\('wireless\.error\.offline'[\s\S]*?return;/);
});

test('screen-state polling discards responses for a device that is no longer active', () => {
  assert.match(app, /async function pollScreenState\(\)\s*\{[\s\S]*?const requestedDevice = DEVICE_ID;[\s\S]*?fetch\(`\/api\/devices\/screen-state\?udid=\$\{encodeURIComponent\(requestedDevice\)\}`\)[\s\S]*?if \(requestedDevice !== DEVICE_ID\) return;[\s\S]*?const nextState = await res\.json\(\);[\s\S]*?if \(requestedDevice !== DEVICE_ID\) return;[\s\S]*?screenState = nextState;/);
});

test('wireless modal traps Tab focus and restores the opening control on close', () => {
  assert.match(html, /class="wireless-panel"[^>]*tabindex="-1"/);
  assert.match(app, /function trapWirelessFocus\(event\)\s*\{[\s\S]*?event\.key !== 'Tab'[\s\S]*?wirelessPanel\.contains\(document\.activeElement\)[\s\S]*?first\.focus\(\)[\s\S]*?last\.focus\(\)/);
  assert.match(app, /wirelessOverlay\.addEventListener\('keydown', trapWirelessFocus\)/);
  assert.match(app, /function closeWireless\(\)\s*\{[\s\S]*?wirelessTrigger\.focus\(\);/);
});

test('all five wireless pairing and connect inputs are required', () => {
  for (const id of [
    'wireless-pair-host',
    'wireless-pair-port',
    'wireless-pair-code',
    'wireless-connect-host',
    'wireless-connect-port',
  ]) {
    const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `${id} input is present`);
    assert.match(tag, /\srequired(?:\s|>)/, `${id} must be required`);
  }
});

test('wireless security warning explicitly covers plaintext localStorage and the pairing code in both languages', () => {
  const en = keys.MESSAGES.en['wireless.warning'];
  const zh = keys.MESSAGES.zh['wireless.warning'];
  assert.match(en, /plain text/i);
  assert.match(en, /localStorage/);
  assert.match(en, /pairing code/i);
  assert.match(en, /expire/i);
  assert.match(zh, /明文/);
  assert.match(zh, /localStorage/);
  assert.match(zh, /配对码/);
  assert.match(zh, /过期/);
  assert.match(html, /id="wireless-warning"[^>]*data-i18n="wireless\.warning"/);
  assert.equal(keys.MESSAGES.en['tool.wireless'], 'WIFI');
  assert.equal(keys.MESSAGES.zh['tool.wireless'], '无线');
});

test('wireless modal exposes an initially disabled USB auto-fetch control with bilingual guidance', () => {
  const buttonTag = html.match(/<button[^>]*id="wireless-auto"[^>]*>/)?.[0];
  assert.ok(buttonTag, 'auto-fetch button is present');
  assert.match(buttonTag, /type="button"/);
  assert.match(buttonTag, /\sdisabled(?:\s|>)/);
  assert.match(buttonTag, /data-i18n="wireless\.auto"/);
  assert.match(html, /data-i18n="wireless\.autoHint"/);
  assert.match(css, /\.wireless-legend\s*\{[^}]*display:\s*flex;/);
  assert.match(css, /\.wireless-auto\.is-loading/);
  assert.equal(keys.MESSAGES.en['wireless.auto'], 'Auto-fetch over USB');
  assert.equal(keys.MESSAGES.zh['wireless.auto'], 'USB 自动获取');
  assert.match(keys.MESSAGES.en['wireless.autoHint'], /USB/);
  assert.match(keys.MESSAGES.en['wireless.autoHint'], /pairing code/i);
  assert.match(keys.MESSAGES.en['wireless.autoHint'], /manually/i);
  assert.match(keys.MESSAGES.zh['wireless.autoHint'], /USB/);
  assert.match(keys.MESSAGES.zh['wireless.autoHint'], /配对码/);
  assert.match(keys.MESSAGES.zh['wireless.autoHint'], /手动/);
});

test('wireless auto result parser accepts a full response without accepting a pairing code', () => {
  assert.equal(typeof keys.parseWirelessAutoResult, 'function');
  assert.deepEqual(keys.parseWirelessAutoResult({
    usbSerial: 'USB123456',
    pairHost: '192.168.3.10',
    pairPort: 43127,
    connectHost: '192.168.3.10',
    connectPort: 39541,
    warnings: [],
    pairCode: '654321',
  }), {
    usbSerial: 'USB123456',
    updates: {
      pairHost: '192.168.3.10',
      pairPort: '43127',
      connectHost: '192.168.3.10',
      connectPort: '39541',
    },
    warnings: [],
    complete: true,
  });
});

test('wireless auto result parser preserves useful partial data and warnings', () => {
  assert.equal(typeof keys.parseWirelessAutoResult, 'function');
  assert.deepEqual(keys.parseWirelessAutoResult({
    usbSerial: 'USB123456',
    pairHost: '192.168.3.10',
    pairPort: null,
    connectHost: '192.168.3.10',
    connectPort: null,
    warnings: ['PAIRING_PORT_UNAVAILABLE', 'CONNECT_PORT_UNAVAILABLE'],
  }), {
    usbSerial: 'USB123456',
    updates: {
      pairHost: '192.168.3.10',
      connectHost: '192.168.3.10',
    },
    warnings: ['PAIRING_PORT_UNAVAILABLE', 'CONNECT_PORT_UNAVAILABLE'],
    complete: false,
  });
});

test('wireless auto result parser rejects malformed envelopes and unsafe field values', () => {
  assert.equal(typeof keys.parseWirelessAutoResult, 'function');
  for (const payload of [
    null,
    {},
    { usbSerial: '', warnings: [] },
    { usbSerial: 'USB123456', warnings: 'not an array' },
  ]) {
    assert.equal(keys.parseWirelessAutoResult(payload), null);
  }
  assert.deepEqual(keys.parseWirelessAutoResult({
    usbSerial: 'USB123456',
    pairHost: 'not a host',
    pairPort: 0,
    connectHost: '192.168.3.10',
    connectPort: '39541',
    warnings: ['PAIRING_PORT_UNAVAILABLE', 'Untranslated English warning', '', 42, 'PAIRING_PORT_UNAVAILABLE'],
  }), {
    usbSerial: 'USB123456',
    updates: { connectHost: '192.168.3.10' },
    warnings: ['PAIRING_PORT_UNAVAILABLE'],
    complete: false,
  });
});

test('wireless auto warning codes map to bilingual messages instead of verbatim backend English', () => {
  assert.equal(typeof keys.wirelessAutoWarningKey, 'function');
  assert.equal(keys.wirelessAutoWarningKey('WIFI_IP_UNAVAILABLE'), 'wireless.warning.wifiIpUnavailable');
  assert.equal(keys.wirelessAutoWarningKey('CONNECT_PORT_UNAVAILABLE'), 'wireless.warning.connectPortUnavailable');
  assert.equal(keys.wirelessAutoWarningKey('PAIRING_PORT_UNAVAILABLE'), 'wireless.warning.pairingPortUnavailable');
  assert.equal(keys.wirelessAutoWarningKey('UNKNOWN'), null);
  assert.equal(
    keys.translate('en', keys.wirelessAutoWarningKey('WIFI_IP_UNAVAILABLE')),
    'Could not read the phone Wi-Fi IP address.',
  );
  assert.match(keys.translate('zh', keys.wirelessAutoWarningKey('CONNECT_PORT_UNAVAILABLE')), /连接端口/);
  assert.match(keys.translate('zh', keys.wirelessAutoWarningKey('PAIRING_PORT_UNAVAILABLE')), /配对端口/);
});

function wirelessHarnessStorage(form = {}, language = 'en') {
  const storage = memoryStorage();
  storage.setItem(keys.SETTINGS_STORAGE_KEY, JSON.stringify({ language }));
  storage.setItem(keys.WIRELESS_PAIRING_STORAGE_KEY, JSON.stringify({
    pairHost: '', pairPort: '', pairCode: '', connectHost: '', connectPort: '', ...form,
  }));
  return storage;
}

const AUTO_FULL_RESULT = Object.freeze({
  usbSerial: 'USB123456',
  pairHost: '192.168.3.10',
  pairPort: 43127,
  connectHost: '192.168.3.10',
  connectPort: 39541,
  warnings: [],
  pairCode: '999999',
});

test('wireless auto-fetch behavior: full result merges, persists, focuses the code and restores controls', async () => {
  const savedForm = {
    pairHost: 'old.local', pairPort: '11111', pairCode: '654321', connectHost: 'old.local', connectPort: '22222',
  };
  const storage = wirelessHarnessStorage(savedForm);
  const pendingAuto = deferred();
  const app = await loadWirelessApp({ storage, autoResponse: () => pendingAuto.promise });

  assert.equal(app.api.buttons.auto.disabled, true, 'auto-fetch starts disabled until USB status is known');
  await app.api.refreshWirelessStatus();
  assert.equal(app.api.buttons.auto.disabled, false);
  assert.deepEqual(app.api.readWirelessForm(), savedForm, 'the saved form is restored before opening');

  app.api.fields.pairHost.focus();
  app.api.openWireless();
  await app.ready();
  assert.equal(app.document.activeElement, app.api.fields.pairHost, 'opening focuses the first pairing field');

  const clicking = app.api.buttons.auto.click();
  await app.ready();
  assert.equal(app.api.buttons.auto.disabled, true);
  assert.equal(app.api.buttons.auto.classList.contains('is-loading'), true);
  assert.equal(app.api.buttons.auto.getAttribute('aria-busy'), 'true');
  assert.equal(app.api.buttons.submit.disabled, true);
  assert.equal(app.api.buttons.usb.disabled, true);
  assert.equal(app.api.buttons.clear.disabled, true);
  assert.equal(app.api.feedback.textContent, keys.MESSAGES.en['wireless.auto.loading']);

  const autoRequest = app.requests.find((request) => request.url.endsWith('/api/wireless/auto'));
  assert.equal(autoRequest.options.method, 'POST');
  assert.equal(autoRequest.options.body, '{}');
  assert.equal(app.requests.some((request) => request.url.endsWith('/api/wireless/pair')), false);

  pendingAuto.resolve(response(200, AUTO_FULL_RESULT));
  await clicking;

  assert.deepEqual(app.api.readWirelessForm(), {
    pairHost: '192.168.3.10', pairPort: '43127', pairCode: '654321', connectHost: '192.168.3.10', connectPort: '39541',
  });
  assert.deepEqual(JSON.parse(storage.data.get(keys.WIRELESS_PAIRING_STORAGE_KEY)), app.api.readWirelessForm());
  assert.equal(app.api.feedback.textContent, keys.MESSAGES.en['wireless.auto.fetched']);
  assert.equal(app.api.feedback.classList.contains('is-success'), true);
  assert.equal(app.document.activeElement, app.api.fields.pairCode);
  assert.equal(app.api.buttons.auto.disabled, false);
  assert.equal(app.api.buttons.auto.classList.contains('is-loading'), false);
  assert.equal(app.api.buttons.auto.getAttribute('aria-busy'), 'false');
  assert.equal(app.api.buttons.submit.disabled, false);

  app.api.closeWireless();
  assert.equal(app.document.activeElement, app.api.fields.pairHost, 'closing restores the opening control');

  const reloaded = await loadWirelessApp({ storage });
  assert.deepEqual(reloaded.api.readWirelessForm(), app.api.readWirelessForm(), 'fetched fields survive reload');
});

test('wireless auto-fetch behavior: partial result keeps useful and existing fields and shows translated warnings', async () => {
  const storage = wirelessHarnessStorage({
    pairHost: 'old.local', pairPort: '11111', pairCode: '654321', connectHost: 'old.local', connectPort: '22222',
  });
  const app = await loadWirelessApp({
    storage,
    autoResponse: response(200, {
      usbSerial: 'USB123456',
      pairHost: '192.168.3.10',
      pairPort: null,
      connectHost: '192.168.3.10',
      connectPort: null,
      warnings: ['PAIRING_PORT_UNAVAILABLE', 'CONNECT_PORT_UNAVAILABLE'],
    }),
  });
  await app.api.refreshWirelessStatus();

  await app.api.autoFetchWireless();

  assert.deepEqual(app.api.readWirelessForm(), {
    pairHost: '192.168.3.10', pairPort: '11111', pairCode: '654321', connectHost: '192.168.3.10', connectPort: '22222',
  });
  const expectedWarnings = [
    keys.MESSAGES.en['wireless.warning.pairingPortUnavailable'],
    keys.MESSAGES.en['wireless.warning.connectPortUnavailable'],
  ].join(' ');
  assert.equal(
    app.api.feedback.textContent,
    keys.translate('en', 'wireless.auto.partial', { warnings: ` ${expectedWarnings}` }),
  );
  assert.equal(app.api.feedback.classList.contains('is-warning'), true);
  assert.equal(app.document.activeElement, app.api.fields.pairCode);
  assert.equal(app.requests.some((request) => request.url.endsWith('/api/wireless/pair')), false);
});

test('wireless auto-fetch behavior: warning codes are localized in Chinese', async () => {
  const app = await loadWirelessApp({
    storage: wirelessHarnessStorage({}, 'zh'),
    autoResponse: response(200, {
      usbSerial: 'USB123456',
      pairHost: '192.168.3.10',
      pairPort: null,
      connectHost: '192.168.3.10',
      connectPort: 39541,
      warnings: ['PAIRING_PORT_UNAVAILABLE'],
    }),
  });
  await app.api.refreshWirelessStatus();

  await app.api.autoFetchWireless();

  assert.match(app.api.feedback.textContent, /仅获取到部分无线调试信息/);
  assert.match(app.api.feedback.textContent, /配对端口/);
  assert.doesNotMatch(app.api.feedback.textContent, /PAIRING_PORT_UNAVAILABLE|unavailable/);
});

test('wireless auto-fetch behavior: a 409 preserves the form, reports offline and disables further fetches', async () => {
  const savedForm = {
    pairHost: 'old.local', pairPort: '11111', pairCode: '654321', connectHost: 'old.local', connectPort: '22222',
  };
  const storage = wirelessHarnessStorage(savedForm);
  const app = await loadWirelessApp({ storage, autoResponse: response(409, { error: 'USB device is offline' }) });
  await app.api.refreshWirelessStatus();
  app.api.fields.pairHost.focus();

  await app.api.autoFetchWireless();

  assert.deepEqual(app.api.readWirelessForm(), savedForm);
  assert.equal(app.api.feedback.textContent, keys.MESSAGES.en['wireless.error.usbOffline']);
  assert.equal(app.api.feedback.classList.contains('is-error'), true);
  assert.equal(app.api.buttons.auto.disabled, true);
  assert.equal(app.api.buttons.auto.getAttribute('aria-busy'), 'false');
  assert.equal(app.document.activeElement, app.api.fields.pairHost);

  const requestsBefore = app.requests.length;
  await app.api.buttons.auto.click();
  await app.api.autoFetchWireless();
  assert.equal(app.requests.length, requestsBefore, 'a disabled/offline control cannot issue another request');
});

test('wireless auto-fetch behavior: disabled state follows USB availability and form input persists', async () => {
  const storage = wirelessHarnessStorage();
  const app = await loadWirelessApp({ storage, usbOnline: false });

  assert.equal(app.api.buttons.auto.disabled, true);
  const requestsBefore = app.requests.length;
  await app.api.autoFetchWireless();
  assert.equal(app.requests.length, requestsBefore);

  app.api.applyWirelessStatus({ mode: 'usb', serial: 'USB123456', online: true, usbOnline: false });
  assert.equal(app.api.buttons.auto.disabled, true);
  app.api.applyWirelessStatus({ mode: 'usb', serial: 'USB123456', online: true, usbOnline: true });
  assert.equal(app.api.buttons.auto.disabled, false);

  app.api.fields.pairPort.value = '37123';
  await app.api.form.dispatch('input');
  assert.equal(JSON.parse(storage.data.get(keys.WIRELESS_PAIRING_STORAGE_KEY)).pairPort, '37123');
  assert.equal(app.api.warning.hidden, false, 'a successful save shows the plaintext-storage warning');

  const reloaded = await loadWirelessApp({ storage });
  assert.equal(reloaded.api.fields.pairPort.value, '37123');
});

function winningWirelessAutoCursor(loading) {
  let winner = { specificity: [-1, -1, -1], cursor: null };
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const cursor = /cursor:\s*([^;]+);/.exec(rule[2])?.[1];
    if (!cursor) continue;
    for (const rawSelector of rule[1].split(',')) {
      const selector = rawSelector.trim();
      if (selector.includes(':hover')) continue;
      if (selector.includes('.is-loading') && !loading) continue;
      if (!selector.includes('.wireless-auto') && selector !== '.wireless-panel button:disabled') continue;
      const specificity = [
        (selector.match(/#[\w-]+/g) ?? []).length,
        (selector.match(/\.[\w-]+|:[\w-]+/g) ?? []).length,
        (selector.match(/(?:^|[\s>+~])([a-z][\w-]*)/gi) ?? []).length,
      ];
      const wins = specificity[0] > winner.specificity[0]
        || (specificity[0] === winner.specificity[0] && specificity[1] > winner.specificity[1])
        || (specificity[0] === winner.specificity[0] && specificity[1] === winner.specificity[1]
          && specificity[2] >= winner.specificity[2]);
      if (wins) winner = { specificity, cursor };
    }
  }
  return winner.cursor;
}

test('disabled wireless auto-fetch styling is muted and not-allowed while loading keeps a progress cursor', () => {
  const disabledRule = css.match(/\.wireless-auto:disabled\s*\{([^}]*)\}/)?.[1];
  assert.ok(disabledRule, 'auto-fetch has an explicit disabled style');
  assert.match(disabledRule, /cursor:\s*not-allowed;/);
  assert.match(disabledRule, /opacity:\s*0?\.\d+;/);
  assert.match(disabledRule, /background:\s*#1b2a3d;/);
  const loadingRule = css.match(/\.wireless-panel \.wireless-auto\.is-loading:disabled\s*\{([^}]*)\}/)?.[1];
  assert.ok(loadingRule, 'loading has a separate cursor');
  assert.match(loadingRule, /cursor:\s*progress;/);
  assert.equal(winningWirelessAutoCursor(false), 'not-allowed', 'the generic disabled-button rule must not override the cursor');
  assert.equal(winningWirelessAutoCursor(true), 'progress');
});

// --- Dual-mode wireless panel (pairing code + legacy tcpip) -----------------

const LEGACY_ONLINE_STATUS = Object.freeze({
  mode: 'wifi',
  method: 'legacy',
  serial: '192.168.3.50:5555',
  online: true,
  usbOnline: true,
});

function legacyHarnessStorage(form = {}, mode = {}, language = 'en') {
  const storage = memoryStorage();
  storage.setItem(keys.SETTINGS_STORAGE_KEY, JSON.stringify({ language }));
  storage.setItem(keys.WIRELESS_PAIRING_STORAGE_KEY, JSON.stringify({
    pairHost: '', pairPort: '', pairCode: '', connectHost: '', connectPort: '',
    method: 'pair', legacyHost: '', legacyPort: '5555',
    ...form, ...mode,
  }));
  return storage;
}

function legacyDom(app) {
  const byId = (id) => app.document.getElementById(id);
  return {
    mode: byId('wireless-mode'),
    pairSection: byId('wireless-pair-section'),
    legacySection: byId('wireless-legacy-section'),
    legacyWarning: byId('wireless-legacy-warning'),
    host: byId('wireless-legacy-host'),
    port: byId('wireless-legacy-port'),
    auto: byId('wireless-legacy-auto'),
    connect: byId('wireless-legacy-connect'),
    status: byId('status'),
  };
}

test('wireless modal exposes a dual-mode selector with a hidden legacy form and default port 5555', () => {
  const modeTag = html.match(/<select[^>]*id="wireless-mode"[^>]*>/)?.[0];
  assert.ok(modeTag, 'mode selector is present');
  assert.match(modeTag, /name="method"/);
  assert.match(html, /<option value="pair"[^>]*data-i18n="wireless\.mode\.pair"/);
  assert.match(html, /<option value="legacy"[^>]*data-i18n="wireless\.mode\.legacy"/);
  assert.match(html, /id="wireless-pair-section"/);
  assert.match(html, /id="wireless-legacy-section"[^>]*hidden/);
  for (const id of [
    'wireless-legacy-host', 'wireless-legacy-port', 'wireless-legacy-auto',
    'wireless-legacy-connect', 'wireless-legacy-warning',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is present`);
  }
  const portTag = html.match(/<input[^>]*id="wireless-legacy-port"[^>]*>/)?.[0];
  assert.ok(portTag, 'legacy port input is present');
  assert.match(portTag, /type="number"/);
  assert.match(portTag, /value="5555"/);
  assert.match(portTag, /min="1"/);
  assert.match(portTag, /max="65535"/);
  assert.match(portTag, /\srequired(?:\s|>)/);
  const hostTag = html.match(/<input[^>]*id="wireless-legacy-host"[^>]*>/)?.[0];
  assert.match(hostTag, /\srequired(?:\s|>)/);
  const autoTag = html.match(/<button[^>]*id="wireless-legacy-auto"[^>]*>/)?.[0];
  assert.match(autoTag, /type="button"/);
  assert.match(autoTag, /\sdisabled(?:\s|>)/);
  assert.match(autoTag, /data-i18n="wireless\.legacyAuto"/);
  assert.match(html, /id="wireless-legacy-warning"[^>]*data-i18n="wireless\.legacyWarning"/);
  assert.match(css, /\.wireless-section\[hidden\]\s*\{[^}]*display:\s*none;/);
  assert.match(css, /\.wireless-field select\s*\{/);
  assert.match(css, /#wireless-legacy-connect\s*\{/);
});

test('legacy warning states unencrypted, no authentication and trusted LAN in both languages', () => {
  const en = keys.MESSAGES.en['wireless.legacyWarning'];
  const zh = keys.MESSAGES.zh['wireless.legacyWarning'];
  assert.match(en, /unencrypted/i);
  assert.match(en, /no authentication/i);
  assert.match(en, /trusted LAN/i);
  assert.match(zh, /未加密/);
  assert.match(zh, /无认证/);
  assert.match(zh, /可信局域网/);
});

test('wireless mode and legacy fields persist beside the pairing code in the same localStorage entry', () => {
  const storage = memoryStorage();
  const pair = {
    pairHost: '192.168.3.10', pairPort: '37123', pairCode: '654321',
    connectHost: '192.168.3.10', connectPort: '39541',
  };
  keys.saveWirelessPairing(storage, pair);
  assert.deepEqual(keys.saveWirelessMode(storage, {
    method: 'legacy', legacyHost: '192.168.3.50', legacyPort: '5555',
  }), {
    saved: true,
    values: { method: 'legacy', legacyHost: '192.168.3.50', legacyPort: '5555' },
  });
  assert.deepEqual(keys.loadWirelessPairing(storage), pair, 'saving mode must not change pair fields');
  assert.deepEqual(keys.loadWirelessMode(storage), {
    method: 'legacy', legacyHost: '192.168.3.50', legacyPort: '5555',
  });
  assert.deepEqual(JSON.parse(storage.data.get(keys.WIRELESS_PAIRING_STORAGE_KEY)), {
    ...pair, method: 'legacy', legacyHost: '192.168.3.50', legacyPort: '5555',
  });

  keys.saveWirelessPairing(storage, { ...pair, pairCode: '111111' });
  assert.deepEqual(keys.loadWirelessMode(storage), {
    method: 'legacy', legacyHost: '192.168.3.50', legacyPort: '5555',
  }, 'a later pair save must not drop the selected mode or legacy fields');
  assert.equal(keys.loadWirelessPairing(storage).pairCode, '111111');
});

test('wireless mode normalization defaults to pair mode and port 5555 for malformed storage', () => {
  const storage = memoryStorage();
  assert.deepEqual(keys.loadWirelessMode(storage), {
    method: 'pair', legacyHost: '', legacyPort: '5555',
  });
  storage.data.set(keys.WIRELESS_PAIRING_STORAGE_KEY, JSON.stringify({
    method: 'legacy', legacyHost: 'phone.local', legacyPort: 5555,
  }));
  assert.deepEqual(keys.loadWirelessMode(storage), {
    method: 'legacy', legacyHost: 'phone.local', legacyPort: '5555',
  }, 'numeric ports normalize to strings');
  storage.data.set(keys.WIRELESS_PAIRING_STORAGE_KEY, JSON.stringify({
    method: 'bogus', legacyHost: 42, legacyPort: '70000',
  }));
  assert.deepEqual(keys.loadWirelessMode(storage), {
    method: 'pair', legacyHost: '', legacyPort: '5555',
  });
  storage.data.set(keys.WIRELESS_PAIRING_STORAGE_KEY, 'not json');
  assert.deepEqual(keys.loadWirelessMode(storage), {
    method: 'pair', legacyHost: '', legacyPort: '5555',
  });
});

test('wireless mode storage failures are explicit and never claim persistence', () => {
  const expected = { method: 'legacy', legacyHost: '', legacyPort: '5555' };
  assert.deepEqual(keys.saveWirelessMode(undefined, { method: 'legacy' }), {
    saved: false, values: expected,
  });
  const blocked = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  assert.deepEqual(keys.saveWirelessMode(blocked, { method: 'legacy' }), {
    saved: false, values: expected,
  });
  assert.deepEqual(keys.loadWirelessMode(blocked), {
    method: 'pair', legacyHost: '', legacyPort: '5555',
  });
});

test('legacy connect activation requires an online wifi target', () => {
  assert.equal(keys.isLegacyConnectSuccess(LEGACY_ONLINE_STATUS), true);
  assert.equal(keys.isLegacyConnectSuccess({ ...LEGACY_ONLINE_STATUS, online: false }), false);
  assert.equal(keys.isLegacyConnectSuccess({ ...LEGACY_ONLINE_STATUS, mode: 'usb' }), false);
  assert.equal(keys.isLegacyConnectSuccess({ ...LEGACY_ONLINE_STATUS, serial: '' }), false);
  assert.match(app, /if \(!isLegacyConnectSuccess\(payload\)\)\s*\{[\s\S]*?setWirelessFeedback\('wireless\.error\.offline'/);
});

test('legacy panel posts a real boolean enableTcpip through the serialized legacy API', () => {
  assert.match(app, /const WIRELESS_LEGACY_URL = `\$\{BRIDGE_BASE\}\/api\/wireless\/legacy`;/);
  assert.match(app, /async function connectLegacyWireless\(enableTcpip\)\s*\{[\s\S]*?const body = \{ host, port, enableTcpip \};[\s\S]*?fetch\(WIRELESS_LEGACY_URL,[\s\S]*?method: 'POST'/);
  assert.match(app, /wirelessRequests\.mutate\(async \(\) => \{[\s\S]*?WIRELESS_LEGACY_URL/);
  assert.match(app, /if \(!activateDevice\(payload\.serial\)\)[\s\S]*?setWirelessFeedback\('wireless\.error\.invalidResponse'[\s\S]*?setWirelessFeedback\('wireless\.legacy\.connected'\)[\s\S]*?restartStream\('status\.applying'\);/);
});

test('switching mode hides the inactive form, shows the legacy warning and preserves the pairing code', async () => {
  const storage = legacyHarnessStorage({ pairCode: '654321' });
  const app = await loadWirelessApp({ storage });
  const dom = legacyDom(app);

  assert.equal(dom.mode.value, 'pair');
  assert.equal(dom.pairSection.hidden, false, 'pair form is visible by default');
  assert.equal(dom.legacySection.hidden, true);
  assert.equal(dom.legacyWarning.hidden, true);

  dom.mode.value = 'legacy';
  await dom.mode.dispatch('change');
  assert.equal(dom.pairSection.hidden, true);
  assert.equal(dom.legacySection.hidden, false);
  assert.equal(dom.legacyWarning.hidden, false, 'legacy mode renders the security warning');
  assert.equal(JSON.parse(storage.data.get(keys.WIRELESS_PAIRING_STORAGE_KEY)).method, 'legacy');
  assert.equal(JSON.parse(storage.data.get(keys.WIRELESS_PAIRING_STORAGE_KEY)).pairCode, '654321', 'mode switch must not clear the saved pairing code');

  assert.equal(dom.port.value, '5555', 'legacy port defaults to 5555');
  dom.host.value = '192.168.3.50';
  dom.port.value = '5556';
  await dom.host.dispatch('input');
  assert.deepEqual(keys.loadWirelessMode(storage), {
    method: 'legacy', legacyHost: '192.168.3.50', legacyPort: '5556',
  });

  const reloaded = await loadWirelessApp({ storage });
  const restored = legacyDom(reloaded);
  assert.equal(restored.mode.value, 'legacy');
  assert.equal(restored.legacySection.hidden, false);
  assert.equal(restored.legacyWarning.hidden, false);
  assert.equal(restored.host.value, '192.168.3.50');
  assert.equal(restored.port.value, '5556');
  assert.equal(reloaded.api.readWirelessForm().pairCode, '654321');
});

test('legacy auto-connect is USB-gated while manual connect works without USB', async () => {
  const storage = legacyHarnessStorage({}, { method: 'legacy' });
  const app = await loadWirelessApp({
    storage, usbOnline: false, legacyResponse: LEGACY_ONLINE_STATUS,
  });
  const dom = legacyDom(app);
  await app.api.refreshWirelessStatus();

  assert.equal(dom.auto.disabled, true, 'auto-connect is disabled while USB is offline');
  assert.equal(dom.connect.disabled, false, 'manual connect does not require USB');
  const before = app.requests.length;
  await dom.auto.click();
  assert.equal(app.requests.length, before, 'a disabled auto-connect issues no request');

  app.api.applyWirelessStatus({ mode: 'usb', serial: 'USB123456', online: true, usbOnline: true });
  assert.equal(dom.auto.disabled, false);
});

test('legacy auto-connect sends a boolean true, waits for an online response, then restarts the stream', async () => {
  const storage = legacyHarnessStorage({}, {
    method: 'legacy', legacyHost: '192.168.3.50', legacyPort: '5555',
  });
  const pending = deferred();
  const app = await loadWirelessApp({ storage, legacyResponse: () => pending.promise });
  const dom = legacyDom(app);
  await app.api.refreshWirelessStatus();
  const initialDevice = app.api.getDeviceId();
  const initialGeneration = app.api.getRestartGeneration();

  const clicking = dom.auto.click();
  await app.ready();
  const request = app.requests.find((entry) => entry.url.endsWith('/api/wireless/legacy'));
  assert.ok(request, 'legacy endpoint was called');
  assert.equal(request.options.method, 'POST');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body, { host: '192.168.3.50', port: 5555, enableTcpip: true });
  assert.equal(typeof body.enableTcpip, 'boolean', 'enableTcpip must be a real boolean, not "true"');
  assert.equal(dom.auto.disabled, true);
  assert.equal(dom.auto.getAttribute('aria-busy'), 'true');
  assert.equal(dom.connect.disabled, true);
  assert.equal(app.api.feedback.textContent, keys.MESSAGES.en['wireless.legacyAuto.loading']);
  assert.equal(app.api.getDeviceId(), initialDevice, 'device must not switch before the online response');
  assert.equal(app.api.getRestartGeneration(), initialGeneration, 'no restart before the online response');

  pending.resolve(response(200, LEGACY_ONLINE_STATUS));
  await clicking;

  assert.equal(app.api.getDeviceId(), '192.168.3.50:5555');
  assert.equal(app.api.feedback.textContent, keys.MESSAGES.en['wireless.legacy.connected']);
  assert.equal(app.api.feedback.classList.contains('is-success'), true);
  assert.equal(app.api.getRestartGeneration(), initialGeneration + 1, 'stream restart was requested');
  assert.equal(dom.auto.disabled, false);
  assert.equal(dom.connect.disabled, false);
});

test('legacy manual connect sends enableTcpip:false and works with USB offline', async () => {
  const storage = legacyHarnessStorage({}, {
    method: 'legacy', legacyHost: '192.168.3.50', legacyPort: '5555',
  });
  const app = await loadWirelessApp({
    storage,
    usbOnline: false,
    legacyResponse: response(200, { ...LEGACY_ONLINE_STATUS, usbOnline: false }),
  });
  const dom = legacyDom(app);
  await app.api.refreshWirelessStatus();
  const initialGeneration = app.api.getRestartGeneration();

  await dom.connect.click();

  const request = app.requests.find((entry) => entry.url.endsWith('/api/wireless/legacy'));
  assert.deepEqual(JSON.parse(request.options.body), {
    host: '192.168.3.50', port: 5555, enableTcpip: false,
  });
  assert.equal(app.api.getDeviceId(), '192.168.3.50:5555');
  assert.equal(app.api.getRestartGeneration(), initialGeneration + 1);
});

test('legacy connect failure preserves the active device and reports the bridge error', async () => {
  const app = await loadWirelessApp({
    storage: legacyHarnessStorage({}, {
      method: 'legacy', legacyHost: '192.168.3.50', legacyPort: '5555',
    }),
    legacyResponse: response(502, { error: 'adb connect failed' }),
  });
  const dom = legacyDom(app);
  await app.api.refreshWirelessStatus();
  const initialDevice = app.api.getDeviceId();
  const initialGeneration = app.api.getRestartGeneration();

  await dom.connect.click();

  assert.equal(app.api.getDeviceId(), initialDevice);
  assert.equal(app.api.feedback.classList.contains('is-error'), true);
  assert.match(app.api.feedback.textContent, /502/);
  assert.match(app.api.feedback.textContent, /adb connect failed/);
  assert.equal(app.api.getRestartGeneration(), initialGeneration, 'a failed connect must not restart the stream');
});

test('legacy connect refuses to activate an offline wifi target', async () => {
  const app = await loadWirelessApp({
    storage: legacyHarnessStorage({}, {
      method: 'legacy', legacyHost: '192.168.3.50', legacyPort: '5555',
    }),
    legacyResponse: response(200, { ...LEGACY_ONLINE_STATUS, online: false }),
  });
  const dom = legacyDom(app);
  await app.api.refreshWirelessStatus();
  const initialDevice = app.api.getDeviceId();

  await dom.connect.click();

  assert.equal(app.api.feedback.textContent, keys.MESSAGES.en['wireless.error.offline']);
  assert.equal(app.api.getDeviceId(), initialDevice);
});

test('legacy auto-connect 409 marks USB offline and disables further auto attempts', async () => {
  const app = await loadWirelessApp({
    storage: legacyHarnessStorage({}, {
      method: 'legacy', legacyHost: '192.168.3.50', legacyPort: '5555',
    }),
    legacyResponse: response(409, { error: 'USB device is offline' }),
  });
  const dom = legacyDom(app);
  await app.api.refreshWirelessStatus();

  await dom.auto.click();

  assert.equal(app.api.feedback.textContent, keys.MESSAGES.en['wireless.error.legacyUsbOffline']);
  assert.equal(app.api.feedback.classList.contains('is-error'), true);
  assert.equal(dom.auto.disabled, true);
  assert.equal(dom.auto.getAttribute('aria-busy'), 'false');
  const count = app.requests.length;
  await dom.auto.click();
  assert.equal(app.requests.length, count, 'the disabled button cannot retry');
});

test('legacy and pairing actions share the busy state and clear it on failure', async () => {
  const app = await loadWirelessApp({
    storage: legacyHarnessStorage({}, {
      method: 'legacy', legacyHost: '192.168.3.50', legacyPort: '5555',
    }),
    legacyResponse: response(502, { error: 'adb connect failed' }),
  });
  const dom = legacyDom(app);
  await app.api.refreshWirelessStatus();

  const pendingConnect = dom.connect.click();
  assert.equal(app.api.buttons.submit.disabled, true, 'legacy action disables pair submit');
  assert.equal(app.api.buttons.auto.disabled, true, 'legacy action disables pair auto-fetch');
  assert.equal(app.api.buttons.usb.disabled, true);
  await pendingConnect;

  assert.equal(app.api.buttons.submit.disabled, false);
  assert.equal(dom.connect.disabled, false);
  assert.equal(dom.auto.disabled, false);
});
