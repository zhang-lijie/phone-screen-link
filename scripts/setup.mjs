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

function run(command, args, cwd) {
  console.log(`+ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function applyLoopbackPatch() {
  const target = join(engineDir(), LOOPBACK_PATCH.file);
  const source = readFileSync(target, 'utf8');
  if (source.includes(LOOPBACK_PATCH.to)) {
    return;
  }
  if (!source.includes(LOOPBACK_PATCH.from)) {
    throw new Error(`upstream drifted: ${LOOPBACK_PATCH.file} contains neither listen call`);
  }
  writeFileSync(target, source.replace(LOOPBACK_PATCH.from, LOOPBACK_PATCH.to));
  console.log(`patched ${LOOPBACK_PATCH.file} to bind 127.0.0.1`);
}

export function setup() {
  const distEntry = join(engineDir(), 'dist', 'index.js');
  if (existsSync(distEntry)) {
    console.log(`engine already built at ${distEntry}; skipping setup`);
    return;
  }

  // The clone target does not exist yet, so it runs from the project root;
  // every other command runs inside the engine checkout.
  run('git', ['clone', '--depth', '1', '--branch', ENGINE_TAG, ENGINE_REPO, engineDir()], projectDir);
  run('npm', ['install'], engineDir());
  applyLoopbackPatch();
  run('npm', ['run', 'stage-seed'], engineDir());
  run('npm', ['run', 'build'], engineDir());
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  setup();
}
