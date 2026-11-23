import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESET_COMMANDS,
  findCommands,
  resolveCommand,
  truncateResult,
} from '../shared/chat-commands.mjs';

test('preset commands: 11 commands each with id, triggers, note and tool', () => {
  assert.equal(PRESET_COMMANDS.length, 11);
  const ids = new Set(PRESET_COMMANDS.map((c) => c.id));
  assert.equal(ids.size, 11, 'ids unique');
  for (const c of PRESET_COMMANDS) {
    assert.ok(c.id && Array.isArray(c.triggers) && c.triggers.length > 0, c.id);
    assert.ok(c.note && typeof c.note === 'object', c.id);
    assert.ok(c.tool && typeof c.tool === 'string', c.id);
  }
  // mapped tools must all be in the agent allowlist in spirit (safe actions)
  const byId = Object.fromEntries(PRESET_COMMANDS.map((c) => [c.id, c]));
  assert.equal(byId.desktop.tool, 'press_key');
  assert.deepEqual(byId.desktop.args, { key: 'KEYCODE_HOME' });
  assert.equal(byId.apps.tool, 'press_key');
  assert.deepEqual(byId.apps.args, { key: 'KEYCODE_APP_SWITCH' });
});

test('findCommands: filters by latin and chinese triggers, empty query returns all', () => {
  assert.equal(findCommands('').length, 11);
  const desk = findCommands('desktop');
  assert.deepEqual(desk.map((c) => c.id), ['desktop']);
  assert.deepEqual(findCommands('/desktop').map((c) => c.id), ['desktop']);
  assert.deepEqual(findCommands('回').map((c) => c.id), ['desktop']);
  assert.deepEqual(findCommands('桌').map((c) => c.id), ['desktop']);
  assert.deepEqual(findCommands('截图').map((c) => c.id), ['screenshot']);
  assert.deepEqual(findCommands('截').map((c) => c.id), ['screenshot']);
  assert.deepEqual(findCommands('nonexistent'), []);
});

test('resolveCommand: matches exact id or a trigger token, case-insensitive latin', () => {
  const byId = Object.fromEntries(PRESET_COMMANDS.map((c) => [c.id, c]));
  assert.equal(resolveCommand('desktop')?.id, 'desktop');
  assert.equal(resolveCommand('DESKTOP')?.id, 'desktop');
  assert.equal(resolveCommand('回')?.id, 'desktop');
  assert.equal(resolveCommand('桌')?.id, 'desktop');
  assert.equal(resolveCommand('/back')?.id, 'back');
  assert.equal(resolveCommand('__no__'), null);
});

test('truncateResult: caps long tool output and appends notice', () => {
  assert.equal(truncateResult('short'), 'short');
  const long = 'x'.repeat(1000);
  const out = truncateResult(long);
  assert.ok(out.includes('[结果已截断]'), out.slice(-30));
  assert.ok(out.length < 600, out.length);
});
