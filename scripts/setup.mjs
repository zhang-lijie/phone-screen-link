import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENGINE_REPO = 'https://github.com/bilbospocketses/ws-scrcpy-web.git';
export const ENGINE_TAG = 'v0.5.13';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function engineDir() {
  return join(projectDir, 'engine');
}

export const LOOPBACK_PATCH = {
  file: 'src/server/services/HttpServer.ts',
  from: 'server.listen(port, () => {',
  to: "server.listen(port, '127.0.0.1', () => {",
};

// Scale wheel-scroll distance by a runtime global so the web page can turn a
// single wheel tick into a larger phone-screen scroll without re-dispatching
// N synthetic events (which scrcpy coalesces and delays).
// Expose audio volume on the public stream handle so the web page can mute or
// adjust the phone audio that the engine decodes and plays in the browser.
export const AUDIO_VOLUME_PATCHES = [
  {
    file: 'src/app/googDevice/client/StreamClientScrcpy.ts',
    from: `    public setDpadMode(enabled: boolean): void {
        this.touchHandler?.setDpadMode(enabled);
    }`,
    to: `    public setAudioVolume(volume: number): void {
        this.audioPlayer?.setVolume(volume);
    }

    public setDpadMode(enabled: boolean): void {
        this.touchHandler?.setDpadMode(enabled);
    }`,
  },
  {
    file: 'src/app/public/types.ts',
    from: `export interface StreamHandle {
    stop(): void;
    readonly isConnected: boolean;
    readonly deviceId: string;
}`,
    to: `export interface StreamHandle {
    stop(): void;
    readonly isConnected: boolean;
    readonly deviceId: string;
    setAudioVolume?(volume: number): void;
}`,
  },
  {
    file: 'src/app/public/startStream.ts',
    from: `    try {
        const { instance, stop } = StreamClientScrcpy.start(`,
    to: `    let streamInstance: any;
    try {
        const { instance, stop } = StreamClientScrcpy.start(`,
  },
  {
    file: 'src/app/public/startStream.ts',
    from: `        stopFn = () => {
            stop();
            container.removeAttribute(ACTIVE_STREAM_ATTR);
        };`,
    to: `        streamInstance = instance;
        stopFn = () => {
            stop();
            container.removeAttribute(ACTIVE_STREAM_ATTR);
        };`,
  },
  {
    file: 'src/app/public/startStream.ts',
    from: `    return {
        stop(): void {
            if (stopped) return;`,
    to: `    return {
        setAudioVolume(volume: number): void {
            streamInstance?.setAudioVolume?.(volume);
        },
        stop(): void {
            if (stopped) return;`,
  },
];

// Expose session resize (device rotation) through the public stream handle so
// the web page can react to portrait/landscape changes.
export const RESIZE_PATCHES = [
  {
    file: 'src/app/googDevice/client/StreamClientScrcpy.ts',
    from: `    private onSessionChange = (change: { width: number; height: number }): void => {
        console.log(TAG, \`Session resized: \${change.width}x\${change.height}\`);`,
    to: `    public onResizeReceived?: ((info: { width: number; height: number }) => void) | undefined;

    private onSessionChange = (change: { width: number; height: number }): void => {
        console.log(TAG, \`Session resized: \${change.width}x\${change.height}\`);
        this.onResizeReceived?.(change);`,
  },
  {
    file: 'src/app/public/types.ts',
    from: `    onError?: ((err: Error) => void) | undefined;`,
    to: `    onError?: ((err: Error) => void) | undefined;
    onResize?: ((info: { width: number; height: number }) => void) | undefined;`,
  },
  {
    file: 'src/app/public/startStream.ts',
    from: `    onMetadataReceived?: (info: StreamInfo) => void;
    onErrorReceived?: (err: Error) => void;
}`,
    to: `    onMetadataReceived?: (info: StreamInfo) => void;
    onErrorReceived?: (err: Error) => void;
    onResizeReceived?: (info: { width: number; height: number }) => void;
}`,
  },
  {
    file: 'src/app/public/startStream.ts',
    from: `        hooked.onErrorReceived = (err: Error) => {
            // A failed stream reports here INSTEAD of the disconnect callback
            // above, so it must clear the flag too.
            isConnected = false;
            options.onError?.(err);
        };`,
    to: `        hooked.onErrorReceived = (err: Error) => {
            // A failed stream reports here INSTEAD of the disconnect callback
            // above, so it must clear the flag too.
            isConnected = false;
            options.onError?.(err);
        };
        hooked.onResizeReceived = (info: { width: number; height: number }) => {
            options.onResize?.(info);
        };`,
  },
];

export const WHEEL_SCALE_PATCH = {
  file: 'src/app/interactionHandler/FeaturedInteractionHandler.ts',
  from: `            const hScroll = event.deltaX > 0 ? -1 : event.deltaX < 0 ? 1 : 0;
            const vScroll = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;`,
  to: `            const scale = Math.max(1, Number((window as any).__wheelScrollScale) || 1);
            const hScroll = (event.deltaX > 0 ? -1 : event.deltaX < 0 ? 1 : 0) * scale;
            const vScroll = (event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0) * scale;`,
};

// Focus decides who owns the keyboard: while a text field has focus, its keys
// must stay in the browser instead of being forwarded to the phone.
export const KEYBOARD_FOCUS_PATCH = {
  file: 'src/app/googDevice/KeyInputHandler.ts',
  from: `    private static handler = (event: Event): void => {
        const keyboardEvent = event as KeyboardEvent;
        const keyCode = KeyToCodeMap.get(keyboardEvent.code);`,
  to: `    private static handler = (event: Event): void => {
        const keyboardEvent = event as KeyboardEvent;
        const target = keyboardEvent.target;
        if (
            target instanceof HTMLElement &&
            (target.isContentEditable ||
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'SELECT')
        ) {
            return;
        }
        const keyCode = KeyToCodeMap.get(keyboardEvent.code);`,
};

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
  {
    file: 'src/app/audio/AudioPlayer.ts',
    from: `    async resume(): Promise<void> {
        if (this.audioContext?.state === 'suspended') {
            await this.audioContext.resume();
        }
    }`,
    to: `    async resume(): Promise<void> {
        const context = this.audioContext;
        if (context?.state !== 'suspended') return;
        await context.resume().catch((error: unknown) => {
            // stop() can close the context while resume() is pending. That is
            // expected during stream replacement and must stay silent.
            if (
                !this.started ||
                this.audioContext !== context ||
                (error instanceof DOMException && error.name === 'InvalidStateError')
            ) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[AudioPlayer] Failed to resume audio:', message);
        });
    }`,
  },
];

// UHID input is an alternative keyboard path enabled from the engine toolbox.
// It bypasses KeyInputHandler entirely, so it needs the same focus guard or
// typing in the chat/settings fields still drives the phone.
const UHID_EDITABLE_GUARD = `        const target = event.target;
        if (
            target instanceof HTMLElement &&
            (target.isContentEditable ||
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'SELECT')
        ) {
            return;
        }
`;

export const UHID_KEYBOARD_FOCUS_PATCHES = ['KeyDown', 'KeyUp'].map((suffix) => ({
  file: 'src/app/googDevice/UhidKeyboardHandler.ts',
  from: `    private on${suffix}(event: KeyboardEvent): void {
        event.preventDefault();`,
  to: `    private on${suffix}(event: KeyboardEvent): void {
${UHID_EDITABLE_GUARD}        event.preventDefault();`,
}));

// macOS arm64 (Apple Silicon) bootstrap. Engine's fetch-node.mjs only knows
// win32/linux; add the pinned darwin-arm64 Node archive (verified present and
// sha256-published on nodejs.org). Intel Mac stays unsupported upstream.
export const FETCH_NODE_DARWIN_PATCH = {
  file: 'scripts/fetch-node.mjs',
  from: `    if (process.platform === 'linux') {
        return {
            archiveName: LINUX_ARCHIVE_NAME,
            archiveSha256: LINUX_ARCHIVE_SHA256,
            innerRel: LINUX_INNER_NODE_REL,
            seedNodeName: 'node',
        };
    }
    throw new Error(
        \`Unsupported platform: \${process.platform}. \` +
            'Node bootstrap fetch is implemented for win32 and linux only ' +
            '(those are the platforms we ship installers for).',
    );`,
  to: `    if (process.platform === 'linux') {
        return {
            archiveName: LINUX_ARCHIVE_NAME,
            archiveSha256: LINUX_ARCHIVE_SHA256,
            innerRel: LINUX_INNER_NODE_REL,
            seedNodeName: 'node',
        };
    }
    if (process.platform === 'darwin' && process.arch === 'arm64') {
        return {
            archiveName: 'node-v24.19.0-darwin-arm64.tar.xz',
            archiveSha256: '3f1cf157479c1480352083105e13faf9d008ede98e7e157746b6df940d197b94',
            innerRel: path.join('node-v24.19.0-darwin-arm64', 'bin', 'node'),
            seedNodeName: 'node',
        };
    }
    throw new Error(
        \`Unsupported platform: \${process.platform}. \` +
            'Node bootstrap fetch is implemented for win32, linux and darwin-arm64 only ' +
            '(Intel Mac is not supported).',
    );`,
};

// adb platform-tools: getPlatform() and adbArchiveName() both hardcode linux;
// both must be widened or the darwin archive name stays wrong.
export const ADB_DARWIN_PATCH = [
  {
    file: 'src/server/DependencyDefinitions.ts',
    from: `export function getPlatform(): 'win32' | 'linux' {
    return os.platform() === 'win32' ? 'win32' : 'linux';
}`,
    to: `export function getPlatform(): 'win32' | 'linux' | 'darwin' {
    return os.platform() === 'win32' ? 'win32' : os.platform() === 'darwin' ? 'darwin' : 'linux';
}`,
  },
  {
    file: 'src/server/DependencyDefinitions.ts',
    from: "    return `platform-tools_r${version}-${getPlatform() === 'win32' ? 'win' : 'linux'}.zip`;",
    to: "    return `platform-tools_r${version}-${getPlatform() === 'win32' ? 'win' : getPlatform() === 'darwin' ? 'darwin' : 'linux'}.zip`;",
  },
];

// node-pty prebuilt key: darwin must not fall through to the linux/glibc key.
export const PREBUILT_DARWIN_PATCH = {
  file: 'scripts/fetch-prebuilts.mjs',
  from: "    const platform = process.platform === 'win32' ? 'win32' : 'linux';",
  to: "    const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';",
};

// Runtime node-pty resolution (NodePtyResolver.ts) also hardcodes darwin to
// linux — patching only fetch-prebuilts.mjs leaves shell broken on a Mac.
export const NODEPTY_DARWIN_PATCH = [
  {
    file: 'src/server/NodePtyResolver.ts',
    from: `export interface HostInfo {
    platform: 'win32' | 'linux';`,
    to: `export interface HostInfo {
    platform: 'win32' | 'linux' | 'darwin';`,
  },
  {
    file: 'src/server/NodePtyResolver.ts',
    from: "    const platform = (process.platform === 'win32' ? 'win32' : 'linux') as HostInfo['platform'];",
    to: "    const platform = (process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux') as HostInfo['platform'];",
  },
];

// Node dependency auto-download uses a linux archive for every non-win32
// platform; a fresh Mac would install a Linux ELF into dependencies/node/.
export const NODE_URL_DARWIN_PATCH = [
  {
    file: 'src/server/DependencyDefinitions.ts',
    from: `                return \`\${nodeDistBase()}/v\${version}/node-v\${version}-linux-\${arch}.tar.gz\`;`,
    to: `                if (platform === 'darwin') {
                    return \`\${nodeDistBase()}/v\${version}/node-v\${version}-darwin-\${arch}.tar.gz\`;
                }
                return \`\${nodeDistBase()}/v\${version}/node-v\${version}-linux-\${arch}.tar.gz\`;`,
  },
  {
    file: 'src/server/DependencyManager.ts',
    from: "        platform: 'win32' | 'linux',\n    ): Promise<void> {\n        const destDir = path.join(this.depsPath, 'node');",
    to: "        platform: 'win32' | 'linux' | 'darwin',\n    ): Promise<void> {\n        const destDir = path.join(this.depsPath, 'node');",
  },
  {
    file: 'src/server/DependencyManager.ts',
    from: "    private async installAdb(downloadPath: string, tmpDir: string, platform: 'win32' | 'linux'): Promise<void> {",
    to: "    private async installAdb(downloadPath: string, tmpDir: string, platform: 'win32' | 'linux' | 'darwin'): Promise<void> {",
  },
];

function run(command, args, cwd) {
  console.log(`+ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function applyPatch(patch, description) {
  const target = join(engineDir(), patch.file);
  const source = readFileSync(target, 'utf8');
  if (source.includes(patch.to)) {
    return;
  }
  if (!source.includes(patch.from)) {
    throw new Error(`upstream drifted: ${patch.file} no longer matches the patch anchor`);
  }
  writeFileSync(target, source.replace(patch.from, patch.to));
  console.log(`patched ${patch.file} (${description})`);
}

function applyEnginePatches() {
  applyPatch(LOOPBACK_PATCH, 'bind 127.0.0.1');
  applyPatch(WHEEL_SCALE_PATCH, 'wheel scroll scale');
  applyPatch(KEYBOARD_FOCUS_PATCH, 'keyboard focus handoff');
  for (const patch of UHID_KEYBOARD_FOCUS_PATCHES) applyPatch(patch, 'UHID keyboard focus handoff');
  for (const patch of AUDIO_WORKLET_FALLBACK_PATCHES) applyPatch(patch, 'audio worklet fallback');
  for (const patch of AUDIO_VOLUME_PATCHES) applyPatch(patch, 'audio volume handle');
  for (const patch of RESIZE_PATCHES) applyPatch(patch, 'resize handle');
  applyPatch(FETCH_NODE_DARWIN_PATCH, 'darwin-arm64 node bootstrap');
  for (const patch of ADB_DARWIN_PATCH) applyPatch(patch, 'darwin adb archive');
  applyPatch(PREBUILT_DARWIN_PATCH, 'darwin prebuilt platform');
  for (const patch of NODEPTY_DARWIN_PATCH) applyPatch(patch, 'darwin node-pty resolver');
  for (const patch of NODE_URL_DARWIN_PATCH) applyPatch(patch, 'darwin node download url');
}

export function checkGhostToolchain({ exec = execFileSync, log = console.log } = {}) {
  const probe = (command) => {
    try {
      exec(command, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  if (probe('uvx')) return 'uvx';
  if (probe('uv')) return 'uv';
  log('warning: neither `uvx` nor `uv` was found on PATH.');
  log('  The chat agent drives the phone through ghost-in-the-droid, started as');
  log('  `uvx --from ghost-in-the-droid android-agent-mcp`. Install uv to enable chat:');
  log('    curl -LsSf https://astral.sh/uv/install.sh | sh');
  log('  Mirrors and button controls keep working without it; only /chat is disabled.');
  return null;
}

export function setup() {
  // Advisory only: a missing ghost toolchain must not block building the engine.
  checkGhostToolchain();

  const distEntry = join(engineDir(), 'dist', 'index.js');
  if (existsSync(distEntry)) {
    console.log(`engine already built at ${distEntry}; skipping setup`);
    return;
  }

  // The clone target does not exist yet, so it runs from the project root;
  // every other command runs inside the engine checkout.
  run('git', ['clone', '--depth', '1', '--branch', ENGINE_TAG, ENGINE_REPO, engineDir()], projectDir);
  run('npm', ['install'], engineDir());
  applyEnginePatches();
  run('npm', ['run', 'stage-seed'], engineDir());
  run('npm', ['run', 'build'], engineDir());
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  setup();
}
