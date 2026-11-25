import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('stream keeps a 400px minimum in normal and docked layouts', () => {
  assert.match(css, /#stream\s*\{[^}]*min-width:\s*400px;/);
  assert.match(css, /body\.chat-docked #stream\s*\{[^}]*min-width:\s*400px;/);
});

test('chat dock button exposes floating, docked and disabled states', () => {
  assert.match(css, /\.chat-head-actions button svg\s*\{[^}]*fill:\s*currentColor;/);
  assert.match(css, /#chat-dock:not\(:disabled\)\s*\{[^}]*color:\s*#fff;/);
  assert.match(css, /body\.chat-docked #chat-dock\s*\{[^}]*color:\s*#10b981;/);
  assert.match(css, /\.chat-head-actions button:disabled\s*\{[^}]*opacity:\s*0\.4;/);
  assert.match(html, /id="chat-dock"[^>]*aria-pressed="false"/);
  assert.match(app, /chatDockButton\.setAttribute\('aria-pressed', String\(chatDocked\)\)/);
});
