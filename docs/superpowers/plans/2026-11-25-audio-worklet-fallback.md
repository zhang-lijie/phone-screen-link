# Audio Worklet Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the spurious "Failed to start audio" error when a stream is stopped during worklet startup, and keep phone audio working in browsers whose `audioWorklet.addModule()` fails or hangs.

**Architecture:** Two source patches on the vendored engine's `AudioPlayer`: (1) `start()` re-checks `started`/context identity after the `addModule()` await and returns silently if `stop()` already ran; (2) `loadWorklet()` races `addModule()` against a 1500 ms timeout and falls back to a `ScriptProcessorNode` that drains a bounded queue. Both live in `scripts/setup.mjs` as `AUDIO_WORKLET_FALLBACK_PATCHES`, applied by `applyEnginePatches()`.

**Tech Stack:** Node ESM, `node:test`, the vendored `ws-scrcpy-web` v0.5.13 engine (TypeScript, `AudioContext`/`AudioWorklet`/`ScriptProcessorNode`, built with webpack into `engine/dist/`).

**Spec:** `docs/superpowers/specs/2026-11-25-audio-worklet-fallback-design.md`

## Global Constraints

- Engine is an external, gitignored dependency; every engine change must be reproducible from `scripts/setup.mjs` patches.
- Do not change the wire protocol, `AudioDecoder` configuration, `PcmWorklet` mixing, page UI, or chat behavior.
- `stop()` stays idempotent; a second call must not throw or close the context twice.
- `setVolume()` and `resume()` semantics are unchanged.
- The worklet remains the preferred path; `ScriptProcessorNode` is only a fallback.
- Existing engine patches (loopback, wheel, keyboard focus, audio volume, resize, darwin) must keep applying.

## Review Focus

- `stop()` lands while `addModule()` is pending: no uncaught rejection, context closed once, player leaves no live nodes — Task 3 fallback/race browser check.
- `addModule()` rejects immediately: fallback node is created and audio keeps flowing — Task 3 instrumentation check.
- `addModule()` never settles: the 1500 ms timeout triggers fallback instead of hanging audio forever — pinned by Task 1's `1500` assertion and Task 3's rejection simulation.
- Repeated stop/start cycles: no stale context, queue growth, or double close — Task 3 repeat check plus existing `audioPlayerStop` tests in Task 2.
- Fallback underrun and a flooded queue: silence is written instead of stale samples, and the queue stays bounded — pinned by Task 1's `fill(0, written)` / `length > 50` assertions and exercised by Task 3 playback.

---

### Task 1: Declare and test the audio fallback patches

**Files:**
- Modify: `scripts/setup.mjs` (add `AUDIO_WORKLET_FALLBACK_PATCHES`; call it in `applyEnginePatches`)
- Test: `tests/setup.test.mjs`

**Interfaces:**
- Consumes: the existing patch object shape `{ file, from, to }` and `applyPatch(patch, description)` in `scripts/setup.mjs`.
- Produces: exported `AUDIO_WORKLET_FALLBACK_PATCHES` — an array of six patches, all with `file = 'src/app/audio/AudioPlayer.ts'`; `applyEnginePatches()` applies each in order.

- [ ] **Step 1: Write the failing test**

In `tests/setup.test.mjs`, add `AUDIO_WORKLET_FALLBACK_PATCHES` to the import list and append:

```js
test('audio fallback patches cover the startup race, timeout and ScriptProcessor path', () => {
  assert.ok(Array.isArray(AUDIO_WORKLET_FALLBACK_PATCHES));
  assert.equal(AUDIO_WORKLET_FALLBACK_PATCHES.length, 6);

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
  ]) {
    assert.ok(output.includes(needle), `patch must include ${needle}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `AUDIO_WORKLET_FALLBACK_PATCHES` is not exported.

- [ ] **Step 3: Implement the patch constant and wire it in**

In `scripts/setup.mjs`, immediately after `KEYBOARD_FOCUS_PATCH` / before `UHID_KEYBOARD_FOCUS_PATCHES`, add:

```js
// Audio startup must survive a stop() that lands while the worklet module is
// still loading, and must still play when AudioWorklet cannot load at all.
// The worklet stays the preferred path; a ScriptProcessorNode is the fallback.
export const AUDIO_WORKLET_FALLBACK_PATCHES = [
  {
    file: 'src/app/audio/AudioPlayer.ts',
    from: `    private workletNode?: AudioWorkletNode | undefined;
    private gainNode?: GainNode | undefined;
    private started = false;`,
    to: `    private workletNode?: AudioWorkletNode | undefined;
    private scriptNode?: ScriptProcessorNode | undefined;
    private gainNode?: GainNode | undefined;
    private outputQueue: Array<{ channels: Float32Array[]; numFrames: number; offset: number }> = [];
    private started = false;`,
  },
  {
    file: 'src/app/audio/AudioPlayer.ts',
    from: `        this.audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });

        // Load worklet via Blob URL
        const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await this.audioContext.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        this.workletNode = new AudioWorkletNode(this.audioContext, PCM_WORKLET_NAME, {
            outputChannelCount: [2],
        });
        this.gainNode = this.audioContext.createGain();
        this.workletNode.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);
        this.workletReady = true;`,
    to: `        const context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
        this.audioContext = context;

        const worklet = await this.loadWorklet(context);
        // stop() may have run while addModule() was pending. It already tore the
        // context down, so leave without touching the state it reset.
        if (!this.started || this.audioContext !== context) {
            if (context.state !== 'closed') context.close().catch(() => {});
            return;
        }

        this.gainNode = context.createGain();
        this.gainNode.connect(context.destination);
        if (worklet.ok) {
            this.workletNode = new AudioWorkletNode(context, PCM_WORKLET_NAME, {
                outputChannelCount: [2],
            });
            this.workletNode.connect(this.gainNode);
        } else {
            console.warn(
                '[AudioPlayer] AudioWorklet unavailable, using ScriptProcessor:',
                worklet.reason,
            );
            this.startScriptProcessor(context);
        }
        this.workletReady = true;`,
  },
  {
    file: 'src/app/audio/AudioPlayer.ts',
    from: `    async resume(): Promise<void> {`,
    to: `    /**
     * Load the PCM worklet. Returns the failure reason instead of throwing, so
     * the caller can decide whether to fall back (and can stay silent when the
     * player was stopped while the module was loading).
     *
     * Some embedders leave addModule() pending forever instead of rejecting,
     * hence the timeout. The load promise carries its own handlers, so a late
     * rejection after the timeout cannot surface as an unhandled rejection.
     */
    private async loadWorklet(
        context: AudioContext,
    ): Promise<{ ok: true } | { ok: false; reason: string }> {
        const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const load = context.audioWorklet.addModule(url).then(
                () => ({ ok: true as const }),
                (error: unknown) => ({
                    ok: false as const,
                    reason: error instanceof Error ? error.message : String(error),
                }),
            );
            const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
                timer = setTimeout(
                    () => resolve({ ok: false, reason: 'timed out after 1500ms' }),
                    1500,
                );
            });
            return await Promise.race([load, timeout]);
        } catch (error) {
            // audioWorklet can be missing entirely; a synchronous throw must
            // still end in the fallback path rather than rejecting start().
            return {
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
            };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            URL.revokeObjectURL(url);
        }
    }

    private startScriptProcessor(context: AudioContext): void {
        const node = context.createScriptProcessor(2048, 1, 2);
        node.onaudioprocess = (event: AudioProcessingEvent): void => {
            const output = event.outputBuffer;
            const frameCount = output.length;
            let written = 0;

            while (written < frameCount && this.outputQueue.length > 0) {
                const block = this.outputQueue[0]!;
                const remaining = block.numFrames - block.offset;
                const toWrite = Math.min(frameCount - written, remaining);
                for (let ch = 0; ch < output.numberOfChannels; ch++) {
                    const src = ch < block.channels.length ? block.channels[ch] : block.channels[0];
                    if (!src) continue;
                    output
                        .getChannelData(ch)
                        .set(src.subarray(block.offset, block.offset + toWrite), written);
                }
                written += toWrite;
                block.offset += toWrite;
                if (block.offset >= block.numFrames) this.outputQueue.shift();
            }

            if (written < frameCount) {
                for (let ch = 0; ch < output.numberOfChannels; ch++) {
                    output.getChannelData(ch).fill(0, written);
                }
            }
        };
        node.connect(this.gainNode!);
        this.scriptNode = node;
    }

    /** Hand decoded PCM to whichever output node is active. */
    private enqueue(channels: Float32Array[], numFrames: number): void {
        if (this.workletNode) {
            this.workletNode.port.postMessage(
                { channels, numFrames },
                channels.map((c) => c.buffer),
            );
            return;
        }
        if (!this.scriptNode) return;
        this.outputQueue.push({ channels, numFrames, offset: 0 });
        while (this.outputQueue.length > 50) this.outputQueue.shift();
    }

    async resume(): Promise<void> {`,
  },
  {
    file: 'src/app/audio/AudioPlayer.ts',
    from: `        audioData.close();
        this.workletNode!.port.postMessage(
            { channels, numFrames },
            channels.map((c) => c.buffer),
        );
    }`,
    to: `        audioData.close();
        this.enqueue(channels, numFrames);
    }`,
  },
  {
    file: 'src/app/audio/AudioPlayer.ts',
    from: `        this.workletNode!.port.postMessage(
            { channels, numFrames: framesPerChannel },
            channels.map((c) => c.buffer),
        );
    }`,
    to: `        this.enqueue(channels, framesPerChannel);
    }`,
  },
  {
    file: 'src/app/audio/AudioPlayer.ts',
    from: `        this.workletNode?.disconnect();
        this.gainNode?.disconnect();
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close().catch(() => {
                // Already closed elsewhere — nothing to do, and an unhandled
                // rejection here is the exact bug this method is fixing.
            });
        }
        this.decoder = undefined;
        this.workletNode = undefined;
        this.gainNode = undefined;`,
    to: `        this.workletNode?.disconnect();
        if (this.scriptNode) {
            this.scriptNode.onaudioprocess = null;
            this.scriptNode.disconnect();
        }
        this.gainNode?.disconnect();
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close().catch(() => {
                // Already closed elsewhere — nothing to do, and an unhandled
                // rejection here is the exact bug this method is fixing.
            });
        }
        this.decoder = undefined;
        this.workletNode = undefined;
        this.scriptNode = undefined;
        this.gainNode = undefined;
        this.outputQueue = [];`,
  },
];
```

In `applyEnginePatches()`, after the keyboard/UHID lines and before `AUDIO_VOLUME_PATCHES`, add:

```js
  for (const patch of AUDIO_WORKLET_FALLBACK_PATCHES) applyPatch(patch, 'audio worklet fallback');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all tests pass, including the six existing setup patch tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup.mjs tests/setup.test.mjs
git commit -m "feat: patch engine audio to survive worklet failures"
```

---

### Task 2: Apply the patch to the built engine and rebuild

**Files:**
- Modify (generated, gitignored): `engine/src/app/audio/AudioPlayer.ts`, `engine/dist/` via rebuild
- No tracked source changes expected.

**Interfaces:**
- Consumes: `AUDIO_WORKLET_FALLBACK_PATCHES` from Task 1; the engine's `npm run build` and `npm test` scripts.
- Produces: an engine build whose `AudioPlayer` contains `loadWorklet` and `createScriptProcessor`.

- [ ] **Step 1: Apply the patches to the existing engine source**

Run from the project root:

```bash
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { AUDIO_WORKLET_FALLBACK_PATCHES } from './scripts/setup.mjs';
for (const patch of AUDIO_WORKLET_FALLBACK_PATCHES) {
  const target = new URL('./engine/' + patch.file, import.meta.url);
  const source = readFileSync(target, 'utf8');
  if (source.includes(patch.to)) continue;
  if (!source.includes(patch.from)) throw new Error('anchor missing: ' + patch.file);
  writeFileSync(target, source.replace(patch.from, patch.to));
  console.log('patched', patch.file);
}
"
```

Expected: six `patched src/app/audio/AudioPlayer.ts` lines, or fewer if some patches were already applied.

- [ ] **Step 2: Verify the source now contains the fallback**

Run: `grep -c 'loadWorklet\|createScriptProcessor\|outputQueue' engine/src/app/audio/AudioPlayer.ts`
Expected: a non-zero count; `grep -n 'async start' -A 20 engine/src/app/audio/AudioPlayer.ts` shows the `this.audioContext !== context` guard.

- [ ] **Step 3: Rebuild the engine**

Run: `npm run build` in `engine/`.
Expected: webpack and `build:types` succeed; `grep -c 'AudioWorklet unavailable' engine/dist/public/ws-scrcpy.umd.js` is non-zero.

- [ ] **Step 4: Run the engine test suite**

Run: `npm test` in `engine/`.
Expected: all tests pass, including `audioPlayerStop.test.ts` (repeated `stop()` still closes once and never throws).

- [ ] **Step 5: Restart the app**

Stop the running `npm start` and start it again from the project root; confirm the bridge `:8100` and engine `:8000` respond.

---

### Task 3: Verify audio in a real browser

**Files:**
- No source changes; browser session only.

**Interfaces:**
- Consumes: the rebuilt engine from Task 2; the page's `#settings-apply` button (calls `applySettings()` → `stop()` + `startStream()`).
- Produces: console evidence that the worklet path is clean and the fallback path activates.

- [ ] **Step 1: Normal connect has no audio error**

Open `http://127.0.0.1:8000/` in the user's Chrome through browse, start console capture, and wait for status `已连接`. Read the console.
Expected: `[StreamClientScrcpy] Connected: ... audio=opus`, and **no** `Failed to start audio` / `Unable to load a worklet's module`.

- [ ] **Step 2: Force the worklet to fail and confirm the fallback runs**

In the same tab, evaluate:

```js
window.__spCalls = 0;
const original = AudioContext.prototype.createScriptProcessor;
AudioContext.prototype.createScriptProcessor = function (...args) {
  window.__spCalls += 1;
  return original.apply(this, args);
};
const probe = new AudioContext();
Object.getPrototypeOf(probe.audioWorklet).addModule = () =>
  Promise.reject(new Error('simulated worklet failure'));
probe.close();
document.getElementById('settings-apply').click();
```

Wait for status `已连接` again, then read the console and evaluate `window.__spCalls`.
Expected: console contains `[AudioPlayer] AudioWorklet unavailable, using ScriptProcessor: simulated worklet failure`; `window.__spCalls >= 1`; status stays connected; no uncaught rejection in the console.

- [ ] **Step 3: Force a hanging worklet and confirm the timeout fires**

Reload the page, then evaluate:

```js
window.__spCalls = 0;
const original = AudioContext.prototype.createScriptProcessor;
AudioContext.prototype.createScriptProcessor = function (...args) {
  window.__spCalls += 1;
  return original.apply(this, args);
};
const probe = new AudioContext();
Object.getPrototypeOf(probe.audioWorklet).addModule = () => new Promise(() => {});
probe.close();
document.getElementById('settings-apply').click();
```

Wait ~3 seconds, then check `window.__spCalls` and the console.
Expected: fallback warning mentions `timed out after 1500ms`; `window.__spCalls >= 1`; stream connected.

- [ ] **Step 4: Stop during a pending worklet load is silent**

Reload, then evaluate:

```js
const probe = new AudioContext();
Object.getPrototypeOf(probe.audioWorklet).addModule = () =>
  new Promise((resolve, reject) =>
    setTimeout(() => reject(new Error('late worklet failure')), 1000),
  );
probe.close();
document.getElementById('settings-apply').click();
setTimeout(() => document.getElementById('settings-apply').click(), 200);
```

Wait 2 seconds and read the console.
Expected: stream reconnects (or uses the fallback after the 1500 ms timeout); **no** `Failed to start audio` and no uncaught rejection from the late 1 s failure.

- [ ] **Step 5: Repeated stop/start stays clean**

Reload, then click `#settings-apply` three times with ~2 seconds between clicks, reading the console after each.
Expected: status returns to `已连接`; no `Failed to start audio`, no uncaught promise rejections, no duplicate worklet errors.

- [ ] **Step 6: Final project test run**

Run: `npm test` from the project root.
Expected: all tests pass.

- [ ] **Step 7: Record the result**

No tracked files changed in this task. Report the console evidence and any remaining limitation (the OpenCode built-in browser has no audio, but the fallback now prevents the error and real Chrome plays sound).
