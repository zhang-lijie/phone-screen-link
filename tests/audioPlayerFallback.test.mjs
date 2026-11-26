import test, { after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUDIO_WORKLET_FALLBACK_PATCHES } from '../scripts/setup.mjs';

const fixtureUrl = new URL('./fixtures/AudioPlayer.v0.5.13.ts', import.meta.url);
const tempDir = mkdtempSync(join(tmpdir(), 'psl-audio-player-'));
const modulePath = join(tempDir, 'AudioPlayer.mjs');
// Escape hatch for RED verification: run the harness against pristine upstream
// and confirm the behavioral tests fail without the production patches.
const audioPatches =
  process.env.PSL_AUDIO_UNPATCHED === '1' ? [] : AUDIO_WORKLET_FALLBACK_PATCHES;

after(() => rmSync(tempDir, { recursive: true, force: true }));

function applyAudioPatches(source) {
  for (const patch of audioPatches) {
    if (source.includes(patch.to)) continue;
    assert.ok(source.includes(patch.from), `upstream fixture drifted: ${patch.file}`);
    source = source.replace(patch.from, patch.to);
  }
  return source;
}

function loadPatchedPlayer() {
  const upstream = readFileSync(fixtureUrl, 'utf8');
  const patched = applyAudioPatches(upstream);
  assert.equal(applyAudioPatches(patched), patched, 'audio patches must be idempotent');

  // Node's type stripper handles erasable TS syntax only. Rewrite the one
  // parameter property (which requires a transform) into a field + assignment.
  const strippable = patched.replace(
    'constructor(private readonly codec: string) {}',
    'codec;\n    constructor(codec: string) {\n        this.codec = codec;\n    }',
  );
  let javascript = stripTypeScriptTypes(strippable);
  javascript = javascript.replace(
    "import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from './PcmWorklet';",
    "const PCM_WORKLET_NAME = 'pcm-worklet'; const PCM_WORKLET_SOURCE = '';",
  );
  javascript = javascript.replace(
    "import { decodeS16LEToFloat32Planar } from './pcmConvert';",
    `const decodeS16LEToFloat32Planar = (data, channelCount) => {
      const frames = Math.floor(data.byteLength / (2 * channelCount));
      return Array.from({ length: channelCount }, () =>
        new Float32Array(frames).fill(data[0] || 1),
      );
    };`,
  );
  assert.ok(!javascript.includes("from './PcmWorklet'"));
  assert.ok(!javascript.includes("from './pcmConvert'"));
  writeFileSync(modulePath, javascript);
  return import(pathToFileURL(modulePath).href);
}

const { AudioPlayer } = await loadPatchedPlayer();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function outputBuffer(length = 4, channels = 2) {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    length,
    numberOfChannels: channels,
    getChannelData: (channel) => data[channel],
  };
}

let restoreFakes = () => {};

beforeEach(() => {
  restoreFakes = () => {};
});

afterEach(() => {
  restoreFakes();
});

function installWebAudioFakes(options = {}) {
  const contexts = [];
  const workletNodes = [];
  const scriptNodes = [];
  const warnings = [];
  const originals = {
    AudioContext: globalThis.AudioContext,
    AudioWorkletNode: globalThis.AudioWorkletNode,
    AudioDecoder: globalThis.AudioDecoder,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
    warn: console.warn,
  };

  class FakeGainNode {
    gain = { value: 1 };
    connect() {}
    disconnect() {}
  }

  class FakeAudioContext {
    state = 'running';
    destination = {};
    closeCalls = 0;
    gainNode = new FakeGainNode();

    constructor() {
      this.audioWorklet = {
        addModule: options.addModule ?? (() => Promise.resolve()),
      };
      contexts.push(this);
    }

    createGain() {
      return this.gainNode;
    }

    createScriptProcessor(inputSize, outputSize, channelCount) {
      const node = {
        inputSize,
        outputSize,
        channelCount,
        onaudioprocess: null,
        connect() {},
        disconnect() {},
      };
      scriptNodes.push(node);
      return node;
    }

    resume() {
      return options.resume?.(this) ?? Promise.resolve();
    }

    close() {
      this.closeCalls += 1;
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  class FakeAudioWorkletNode {
    messages = [];
    port = {
      postMessage: (message) => this.messages.push(message),
    };
    connect() {}
    disconnect() {}
    constructor(context) {
      this.context = context;
      workletNodes.push(this);
    }
  }

  class FakeAudioDecoder {
    state = 'unconfigured';
    configure() {
      this.state = 'configured';
    }
    decode() {}
    close() {
      this.state = 'closed';
    }
  }

  globalThis.AudioContext = FakeAudioContext;
  globalThis.AudioWorkletNode = FakeAudioWorkletNode;
  globalThis.AudioDecoder = FakeAudioDecoder;
  URL.createObjectURL = () => 'blob:fake';
  URL.revokeObjectURL = () => {};
  console.warn = (...args) => warnings.push(args.join(' '));

  restoreFakes = () => {
    globalThis.AudioContext = originals.AudioContext;
    globalThis.AudioWorkletNode = originals.AudioWorkletNode;
    globalThis.AudioDecoder = originals.AudioDecoder;
    URL.createObjectURL = originals.createObjectURL;
    URL.revokeObjectURL = originals.revokeObjectURL;
    console.warn = originals.warn;
  };

  return { contexts, workletNodes, scriptNodes, warnings };
}

test('audio patches apply to pinned v0.5.13 source and are idempotent', () => {
  const upstream = readFileSync(fixtureUrl, 'utf8');
  const patched = applyAudioPatches(upstream);
  assert.notEqual(patched, upstream);
  assert.equal(applyAudioPatches(patched), patched);
  for (const patch of audioPatches) {
    assert.ok(patched.includes(patch.to), `patch was not applied: ${patch.file}`);
  }
});

test('successful worklet load posts raw PCM and tears down once', async () => {
  const fakes = installWebAudioFakes();
  const player = new AudioPlayer('raw');
  await player.start();

  assert.equal(fakes.contexts.length, 1);
  assert.equal(fakes.contexts[0].state, 'running');
  assert.equal(fakes.workletNodes.length, 1);
  assert.equal(fakes.scriptNodes.length, 0);

  player.pushFrame(new Uint8Array([5, 0, 5, 0]), 0n, false);
  assert.equal(fakes.workletNodes[0].messages.length, 1);
  assert.deepEqual(Array.from(fakes.workletNodes[0].messages[0].channels[0]), [5]);

  player.stop();
  player.stop();
  assert.equal(fakes.contexts[0].closeCalls, 1);
});

test('immediate worklet rejection falls back and writes silence on underrun', async () => {
  const fakes = installWebAudioFakes({
    addModule: () => Promise.reject(new Error('simulated worklet failure')),
  });
  const player = new AudioPlayer('raw');
  await player.start();

  assert.equal(fakes.workletNodes.length, 0);
  assert.equal(fakes.scriptNodes.length, 1);
  assert.match(fakes.warnings.join('\n'), /simulated worklet failure/);

  player.pushFrame(new Uint8Array([5, 0, 5, 0]), 0n, false);
  const buffer = outputBuffer(4, 2);
  fakes.scriptNodes[0].onaudioprocess({ outputBuffer: buffer });

  assert.deepEqual(Array.from(buffer.getChannelData(0)), [5, 0, 0, 0]);
  assert.deepEqual(Array.from(buffer.getChannelData(1)), [5, 0, 0, 0]);
  assert.equal(player.outputQueue.length, 0);
});

test('hanging worklet load times out after 1500ms and falls back', { timeout: 1000 }, async (t) => {
  const fakes = installWebAudioFakes({ addModule: () => new Promise(() => {}) });
  let timeoutMs;
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    timeoutMs = ms;
    queueMicrotask(callback);
    return 0;
  });

  const player = new AudioPlayer('raw');
  await player.start();

  assert.equal(timeoutMs, 1500);
  assert.equal(fakes.scriptNodes.length, 1);
  assert.match(fakes.warnings.join('\n'), /timed out after 1500ms/);
});

test('stop during pending worklet load closes once and creates no output nodes', async () => {
  const load = deferred();
  const fakes = installWebAudioFakes({ addModule: () => load.promise });
  const player = new AudioPlayer('raw');

  const starting = player.start();
  player.stop();
  load.reject(new Error('late worklet failure'));
  await starting;

  assert.equal(fakes.contexts[0].closeCalls, 1);
  assert.equal(fakes.workletNodes.length, 0);
  assert.equal(fakes.scriptNodes.length, 0);
  assert.equal(fakes.warnings.length, 0);
});

test('overlapping stop/start cannot let the old load touch the new context', async () => {
  const loads = [];
  const fakes = installWebAudioFakes({
    addModule: () => {
      const load = deferred();
      loads.push(load);
      return load.promise;
    },
  });
  const player = new AudioPlayer('raw');

  const firstStart = player.start();
  const firstContext = fakes.contexts[0];
  player.stop();
  const secondStart = player.start();
  const secondContext = fakes.contexts[1];

  loads[1].resolve();
  await secondStart;
  loads[0].reject(new Error('old load failed'));
  await firstStart;

  assert.equal(firstContext.state, 'closed');
  assert.equal(secondContext.state, 'running');
  assert.equal(fakes.workletNodes.length, 1);
  assert.equal(fakes.workletNodes[0].context, secondContext);
});

test('fallback queue drops the oldest blocks beyond 50 and stop clears it', async () => {
  const fakes = installWebAudioFakes({
    addModule: () => Promise.reject(new Error('simulated worklet failure')),
  });
  const player = new AudioPlayer('raw');
  await player.start();

  for (let i = 1; i <= 60; i++) {
    player.pushFrame(new Uint8Array([i, 0, i, 0]), 0n, false);
  }

  assert.equal(player.outputQueue.length, 50);
  assert.equal(player.outputQueue[0].channels[0][0], 11);
  player.stop();
  assert.equal(player.outputQueue.length, 0);
  assert.equal(fakes.scriptNodes[0].onaudioprocess, null);
});

test('resume rejection after stop resolves silently', async () => {
  const resume = deferred();
  const fakes = installWebAudioFakes({ resume: () => resume.promise });
  const player = new AudioPlayer('raw');
  await player.start();

  fakes.contexts[0].state = 'suspended';
  const resumed = player.resume();
  player.stop();
  resume.reject(new DOMException('AudioContext is closed.', 'InvalidStateError'));
  await resumed;

  assert.equal(fakes.contexts[0].closeCalls, 1);
  assert.equal(fakes.warnings.length, 0);
});
