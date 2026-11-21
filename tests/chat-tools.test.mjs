import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_TOOLS,
  DENIED_TOOLS,
  filterToolDefinitions,
  isAllowedTool,
  validateToolArgs,
} from '../shared/chat-tools.mjs';

const EXPECTED_ALLOWED = [
  'dump_ui',
  'get_screen_tree',
  'get_phone_state',
  'list_apps',
  'find_on_screen',
  'tap',
  'tap_element',
  'swipe',
  'type_text',
  'press_back',
  'press_home',
  'press_key',
  'launch_app',
  'clipboard_set',
  'screenshot',
];

test('chat tools: ALLOWED_TOOLS is the exact allowlist', () => {
  assert.deepEqual(ALLOWED_TOOLS, EXPECTED_ALLOWED);
});

test('chat tools: DENIED_TOOLS names dangerous ghost tools', () => {
  for (const name of ['shell', 'install', 'uninstall', 'clipboard_get', 'unlock_device']) {
    assert.ok(DENIED_TOOLS.includes(name), `${name} should be denied`);
  }
});

test('chat tools: isAllowedTool gates by allowlist', () => {
  assert.equal(isAllowedTool('shell', {}), false);
  assert.equal(isAllowedTool('tap', {}), true);
});

test('chat tools: screenshot is gated by config.screenshot', () => {
  assert.equal(isAllowedTool('screenshot', { screenshot: false }), false);
  assert.equal(isAllowedTool('screenshot', { screenshot: true }), true);
});

test('chat tools: filterToolDefinitions keeps only allowed tools in OpenAI format', () => {
  const tools = [
    { name: 'tap', description: 'Tap the screen', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } },
    { name: 'shell', description: 'Run a shell command', inputSchema: { type: 'object' } },
  ];

  const filtered = filterToolDefinitions(tools, { screenshot: false });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].type, 'function');
  assert.equal(filtered[0].function.name, 'tap');
  assert.equal(filtered[0].function.description, 'Tap the screen');
  assert.deepEqual(filtered[0].function.parameters, tools[0].inputSchema);
});

test('chat tools: filterToolDefinitions respects screenshot config', () => {
  const tools = [
    { name: 'screenshot', description: 'Take a screenshot', inputSchema: { type: 'object' } },
    { name: 'get_phone_state', description: 'Phone state', inputSchema: { type: 'object' } },
  ];

  const withoutScreenshot = filterToolDefinitions(tools, { screenshot: false });
  assert.deepEqual(withoutScreenshot.map((t) => t.function.name), ['get_phone_state']);

  const withScreenshot = filterToolDefinitions(tools, { screenshot: true });
  assert.deepEqual(withScreenshot.map((t) => t.function.name), ['screenshot', 'get_phone_state']);
});

test('chat tools: validateToolArgs checks required fields', () => {
  const definitions = [{ name: 'tap', inputSchema: { required: ['x', 'y'] } }];

  assert.equal(validateToolArgs('tap', {}, definitions).ok, false);
  assert.equal(validateToolArgs('tap', { x: 1, y: 2 }, definitions).ok, true);
});

test('chat tools: validateToolArgs checks basic property types', () => {
  const definitions = [{
    name: 'type_text',
    inputSchema: {
      required: ['text'],
      properties: { text: { type: 'string' }, clear: { type: 'boolean' } },
    },
  }];

  assert.equal(validateToolArgs('type_text', { text: 5 }, definitions).ok, false);
  assert.equal(validateToolArgs('type_text', { text: 'hi', clear: 'yes' }, definitions).ok, false);
  assert.equal(validateToolArgs('type_text', { text: 'hi', clear: true }, definitions).ok, true);
});

test('chat tools: validateToolArgs rejects unknown tools and non-object args', () => {
  assert.equal(validateToolArgs('shell', {}, []).ok, false);
  assert.equal(validateToolArgs('tap', null, [{ name: 'tap', inputSchema: {} }]).ok, false);
});

test('chat tools: validateToolArgs rejects a denied tool even when its definition exists', () => {
  const result = validateToolArgs('shell', {}, [{ name: 'shell', inputSchema: {} }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /shell/);
});
