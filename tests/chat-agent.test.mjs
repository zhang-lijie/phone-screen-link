import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTurn } from '../server/chat-agent.mjs';

const TAP_SCHEMA = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
};

// Raw ghost MCP tools/list entries (the shape validateToolArgs consumes).
function ghostTools() {
  return [
    { name: 'get_phone_state', description: 'state', inputSchema: { type: 'object', properties: {} } },
    { name: 'tap', description: 'tap', inputSchema: TAP_SCHEMA },
    { name: 'screenshot', description: 'screenshot', inputSchema: { type: 'object', properties: {} } },
    { name: 'shell', description: 'shell', inputSchema: { type: 'object', properties: {} } },
  ];
}

function fakeDeps({ locked = false, responses = [], toolResults = {} } = {}) {
  const deps = {
    listToolsCalls: 0,
    isLockedCalls: 0,
    ghostCalls: [],
    chatCalls: [],
    async isLocked() {
      deps.isLockedCalls += 1;
      return locked;
    },
    async listTools() {
      deps.listToolsCalls += 1;
      return ghostTools();
    },
    async callTool(name, args) {
      deps.ghostCalls.push([name, args]);
      return toolResults[name] ?? { content: [{ type: 'text', text: `${name} done` }] };
    },
    async chatCompletion(params) {
      deps.chatCalls.push(params);
      const next = responses.length > 1 ? responses.shift() : responses[0];
      return next ?? { content: 'fallback', toolCalls: [] };
    },
  };
  return deps;
}

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3',
    maxSteps: 8,
    screenshot: true,
    apiKey: '',
    ...overrides,
  };
}

test('agent loop: lock authorization and tool injection stay pinned to the serial captured for the turn', async () => {
  let serial = 'USB-TURN';
  const lockTargets = [];
  const toolTargets = [];
  const deps = fakeDeps({
    responses: [
      { content: null, toolCalls: [{ id: 't1', name: 'tap', arguments: { x: 1, y: 2 } }] },
      { content: 'done', toolCalls: [] },
    ],
  });
  deps.getSerial = () => serial;
  deps.isLocked = async (target) => { lockTargets.push(target); return false; };
  deps.callTool = async (name, args, target) => {
    toolTargets.push(target);
    return { content: [{ type: 'text', text: 'tapped' }] };
  };
  deps.chatCompletion = async (params) => {
    deps.chatCalls.push(params);
    if (deps.chatCalls.length === 1) {
      serial = 'WIFI-SWITCHED-MID-TURN';
      return { content: null, toolCalls: [{ id: 't1', name: 'tap', arguments: { x: 1, y: 2 } }] };
    }
    return { content: 'done', toolCalls: [] };
  };

  const result = await runAgentTurn({ config: makeConfig(), userText: 'tap', lang: 'en', deps });

  assert.equal(result.reply, 'done');
  assert.deepEqual(lockTargets, ['USB-TURN']);
  assert.deepEqual(toolTargets, ['USB-TURN']);
});

test('agent loop: locked phone returns unlock hint without calling the model', async () => {
  const deps = fakeDeps({
    locked: true,
    responses: [{ content: 'must not be reached', toolCalls: [] }],
  });

  const result = await runAgentTurn({
    config: makeConfig(),
    ghost: null,
    userText: '打开设置',
    lang: 'zh',
    deps,
  });

  assert.equal(deps.chatCalls.length, 0, 'model must not be called while locked');
  assert.equal(deps.listToolsCalls, 0, 'tools must not even be listed while locked');
  assert.deepEqual(deps.ghostCalls, []);
  assert.equal(deps.isLockedCalls, 1);
  assert.deepEqual(result.steps, []);
  assert.match(result.reply, /解锁/);
});

test('agent loop: lock gate uses the injected lock checker', async () => {
  const lockedDeps = fakeDeps({ locked: true });
  const locked = await runAgentTurn({
    config: makeConfig(),
    userText: 'open settings',
    lang: 'en',
    deps: lockedDeps,
  });
  assert.match(locked.reply, /unlock/i);
  assert.equal(lockedDeps.chatCalls.length, 0);

  const unlockedDeps = fakeDeps({
    locked: false,
    responses: [{ content: 'ok', toolCalls: [] }],
  });
  const unlocked = await runAgentTurn({ config: makeConfig(), userText: 'hi', lang: 'en', deps: unlockedDeps });
  assert.equal(unlocked.reply, 'ok');
  assert.equal(unlockedDeps.chatCalls.length, 1);
});

test('agent loop: lock gate fails closed if the lock checker throws', async () => {
  for (const fail of [async () => { throw new Error('adb offline'); }, async () => undefined]) {
    const deps = fakeDeps({ responses: [{ content: 'must not be reached', toolCalls: [] }] });
    deps.isLocked = fail;
    const result = await runAgentTurn({ config: makeConfig(), userText: 'hi', lang: 'en', deps });
    assert.equal(deps.chatCalls.length, 0);
    assert.deepEqual(result.steps, []);
    assert.match(result.reply, /locked or asleep/i);
  }
});

test('agent loop: a hanging model call times out with a readable error', async () => {
  const deps = fakeDeps({});
  deps.chatCompletion = () => new Promise(() => {}); // never resolves, ignores the signal
  deps.timeoutMs = 50;

  await assert.rejects(
    runAgentTurn({ config: makeConfig(), userText: 'hi', lang: 'en', deps }),
    /timed out after 50ms/i,
  );
});

test('agent loop: every model call carries an abort signal', async () => {
  const deps = fakeDeps({ responses: [{ content: 'ok', toolCalls: [] }] });
  await runAgentTurn({ config: makeConfig(), userText: 'hi', lang: 'en', deps });
  assert.equal(deps.chatCalls.length, 1);
  assert.ok(deps.chatCalls[0].signal instanceof AbortSignal, 'model call must receive an AbortSignal');
});

test('agent loop: missing tool_call ids are synthesized consistently across assistant and tool messages', async () => {
  const deps = fakeDeps({
    responses: [
      {
        content: null,
        toolCalls: [
          { name: 'tap', arguments: { x: 1, y: 2 } }, // id missing entirely
          { id: '', name: 'tap', arguments: { x: 3, y: 4 } }, // id empty
        ],
      },
      { content: null, toolCalls: [{ name: 'tap', arguments: { x: 5, y: 6 } }] },
      { content: 'done', toolCalls: [] },
    ],
  });

  const result = await runAgentTurn({ config: makeConfig(), userText: 'tap thrice', lang: 'en', deps });
  assert.equal(result.reply, 'done');

  const second = deps.chatCalls[1].messages;
  const assistant = second.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.deepEqual(assistant.tool_calls.map((c) => c.id), ['call_0_0', 'call_0_1']);
  const toolIds = second.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(toolIds, ['call_0_0', 'call_0_1'], 'tool results must echo the synthesized ids');

  const third = deps.chatCalls[2].messages;
  const assistant2 = third.filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)).at(-1);
  assert.deepEqual(assistant2.tool_calls.map((c) => c.id), ['call_1_0'], 'ids must be unique per step');
  assert.ok(third.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1_0'));
});

test('agent loop: empty tool output gets a placeholder, empty screenshot keeps its caption', async () => {
  const tapDeps = fakeDeps({
    responses: [
      { content: null, toolCalls: [{ id: 't1', name: 'tap', arguments: { x: 1, y: 2 } }] },
      { content: 'done', toolCalls: [] },
    ],
    toolResults: { tap: { content: [] } },
  });
  await runAgentTurn({ config: makeConfig(), userText: 'tap', lang: 'en', deps: tapDeps });
  const tapTool = tapDeps.chatCalls[1].messages.find((m) => m.role === 'tool');
  assert.equal(tapTool.content, '(no output)');

  const shotDeps = fakeDeps({
    responses: [
      { content: null, toolCalls: [{ id: 's1', name: 'screenshot', arguments: {} }] },
      { content: 'done', toolCalls: [] },
    ],
    toolResults: { screenshot: { content: [] } },
  });
  await runAgentTurn({ config: makeConfig(), userText: 'look', lang: 'en', deps: shotDeps });
  const shotTool = shotDeps.chatCalls[1].messages.find((m) => m.role === 'tool');
  assert.equal(shotTool.content, 'Screenshot captured.');
});

test('agent loop: refuses non-whitelisted tool without calling ghost and says so in the reply', async () => {
  const deps = fakeDeps({
    responses: [
      { content: null, toolCalls: [{ id: 'c1', name: 'shell', arguments: {} }] },
      { content: 'must not reach the model again', toolCalls: [] },
    ],
  });

  const result = await runAgentTurn({ config: makeConfig(), userText: '运行命令', lang: 'zh', deps });

  assert.deepEqual(deps.ghostCalls, [], 'shell must never reach ghost');
  assert.deepEqual(result.steps, [{ tool: 'shell', ok: false }]);
  assert.match(result.reply, /shell/);
  assert.match(result.reply, /拒绝/);
  assert.equal(deps.chatCalls.length, 1, 'loop stops right after the refusal');
});

test('agent loop: runs a valid tap via ghost then returns the final text', async () => {
  const deps = fakeDeps({
    responses: [
      { content: null, toolCalls: [{ id: 't1', name: 'tap', arguments: { x: 10, y: 20 } }] },
      { content: '已点击目标', toolCalls: [] },
    ],
    toolResults: { tap: { content: [{ type: 'text', text: 'Tapped (10, 20)' }] } },
  });

  const result = await runAgentTurn({ config: makeConfig(), userText: '点一下 (10,20)', lang: 'zh', deps });

  assert.deepEqual(deps.ghostCalls, [['tap', { x: 10, y: 20 }]]);
  assert.deepEqual(result.steps, [{ tool: 'tap', ok: true }]);
  assert.equal(result.reply, '已点击目标');

  // The model only ever sees filtered OpenAI tool definitions, shell excluded.
  const sentNames = deps.chatCalls[0].tools.map((t) => t.function.name);
  assert.ok(sentNames.includes('tap'));
  assert.ok(!sentNames.includes('shell'), 'shell must not be offered to the model');

  // Second request carries the assistant tool_calls turn and the tool result.
  const secondMessages = deps.chatCalls[1].messages;
  const assistant = secondMessages.find(
    (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
  );
  assert.ok(assistant, 'assistant message with tool_calls missing');
  assert.equal(assistant.tool_calls[0].id, 't1');
  assert.equal(assistant.tool_calls[0].function.name, 'tap');
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { x: 10, y: 20 });
  const toolMessage = secondMessages.find((m) => m.role === 'tool' && m.tool_call_id === 't1');
  assert.ok(toolMessage, 'tool result message missing');
  assert.match(toolMessage.content, /Tapped \(10, 20\)/);
});

test('agent loop: invalid tool arguments never reach ghost and the reply explains the error', async () => {
  const deps = fakeDeps({
    responses: [{ content: null, toolCalls: [{ id: 't1', name: 'tap', arguments: { x: 10 } }] }],
  });

  const result = await runAgentTurn({ config: makeConfig(), userText: '点一下', lang: 'zh', deps });

  assert.deepEqual(deps.ghostCalls, [], 'bad args must not reach ghost');
  assert.deepEqual(result.steps, [{ tool: 'tap', ok: false }]);
  assert.match(result.reply, /requires field: y/);
});

test('agent loop: stops at maxSteps and calls the model at most that many times', async () => {
  const deps = fakeDeps({
    responses: [{ content: null, toolCalls: [{ id: 'n', name: 'tap', arguments: { x: 1, y: 1 } }] }],
  });
  // The fake above returns the single canned response forever.

  const result = await runAgentTurn({
    config: makeConfig({ maxSteps: 2 }),
    userText: 'keep tapping',
    lang: 'en',
    deps,
  });

  assert.ok(deps.chatCalls.length <= 2, `chatCompletion called ${deps.chatCalls.length} times`);
  assert.equal(deps.chatCalls.length, 2);
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps, [
    { tool: 'tap', ok: true },
    { tool: 'tap', ok: true },
  ]);
  assert.match(result.reply, /steps/i);
});

test('agent loop: screenshot result is fed back as an OpenAI vision image_url message', async () => {
  const deps = fakeDeps({
    responses: [
      { content: null, toolCalls: [{ id: 's1', name: 'screenshot', arguments: {} }] },
      { content: 'I can see the home screen', toolCalls: [] },
    ],
    toolResults: {
      screenshot: { content: [{ type: 'image', data: 'aW1hZ2VieXRlcw==', mimeType: 'image/png' }] },
    },
  });

  const result = await runAgentTurn({ config: makeConfig(), userText: '看看屏幕', lang: 'en', deps });

  assert.deepEqual(result.steps, [{ tool: 'screenshot', ok: true }]);
  assert.equal(result.reply, 'I can see the home screen');

  const imagePart = deps.chatCalls[1].messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((part) => part && part.type === 'image_url');
  assert.ok(imagePart, 'no image_url part in follow-up messages');
  assert.match(imagePart.image_url.url, /^data:image/);
  assert.match(imagePart.image_url.url, /^data:image\/png;base64,aW1hZ2VieXRlcw==$/);
});

test('agent loop: screenshot disabled in config means the tool is not offered and calls are refused', async () => {
  const deps = fakeDeps({
    responses: [{ content: null, toolCalls: [{ id: 's1', name: 'screenshot', arguments: {} }] }],
  });

  const result = await runAgentTurn({ config: makeConfig({ screenshot: false }), userText: '截图', lang: 'zh', deps });

  const sentNames = deps.chatCalls[0].tools.map((t) => t.function.name);
  assert.ok(!sentNames.includes('screenshot'), 'disabled screenshot must not be offered');
  assert.deepEqual(deps.ghostCalls, [], 'disabled screenshot must not run');
  assert.deepEqual(result.steps, [{ tool: 'screenshot', ok: false }]);
  assert.match(result.reply, /screenshot/);
});

test('agent loop: a tool error is recorded as ok:false and the model keeps driving', async () => {
  const deps = fakeDeps({
    responses: [
      { content: null, toolCalls: [{ id: 't1', name: 'tap', arguments: { x: 1, y: 2 } }] },
      { content: '点击失败了，稍后再试', toolCalls: [] },
    ],
    toolResults: { tap: { content: [{ type: 'text', text: 'gesture failed' }], isError: true } },
  });

  const result = await runAgentTurn({ config: makeConfig(), userText: '点一下', lang: 'zh', deps });

  assert.deepEqual(result.steps, [{ tool: 'tap', ok: false }]);
  assert.equal(deps.chatCalls.length, 2);
  assert.equal(result.reply, '点击失败了，稍后再试');
  const toolMessage = deps.chatCalls[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 't1');
  assert.match(toolMessage.content, /gesture failed/);
});

test('agent loop: one vision user message with all image parts comes after every tool response', async () => {
  const deps = fakeDeps({
    responses: [
      {
        content: null,
        toolCalls: [
          { id: 's1', name: 'screenshot', arguments: {} },
          { id: 't1', name: 'tap', arguments: { x: 3, y: 4 } },
        ],
      },
      { content: 'seen and tapped', toolCalls: [] },
    ],
    toolResults: {
      screenshot: { content: [{ type: 'image', data: 'aaE=', mimeType: 'image/png' }] },
      tap: { content: [{ type: 'text', text: 'Tapped (3, 4)' }] },
    },
  });

  const result = await runAgentTurn({ config: makeConfig(), userText: 'look then tap', lang: 'en', deps });

  assert.deepEqual(result.steps, [
    { tool: 'screenshot', ok: true },
    { tool: 'tap', ok: true },
  ]);
  assert.equal(result.reply, 'seen and tapped');

  const second = deps.chatCalls[1].messages;
  const roles = second.map((m) => `${m.role}:${Array.isArray(m.tool_calls) ? m.tool_calls.length : '-'}`);
  const assistantIndex = roles.findIndex((r) => r === 'assistant:2');
  assert.ok(assistantIndex >= 0, 'assistant turn with two tool_calls missing');
  const toolIndexes = second
    .map((m, i) => (m.role === 'tool' ? i : -1))
    .filter((i) => i >= 0);
  assert.deepEqual(toolIndexes, [assistantIndex + 1, assistantIndex + 2], 'tool responses must follow the assistant turn back to back');
  const visionIndexes = second
    .map((m, i) => (Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image_url') ? i : -1))
    .filter((i) => i >= 0);
  assert.deepEqual(visionIndexes, [assistantIndex + 3], 'exactly one vision user message, after all tool responses');
  const vision = second[assistantIndex + 3];
  assert.equal(vision.role, 'user');
  const imageParts = vision.content.filter((p) => p.type === 'image_url');
  assert.equal(imageParts.length, 1);
  assert.equal(imageParts[0].image_url.url, 'data:image/png;base64,aaE=');

  // A second screenshot in the same turn must not create a second user message.
  const deps2 = fakeDeps({
    responses: [
      {
        content: null,
        toolCalls: [
          { id: 's1', name: 'screenshot', arguments: {} },
          { id: 't1', name: 'tap', arguments: { x: 1, y: 1 } },
          { id: 's2', name: 'screenshot', arguments: {} },
        ],
      },
      { content: 'two shots', toolCalls: [] },
    ],
    toolResults: {
      screenshot: { content: [{ type: 'image', data: 'aaE=', mimeType: 'image/jpeg' }] },
      tap: { content: [{ type: 'text', text: 'ok' }] },
    },
  });
  await runAgentTurn({ config: makeConfig(), userText: 'x', lang: 'en', deps: deps2 });
  const msgs2 = deps2.chatCalls[1].messages;
  const vision2 = msgs2.filter(
    (m) => Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image_url'),
  );
  assert.equal(vision2.length, 1, 'all image parts belong in a single user vision message');
  assert.equal(
    vision2[0].content.filter((p) => p.type === 'image_url').length,
    2,
  );
  assert.ok(
    msgs2.at(-1) === vision2[0],
    'the vision user message must be the last message of the turn',
  );
});

test('agent loop: no ghost lock-state tool call is needed before the model runs', async () => {
  const deps = fakeDeps({ responses: [{ content: 'ok', toolCalls: [] }] });
  const result = await runAgentTurn({ config: makeConfig(), userText: 'hi', lang: 'en', deps });
  assert.equal(result.reply, 'ok');
  assert.equal(deps.isLockedCalls, 1);
  assert.equal(deps.ghostCalls.length, 0, 'no bogus lock-state tool call before the model');
});

test('agent loop: system prompt is localized and requires same-language replies and no unlock', async () => {
  const zhDeps = fakeDeps({ responses: [{ content: '你好', toolCalls: [] }] });
  await runAgentTurn({ config: makeConfig(), userText: '你好', lang: 'zh', deps: zhDeps });
  const zhFirst = zhDeps.chatCalls[0].messages[0];
  assert.equal(zhFirst.role, 'system');
  assert.match(zhFirst.content, /语言/);
  assert.match(zhFirst.content, /解锁/);
  const zhUser = zhDeps.chatCalls[0].messages.at(-1);
  assert.deepEqual(zhUser, { role: 'user', content: '你好' });

  const enDeps = fakeDeps({ responses: [{ content: 'hi', toolCalls: [] }] });
  await runAgentTurn({ config: makeConfig(), userText: 'hi', lang: 'en', deps: enDeps });
  const enFirst = enDeps.chatCalls[0].messages[0];
  assert.equal(enFirst.role, 'system');
  assert.match(enFirst.content, /same language/i);
  assert.match(enFirst.content, /unlock/i);
});
