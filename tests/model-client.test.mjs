import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion } from '../server/model-client.mjs';

function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  impl.calls = calls;
  return impl;
}

const CONTENT_RESPONSE = {
  choices: [{ message: { role: 'assistant', content: '已发送' } }],
};

const TOOL_CALL_RESPONSE = {
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'tap', arguments: '{"x":1,"y":2}' },
          },
        ],
      },
    },
  ],
};

test('model client: sends POST to /chat/completions with body and auth header', async () => {
  const fetchImpl = fakeFetch(CONTENT_RESPONSE);
  await chatCompletion({
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3',
    apiKey: 'sk-test',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'tap' } }],
    fetchImpl,
  });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['content-type'], 'application/json');
  assert.equal(options.headers.authorization, 'Bearer sk-test');

  const sent = JSON.parse(options.body);
  assert.equal(sent.model, 'qwen3');
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(sent.tools, [{ type: 'function', function: { name: 'tap' } }]);
  assert.equal(sent.tool_choice, 'auto');
});

test('model client: trims trailing slash from baseUrl', async () => {
  const fetchImpl = fakeFetch(CONTENT_RESPONSE);
  await chatCompletion({
    baseUrl: 'http://localhost:1234/v1/',
    model: 'm',
    messages: [],
    fetchImpl,
  });
  assert.equal(fetchImpl.calls[0].url, 'http://localhost:1234/v1/chat/completions');
});

test('model client: omits authorization header when apiKey is empty', async () => {
  const fetchImpl = fakeFetch(CONTENT_RESPONSE);
  await chatCompletion({ model: 'm', messages: [], apiKey: '', fetchImpl });
  assert.equal(Object.hasOwn(fetchImpl.calls[0].options.headers, 'authorization'), false);
});

test('model client: content-only message becomes { content, toolCalls: [] }', async () => {
  const result = await chatCompletion({
    model: 'm',
    messages: [],
    fetchImpl: fakeFetch(CONTENT_RESPONSE),
  });
  assert.deepEqual(result, { content: '已发送', toolCalls: [] });
});

test('model client: parses tool_calls arguments into objects', async () => {
  const result = await chatCompletion({
    model: 'm',
    messages: [],
    fetchImpl: fakeFetch(TOOL_CALL_RESPONSE),
  });
  assert.deepEqual(result, {
    content: null,
    toolCalls: [{ id: 'call_1', name: 'tap', arguments: { x: 1, y: 2 } }],
  });
});

test('model client: invalid arguments JSON is treated as empty object and logged', async (t) => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  const badResponse = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_2', function: { name: 'tap', arguments: 'not-json' } },
          ],
        },
      },
    ],
  };
  const result = await chatCompletion({
    model: 'm',
    messages: [],
    fetchImpl: fakeFetch(badResponse),
  });
  assert.deepEqual(result, {
    content: null,
    toolCalls: [{ id: 'call_2', name: 'tap', arguments: {} }],
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /arguments/);
});

test('model client: non-2xx response throws with status and body snippet', async () => {
  await assert.rejects(
    chatCompletion({
      model: 'm',
      messages: [],
      fetchImpl: fakeFetch('{"error":"model exploded"}', { status: 500 }),
    }),
    (error) => {
      assert.match(error.message, /500/);
      assert.match(error.message, /model exploded/);
      return true;
    },
  );
});

test('model client: forwards abort signal to fetch', async () => {
  const controller = new AbortController();
  const fetchImpl = fakeFetch(CONTENT_RESPONSE);
  await chatCompletion({
    model: 'm',
    messages: [],
    fetchImpl,
    signal: controller.signal,
  });
  assert.equal(fetchImpl.calls[0].options.signal, controller.signal);
});

test('model client: defaults baseUrl to the configured OpenAI-compatible endpoint', async () => {
  const fetchImpl = fakeFetch(CONTENT_RESPONSE);
  await chatCompletion({ model: 'm', messages: [], fetchImpl });
  assert.equal(fetchImpl.calls[0].url, 'http://192.168.3.123:8080/v1/chat/completions');
});
