import test from 'node:test';
import assert from 'node:assert/strict';
import { createGhostClient } from '../server/ghost-client.mjs';

const SERIAL = '2FD0221C09004177';

function makeDeps() {
  const deps = { transports: [], clients: [] };

  deps.StdioClientTransport = class FakeStdioClientTransport {
    constructor(serverParams) {
      this.serverParams = serverParams;
      deps.transports.push(this);
    }
  };

  deps.Client = class FakeClient {
    constructor(clientInfo, options) {
      this.clientInfo = clientInfo;
      this.options = options;
      this.connects = [];
      this.listToolsCalls = 0;
      this.callToolCalls = [];
      this.closeCalls = 0;
      this.tools = [{ name: 'get_phone_state', description: 'd', inputSchema: { type: 'object' } }];
      this.callToolResult = { content: [{ type: 'text', text: 'ok' }] };
      deps.clients.push(this);
    }

    async connect(transport) {
      this.connects.push(transport);
    }

    async listTools() {
      this.listToolsCalls += 1;
      return { tools: this.tools };
    }

    async callTool(params) {
      this.callToolCalls.push(params);
      return this.callToolResult;
    }

    async close() {
      this.closeCalls += 1;
    }
  };

  return deps;
}

test('ghost client: start() spawns the ghost MCP server over stdio with the device serial', async () => {
  const deps = makeDeps();
  const client = createGhostClient({ serial: SERIAL }, deps);
  await client.start();

  assert.equal(deps.transports.length, 1);
  const { command, args, env } = deps.transports[0].serverParams;
  assert.equal(command, 'uvx');
  assert.deepEqual(args, ['--from', 'ghost-in-the-droid', 'android-agent-mcp']);
  assert.equal(env.DEFAULT_DEVICE, SERIAL);

  assert.equal(deps.clients.length, 1);
  assert.equal(deps.clients[0].connects[0], deps.transports[0]);
});

test('ghost client: start() honours explicit command/args/env and merges caller env', async () => {
  const deps = makeDeps();
  const client = createGhostClient(
    {
      serial: SERIAL,
      command: 'python',
      args: ['-m', 'ghost_mcp'],
      env: { ANDROID_HOME: '/opt/android' },
    },
    deps,
  );
  await client.start();

  const { command, args, env } = deps.transports[0].serverParams;
  assert.equal(command, 'python');
  assert.deepEqual(args, ['-m', 'ghost_mcp']);
  assert.equal(env.DEFAULT_DEVICE, SERIAL);
  assert.equal(env.ANDROID_HOME, '/opt/android');
});

test('ghost client: start() is idempotent while connected', async () => {
  const deps = makeDeps();
  const client = createGhostClient({ serial: SERIAL }, deps);
  await client.start();
  await client.start();
  assert.equal(deps.transports.length, 1);
  assert.equal(deps.clients.length, 1);
});

test('ghost client: listTools() returns the tools from the MCP tools/list response', async () => {
  const deps = makeDeps();
  const client = createGhostClient({ serial: SERIAL }, deps);
  await client.start();

  const tools = await client.listTools();
  assert.deepEqual(tools, deps.clients[0].tools);
  assert.equal(deps.clients[0].listToolsCalls, 1);
});

test('ghost client: callTool() passes { name, arguments } to the MCP client and returns the raw result', async () => {
  const deps = makeDeps();
  const client = createGhostClient({ serial: SERIAL }, deps);
  await client.start();
  deps.clients[0].callToolResult = { content: [{ type: 'text', text: 'screen on' }] };

  const result = await client.callTool('get_phone_state', {});
  assert.deepEqual(deps.clients[0].callToolCalls, [{ name: 'get_phone_state', arguments: {} }]);
  assert.deepEqual(result, { content: [{ type: 'text', text: 'screen on' }] });

  await client.callTool('tap', { x: 10, y: 20 });
  assert.deepEqual(deps.clients[0].callToolCalls[1], { name: 'tap', arguments: { x: 10, y: 20 } });
});

test('ghost client: stop() closes the client and is safe to call repeatedly', async () => {
  const deps = makeDeps();
  const client = createGhostClient({ serial: SERIAL }, deps);
  await client.start();

  await client.stop();
  assert.equal(deps.clients[0].closeCalls, 1);

  await client.stop();
  await client.stop();
  assert.equal(deps.clients[0].closeCalls, 1);
});

test('ghost client: stop() before start() does not throw', async () => {
  const deps = makeDeps();
  const client = createGhostClient({ serial: SERIAL }, deps);
  await client.stop();
  assert.equal(deps.clients.length, 0);
});

test('ghost client: listTools()/callTool() throw when not started', async () => {
  const deps = makeDeps();
  const client = createGhostClient({ serial: SERIAL }, deps);
  await assert.rejects(client.listTools(), /not started/);
  await assert.rejects(client.callTool('tap', {}), /not started/);

  await client.start();
  await client.stop();
  await assert.rejects(client.listTools(), /not started/);
});

test('ghost client: start() can be repeated after stop()', async () => {
  const deps = makeDeps();
  const client = createGhostClient({ serial: SERIAL }, deps);
  await client.start();
  await client.stop();
  await client.start();
  assert.equal(deps.transports.length, 2);
  assert.equal(deps.clients[1].connects[0], deps.transports[1]);
});
