import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('every standalone normal-layout stream rule keeps a 400px minimum', () => {
  const normalRules = [...css.matchAll(/^[ \t]*#stream\s*\{([^}]*)\}/gm)];
  assert.ok(normalRules.length >= 2, 'expected the base and later standalone #stream rules');
  for (const [index, rule] of normalRules.entries()) {
    assert.match(rule[1], /min-width:\s*400px;/, `standalone #stream rule ${index + 1}`);
  }
  assert.match(css, /body\.chat-docked #stream\s*\{[^}]*min-width:\s*400px;/);
});

test('chat dock button exposes floating, docked and disabled states', () => {
  assert.match(css, /\.chat-head-actions button svg\s*\{[^}]*fill:\s*currentColor;/);
  assert.match(css, /^#chat-dock\s*\{[^}]*color:\s*var\(--ui-text-color\);/m);
  assert.match(css, /^body\.chat-docked #chat-dock\s*\{[^}]*color:\s*#5fd39b;/m);
  assert.match(css, /\.chat-head-actions button:disabled\s*\{[^}]*opacity:\s*0\.4;/);
  assert.match(html, /id="chat-dock"[^>]*aria-pressed="false"/);
  assert.match(app, /chatDockButton\.setAttribute\('aria-pressed', String\(chatDocked\)\)/);
});

test('chat dock button refreshes on resize in both directions', () => {
  assert.match(app, /window\.addEventListener\('resize',\s*\(\)\s*=>\s*\{\s*setChatDockButton\(\);/);
});

test('README avoids exact test-count snapshots that become stale', () => {
  assert.doesNotMatch(readme, /共\s*256\s*个\s*node\s*用例/);
  assert.doesNotMatch(readme, /另有\s*22\s*个\s*python\s*用例/);
  assert.doesNotMatch(readme, /运行\s*256\s*个\s*node\s*单元测试/);
});

test('README documents the 400px stream and 240px chat dock minimums', () => {
  assert.match(readme, /画面侧最小 400px、聊天侧最小 240px/);
  assert.match(readme, /画面 ≥ 400px、聊天 ≥ 240px/);
});
