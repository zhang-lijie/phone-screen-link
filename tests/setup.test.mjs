import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_REPO,
  ENGINE_TAG,
  engineDir,
  LOOPBACK_PATCH,
  KEYBOARD_FOCUS_PATCH,
  AUDIO_WORKLET_FALLBACK_PATCHES,
  UHID_KEYBOARD_FOCUS_PATCHES,
  FETCH_NODE_DARWIN_PATCH,
  ADB_DARWIN_PATCH,
  PREBUILT_DARWIN_PATCH,
  NODEPTY_DARWIN_PATCH,
  NODE_URL_DARWIN_PATCH,
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

test('audio fallback patches cover the startup race, timeout and ScriptProcessor path', () => {
  assert.ok(Array.isArray(AUDIO_WORKLET_FALLBACK_PATCHES));
  assert.equal(AUDIO_WORKLET_FALLBACK_PATCHES.length, 7);

  for (const patch of AUDIO_WORKLET_FALLBACK_PATCHES) {
    assert.equal(patch.file, 'src/app/audio/AudioPlayer.ts');
    assert.ok(patch.from.length > 0, 'patch must have an anchor');
    assert.notEqual(patch.from, patch.to, 'patch must change something');
  }

  const anchors = AUDIO_WORKLET_FALLBACK_PATCHES.map((p) => p.from).join('\n');
  for (const needle of [
    'private workletNode?: AudioWorkletNode | undefined;',
    'await this.audioContext.audioWorklet.addModule(url);',
    'this.workletNode!.port.postMessage(',
    'this.gainNode?.disconnect();',
  ]) {
    assert.ok(anchors.includes(needle), `anchor must still match upstream: ${needle}`);
  }

  const output = AUDIO_WORKLET_FALLBACK_PATCHES.map((p) => p.to).join('\n');
  for (const needle of [
    'this.audioContext !== context',
    'private async loadWorklet(',
    '1500',
    'createScriptProcessor(2048, 1, 2)',
    'this.outputQueue.length > 50',
    'output.getChannelData(ch).fill(0, written)',
    'this.enqueue(channels, numFrames)',
    'this.enqueue(channels, framesPerChannel)',
    'this.scriptNode.onaudioprocess = null',
    'await context.resume().catch',
    'this.audioContext !== context',
  ]) {
    assert.ok(output.includes(needle), `patch must include ${needle}`);
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

test('darwin patches: node bootstrap, adb archive and prebuilt platform', () => {
  assert.equal(FETCH_NODE_DARWIN_PATCH.file, 'scripts/fetch-node.mjs');
  assert.match(FETCH_NODE_DARWIN_PATCH.from, /if \(process\.platform === 'linux'\) \{/);
  assert.match(FETCH_NODE_DARWIN_PATCH.from, /Node bootstrap fetch is implemented for win32 and linux only/);
  assert.match(FETCH_NODE_DARWIN_PATCH.to, /darwin/);
  assert.match(FETCH_NODE_DARWIN_PATCH.to, /node-v24\.19\.0-darwin-arm64\.tar\.xz/);
  assert.match(FETCH_NODE_DARWIN_PATCH.to, /3f1cf157479c1480352083105e13faf9d008ede98e7e157746b6df940d197b94/);

  assert.equal(ADB_DARWIN_PATCH.length, 2);
  assert.match(ADB_DARWIN_PATCH[0].from, /getPlatform\(\): 'win32' \| 'linux'/);
  assert.match(ADB_DARWIN_PATCH[0].from, /os\.platform\(\) === 'win32' \? 'win32' : 'linux'/);
  assert.match(ADB_DARWIN_PATCH[0].to, /darwin/);
  assert.match(ADB_DARWIN_PATCH[1].from, /platform-tools_r\$\{version\}-\$\{getPlatform\(\) === 'win32' \? 'win' : 'linux'\}\.zip/);
  assert.match(ADB_DARWIN_PATCH[1].to, /darwin/);

  assert.equal(PREBUILT_DARWIN_PATCH.file, 'scripts/fetch-prebuilts.mjs');
  assert.match(PREBUILT_DARWIN_PATCH.from, /process\.platform === 'win32' \? 'win32' : 'linux'/);
  assert.match(PREBUILT_DARWIN_PATCH.to, /darwin/);
});

test('darwin runtime patches: node-pty resolver and node download url', () => {
  // I-1: runtime node-pty key must not fall through to linux on darwin
  assert.ok(Array.isArray(NODEPTY_DARWIN_PATCH));
  assert.equal(NODEPTY_DARWIN_PATCH.length, 2);
  assert.equal(NODEPTY_DARWIN_PATCH[0].file, 'src/server/NodePtyResolver.ts');
  assert.match(NODEPTY_DARWIN_PATCH[0].from, /platform: 'win32' \| 'linux'/);
  assert.match(NODEPTY_DARWIN_PATCH[0].to, /'darwin'/);
  assert.match(NODEPTY_DARWIN_PATCH[1].from, /process\.platform === 'win32' \? 'win32' : 'linux'/);
  assert.match(NODEPTY_DARWIN_PATCH[1].to, /'darwin'/);

  // I-2: Node dependency download URL must select darwin archive
  assert.ok(Array.isArray(NODE_URL_DARWIN_PATCH));
  assert.equal(NODE_URL_DARWIN_PATCH.length, 3);
  assert.equal(NODE_URL_DARWIN_PATCH[0].file, 'src/server/DependencyDefinitions.ts');
  assert.match(NODE_URL_DARWIN_PATCH[0].from, /node-v\$\{version\}-linux-\$\{arch\}\.tar\.gz/);
  assert.match(NODE_URL_DARWIN_PATCH[0].to, /darwin/);
  assert.equal(NODE_URL_DARWIN_PATCH[1].file, 'src/server/DependencyManager.ts');
  assert.match(NODE_URL_DARWIN_PATCH[1].from, /platform: 'win32' \| 'linux'/);
  assert.match(NODE_URL_DARWIN_PATCH[2].from, /installAdb/);
  assert.match(NODE_URL_DARWIN_PATCH[2].to, /darwin/);
});
