import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_REPO,
  ENGINE_TAG,
  engineDir,
  LOOPBACK_PATCH,
  KEYBOARD_FOCUS_PATCH,
  UHID_KEYBOARD_FOCUS_PATCHES,
  checkGhostToolchain,
} from '../scripts/setup.mjs';

test('engine is pinned to upstream v0.5.13', () => {
  assert.equal(ENGINE_TAG, 'v0.5.13');
  assert.match(ENGINE_REPO, /ws-scrcpy-web\.git$/);
  assert.match(engineDir(), /\/engine$/);
});

test('loopback patch targets the single all-interfaces listen call', () => {
  assert.equal(LOOPBACK_PATCH.file, 'src/server/services/HttpServer.ts');
  assert.match(LOOPBACK_PATCH.from, /server\.listen\(port,/);
  assert.match(LOOPBACK_PATCH.to, /'127\.0\.0\.1'/);
});

test('keyboard-focus patch guards KeyInputHandler for editable targets', () => {
  assert.equal(KEYBOARD_FOCUS_PATCH.file, 'src/app/googDevice/KeyInputHandler.ts');
  assert.match(KEYBOARD_FOCUS_PATCH.from, /private static handler = \(event: Event\): void =>/);
  assert.match(KEYBOARD_FOCUS_PATCH.from, /KeyToCodeMap\.get\(keyboardEvent\.code\)/);
  for (const needle of ['isContentEditable', 'INPUT', 'TEXTAREA', 'SELECT', 'return;']) {
    assert.ok(KEYBOARD_FOCUS_PATCH.to.includes(needle), `patch must include ${needle}`);
  }
});

test('UHID keyboard-focus patches guard keydown and keyup for editable targets', () => {
  assert.equal(UHID_KEYBOARD_FOCUS_PATCHES.length, 2);
  for (const patch of UHID_KEYBOARD_FOCUS_PATCHES) {
    assert.equal(patch.file, 'src/app/googDevice/UhidKeyboardHandler.ts');
    assert.match(patch.from, /private onKey(Down|Up)\(event: KeyboardEvent\): void/);
    assert.match(patch.from, /event\.preventDefault\(\)/);
    for (const needle of ['isContentEditable', 'INPUT', 'TEXTAREA', 'SELECT', 'return;']) {
      assert.ok(patch.to.includes(needle), `patch must include ${needle}`);
    }
    assert.ok(
      patch.to.indexOf('return;') < patch.to.indexOf('event.preventDefault()'),
      'guard must run before preventDefault',
    );
  }
});

test('ghost toolchain: uvx is detected first, then uv, with no warnings', () => {
  const lines = [];
  const log = (line) => lines.push(line);
  const exec = (command) => {
    if (command !== 'uvx') throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  };
  assert.equal(checkGhostToolchain({ exec, log }), 'uvx');
  assert.deepEqual(lines, []);

  const uvOnly = (command) => {
    if (command !== 'uv') throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  };
  assert.equal(checkGhostToolchain({ exec: uvOnly, log }), 'uv');
  assert.deepEqual(lines, []);
});

test('ghost toolchain: missing uvx and uv only prints an install hint, never throws', () => {
  const lines = [];
  const missing = () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); };
  assert.equal(checkGhostToolchain({ exec: missing, log: (line) => lines.push(line) }), null);
  const text = lines.join('\n');
  assert.match(text, /uvx/);
  assert.match(text, /ghost-in-the-droid/);
  assert.match(text, /astral\.sh\/uv|install/i);
});
