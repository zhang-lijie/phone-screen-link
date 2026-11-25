import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as keys from '../shared/keys.mjs';

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
  assert.equal([...app.matchAll(/wirelessRequests\.mutate\(/g)].length, 3, 'auto-fetch, pair and USB all exclude stale refreshes');
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
    warnings: ['Pairing port unavailable.', 'Connect port unavailable.'],
  }), {
    usbSerial: 'USB123456',
    updates: {
      pairHost: '192.168.3.10',
      connectHost: '192.168.3.10',
    },
    warnings: ['Pairing port unavailable.', 'Connect port unavailable.'],
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
    warnings: ['Partial result.', '', 42, 'Partial result.'],
  }), {
    usbSerial: 'USB123456',
    updates: { connectHost: '192.168.3.10' },
    warnings: ['Partial result.'],
    complete: false,
  });
});

test('wireless auto availability follows usbOnline and the shared busy state', () => {
  assert.match(app, /let wirelessState = \{ mode: 'unknown', serial: '—', online: false, usbOnline: false \};/);
  assert.match(app, /wirelessState = \{ mode: payload\.mode, serial: payload\.serial, online: payload\.online, usbOnline: payload\.usbOnline === true \};/);
  assert.match(app, /function renderWirelessAutoButton\(\) \{[\s\S]*?wirelessAuto\.disabled = wirelessBusy \|\| wirelessAutoBusy \|\| wirelessState\.usbOnline !== true;[\s\S]*?wirelessAuto\.textContent = t\(wirelessAutoBusy \? 'wireless\.auto\.loading' : 'wireless\.auto'\);[\s\S]*?wirelessAuto\.classList\.toggle\('is-loading', wirelessAutoBusy\);[\s\S]*?wirelessAuto\.setAttribute\('aria-busy', String\(wirelessAutoBusy\)\);/);
  assert.match(app, /function applyWirelessStatus\(payload\)\s*\{[\s\S]*?renderWirelessAutoButton\(\);/);
  assert.match(app, /function setWirelessBusy\(busy\)\s*\{[\s\S]*?renderWirelessAutoButton\(\);/);
  assert.match(app, /renderWirelessStatus\(\);\s*renderWirelessAutoButton\(\);/);
});

test('wireless auto-fetch calls only the read-only API, merges fields, saves and focuses the pairing code', () => {
  assert.match(app, /const WIRELESS_AUTO_URL = `\$\{BRIDGE_BASE\}\/api\/wireless\/auto`;/);
  const autoBody = app.match(/async function autoFetchWireless\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(autoBody, 'auto-fetch handler exists');
  assert.match(autoBody, /if \(wirelessBusy \|\| wirelessAutoBusy \|\| wirelessState\.usbOnline !== true\) return;/);
  assert.match(autoBody, /wirelessRequests\.mutate\(/);
  assert.match(autoBody, /fetch\(WIRELESS_AUTO_URL,\s*\{[\s\S]*?method: 'POST',[\s\S]*?body: '\{\}'/);
  assert.match(autoBody, /const parsed = parseWirelessAutoResult\(payload\);/);
  assert.match(autoBody, /if \(!parsed\)\s*\{[\s\S]*?setWirelessFeedback\('wireless\.error\.invalidResponse'/);
  assert.match(autoBody, /fillWirelessForm\(\{ \.\.\.readWirelessForm\(\), \.\.\.parsed\.updates \}\);/);
  assert.match(autoBody, /saveWirelessFormFromDom\(\);/);
  assert.match(autoBody, /wirelessFields\.pairCode\.focus\(\);/);
  assert.match(autoBody, /wirelessAutoBusy = false;[\s\S]*?setWirelessBusy\(false\);/);
  assert.doesNotMatch(autoBody, /pairWireless|WIRELESS_PAIR_URL|activateDevice|restartStream/);
  assert.match(app, /wirelessAuto\.addEventListener\('click', autoFetchWireless\);/);
});

test('wireless auto-fetch reports partial results as warnings without pairing', () => {
  const autoBody = app.match(/async function autoFetchWireless\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(autoBody, 'auto-fetch handler exists');
  assert.match(autoBody, /if \(!parsed\.complete \|\| parsed\.warnings\.length > 0\)\s*\{[\s\S]*?setWirelessFeedback\('wireless\.auto\.partial',[\s\S]*?false,\s*true\);/);
  assert.match(autoBody, /setWirelessFeedback\('wireless\.auto\.fetched'\);/);
  assert.match(app, /function renderWirelessFeedback\(\)\s*\{[\s\S]*?classList\.toggle\('is-warning', wirelessFeedbackIsWarning\);/);
  assert.match(css, /\.wireless-feedback\.is-warning\s*\{[^}]*color:\s*#d8bd83;/);
  assert.match(keys.MESSAGES.en['wireless.auto.partial'], /partial/i);
  assert.match(keys.MESSAGES.zh['wireless.auto.partial'], /部分/);
});

test('wireless auto-fetch surfaces USB-offline responses and disables further fetches', () => {
  const autoBody = app.match(/async function autoFetchWireless\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(autoBody, 'auto-fetch handler exists');
  assert.match(autoBody, /if \(res\.status === 409\)\s*\{[\s\S]*?wirelessState\.usbOnline = false;[\s\S]*?renderWirelessAutoButton\(\);[\s\S]*?setWirelessFeedback\('wireless\.error\.usbOffline', \{\}, true\);/);
  assert.match(keys.MESSAGES.en['wireless.error.usbOffline'], /USB.*offline/i);
  assert.match(keys.MESSAGES.zh['wireless.error.usbOffline'], /USB.*离线/);
});
