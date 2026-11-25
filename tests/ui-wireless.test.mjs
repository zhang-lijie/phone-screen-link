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
  assert.deepEqual(keys.saveWirelessPairing(storage, form), form);
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
    pairHost: '', pairPort: '', pairCode: '123456', connectHost: '', connectPort: '',
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
  assert.equal(keys.saveWirelessPairing(inaccessible, { pairCode: '654321' }).pairCode, '654321');

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
  assert.match(app, /saveWirelessPairing\(\(\) => localStorage, readWirelessForm\(\)\)/);
  assert.match(app, /wirelessForm\.addEventListener\('input', saveWirelessFormFromDom\)/);
  assert.match(app, /for \(const field of WIRELESS_PAIRING_FIELDS\)\s*\{\s*values\[field\] = wirelessFields\[field\]\.value;/);
  assert.match(app, /wirelessClear\.addEventListener\('click', \(\) => \{[\s\S]*?clearWirelessPairingResult\(\(\) => localStorage\)[\s\S]*?if \(!result\.cleared\)[\s\S]*?fillWirelessForm\(DEFAULT_WIRELESS_PAIRING\);/);
});

test('wireless status and mode changes share the stale-response guard', () => {
  assert.match(app, /const wirelessRequests = createWirelessRequestGuard\(\);/);
  assert.match(app, /wirelessRequests\.refresh\(/);
  assert.equal([...app.matchAll(/wirelessRequests\.mutate\(/g)].length, 2, 'pair and USB both invalidate refreshes');
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
