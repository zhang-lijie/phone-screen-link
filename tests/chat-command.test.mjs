import test from 'node:test';
import assert from 'node:assert/strict';
import { runPresetCommand } from '../server/chat-agent.mjs';
import { PRESET_COMMANDS } from '../shared/chat-commands.mjs';

function deps({ locked = false, toolResult = { content: [{ type: 'text', text: 'done' }] } } = {}) {
  const calls = [];
  return {
    calls,
    isLocked: async () => locked,
    callTool: async (name, args) => { calls.push([name, args]); return toolResult; },
  };
}

test('preset command: locked phone refuses without calling tool', async () => {
  const d = deps({ locked: true });
  const r = await runPresetCommand({ commandId: 'desktop', lang: 'zh', deps: d });
  assert.equal(d.calls.length, 0);
  assert.match(r.reply, /解锁/);
  assert.equal(r.ok, false);
});

test('preset command: unknown id refused without calling tool', async () => {
  const d = deps();
  const r = await runPresetCommand({ commandId: '__no__', lang: 'en', deps: d });
  assert.equal(d.calls.length, 0);
  assert.equal(r.ok, false);
});

test('preset command: desktop calls press_key with KEYCODE_HOME', async () => {
  const d = deps();
  const r = await runPresetCommand({ commandId: 'desktop', lang: 'zh', deps: d });
  assert.deepEqual(d.calls, [['press_key', { key: 'KEYCODE_HOME' }]]);
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'done');
});

test('preset command: screenshot result text is returned, tool error is ok:false', async () => {
  const ok = deps({ toolResult: { content: [{ type: 'text', text: 'screenshot saved' }], isError: false } });
  const r1 = await runPresetCommand({ commandId: 'screenshot', lang: 'en', deps: ok });
  assert.equal(r1.ok, true);
  assert.equal(r1.reply, 'screenshot saved');

  const bad = deps({ toolResult: { content: [{ type: 'text', text: 'oops' }], isError: true } });
  const r2 = await runPresetCommand({ commandId: 'screenshot', lang: 'en', deps: bad });
  assert.equal(r2.ok, false);
});

test('preset command: all 11 commands resolve to a mapped tool', async () => {
  for (const c of PRESET_COMMANDS) {
    const d = deps();
    const r = await runPresetCommand({ commandId: c.id, lang: 'zh', deps: d });
    assert.equal(r.ok, true, c.id);
    assert.deepEqual(d.calls[0], [c.tool, c.args], c.id);
  }
});
