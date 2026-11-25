import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match?.[1] ?? null;
}

// The dock button's colour is the mode indicator. Floating is near-white,
// docked uses the project's success green, and hover must not wash it out.
test('chat dock button colour follows the docked state', () => {
  const selectors = [
    '#chat-dock',
    'body.chat-docked #chat-dock',
    'body.chat-docked #chat-dock:hover',
  ];
  for (const selector of selectors) {
    assert.ok(ruleBody(selector), `${selector} rule exists`);
    assert.doesNotMatch(selector, /:enabled/, `${selector} applies even when disabled`);
  }
  assert.match(ruleBody('#chat-dock'), /color:\s*var\(--ui-text-color\)\s*;/);
  assert.match(ruleBody('body.chat-docked #chat-dock'), /color:\s*#5fd39b\s*;/i);
  assert.match(ruleBody('body.chat-docked #chat-dock:hover'), /color:\s*#5fd39b\s*;/i);
  // The SVG icon has no fill attribute; without this rule its path stays
  // black no matter what colour the button has.
  assert.match(ruleBody('#chat-dock svg'), /fill:\s*currentColor\s*;/);
});
