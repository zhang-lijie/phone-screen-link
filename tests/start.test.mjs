import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan, copyWeb } from '../scripts/start.mjs';

test('plan enforces usb before copying and starting the engine', () => {
  const plan = buildPlan({ engineDir: '/x/engine', webDir: '/x/web' });
  assert.deepEqual(plan.map((s) => s.kind), ['enforceUsb', 'copyWeb', 'spawnEngine', 'startBridge']);
  assert.deepEqual(plan[1].files, ['index.html', 'app.js', 'styles.css', 'keys.mjs']);
  assert.equal(plan[2].command, 'node');
  assert.deepEqual(plan[2].args, ['dist/index.js']);
});

test('plan binds the control bridge to the fixed loopback port 8100', () => {
  const plan = buildPlan({ engineDir: '/x/engine', webDir: '/x/web' });
  assert.equal(plan[3].port, 8100);
});

test('plan resolves web and shared directories relative to the project', () => {
  const plan = buildPlan({ engineDir: '/x/engine', webDir: '/x/web' });
  assert.equal(plan[1].webDir, '/x/web');
  assert.equal(plan[1].sharedDir, '/x/shared');
  assert.equal(plan[2].cwd, '/x/engine');
});

test('copyWeb copies the three web files and shared keys into the public dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'phone-link-start-'));
  try {
    const webDir = join(root, 'web');
    const sharedDir = join(root, 'shared');
    const publicDir = join(root, 'engine', 'dist', 'public');
    mkdirSync(webDir, { recursive: true });
    mkdirSync(sharedDir, { recursive: true });
    const webFiles = {
      'index.html': '<html>phone link</html>',
      'app.js': 'console.log("app");',
      'styles.css': 'body { margin: 0; }',
    };
    for (const [name, content] of Object.entries(webFiles)) {
      writeFileSync(join(webDir, name), content);
    }
    writeFileSync(join(sharedDir, 'keys.mjs'), 'export const KEY_CODES = {};');

    const step = buildPlan({ engineDir: join(root, 'engine'), webDir })[1];
    copyWeb(step, publicDir);

    assert.deepEqual(readdirSync(publicDir).sort(), ['app.js', 'index.html', 'keys.mjs', 'styles.css']);
    for (const [name, content] of Object.entries(webFiles)) {
      assert.equal(readFileSync(join(publicDir, name), 'utf8'), content);
    }
    assert.equal(readFileSync(join(publicDir, 'keys.mjs'), 'utf8'), 'export const KEY_CODES = {};');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
