import test from 'node:test';
import assert from 'node:assert/strict';
import { createGhostClient } from '../server/ghost-client.mjs';
import { createAdb } from '../server/adb.mjs';

const SERIAL = '2FD0221C09004177';

function makeDeps() {
  const deps = { transports: [], clients: [] };

  deps.StdioClientTransport = class FakeStdioClientTransport {
    constructor(serverParams) {
      this.serverParams = serverParams;
      this.closeCalls = 0;
      deps.transports.push(this);
    }

    async close() {
      this.closeCalls += 1;
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
  assert.deepEqual(deps.clients[0].callToolCalls, [{ name: 'get_phone_state', arguments: { device: SERIAL } }]);
  assert.deepEqual(result, { content: [{ type: 'text', text: 'screen on' }] });

  await client.callTool('tap', { x: 10, y: 20 });
  assert.deepEqual(deps.clients[0].callToolCalls[1], { name: 'tap', arguments: { x: 10, y: 20, device: SERIAL } });
});

test('ghost client: callTool follows the active adb serial after a connection switch', async () => {
  const deps = makeDeps();
  const adb = createAdb(async () => '', { mode: 'usb', serial: SERIAL });
  const client = createGhostClient({ getSerial: () => adb.getSerial(), env: {} }, deps);
  await client.start();

  deps.clients[0].tools = [
    { name: 'tap', inputSchema: { type: 'object', required: ['device'] } },
  ];
  await client.listTools();
  await client.callTool('tap', { x: 1, y: 2 });

  adb.setConnection({ mode: 'wifi', serial: '10.0.0.5:5555' });
  await client.callTool('tap', { x: 3, y: 4 });

  assert.deepEqual(deps.clients[0].callToolCalls, [
    { name: 'tap', arguments: { x: 1, y: 2, device: SERIAL } },
    { name: 'tap', arguments: { x: 3, y: 4, device: '10.0.0.5:5555' } },
  ]);
  assert.equal(deps.transports[0].serverParams.env.DEFAULT_DEVICE, SERIAL);
});

test('ghost client: an explicit per-turn serial overrides a later active serial change', async () => {
  const deps = makeDeps();
  let activeSerial = SERIAL;
  const client = createGhostClient({ getSerial: () => activeSerial }, deps);
  await client.start();
  deps.clients[0].tools = [
    { name: 'tap', inputSchema: { type: 'object', required: ['device'] } },
  ];
  await client.listTools();

  activeSerial = '10.0.0.5:5555';
  await client.callTool('tap', { x: 1, y: 2 }, SERIAL);

  assert.deepEqual(deps.clients[0].callToolCalls, [
    { name: 'tap', arguments: { x: 1, y: 2, device: SERIAL } },
  ]);
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

test('ghost client: a failed connect closes the transport and leaves the client unstarted', async () => {
  const deps = makeDeps();
  const BaseClient = deps.Client;
  let failNextConnect = true;
  deps.Client = class FlakyClient extends BaseClient {
    async connect(transport) {
      await super.connect(transport);
      if (failNextConnect) {
        failNextConnect = false;
        throw new Error('spawn uvx ENOENT');
      }
    }
  };
  const client = createGhostClient({ serial: SERIAL }, deps);

  await assert.rejects(client.start(), /spawn uvx ENOENT/);
  assert.equal(deps.transports.length, 1);
  assert.equal(deps.transports[0].closeCalls, 1, 'transport must be closed so no ghost process leaks');
  await assert.rejects(client.listTools(), /not started/);

  // A retry after the failure builds a fresh transport and connects cleanly.
  await client.start();
  assert.equal(deps.transports.length, 2);
  assert.equal(deps.transports[1].closeCalls, 0);
  assert.equal(deps.clients[1].connects[0], deps.transports[1]);
});

test('ghost client: transport close errors do not mask the connect failure', async () => {
  const deps = makeDeps();
  const BaseTransport = deps.StdioClientTransport;
  deps.StdioClientTransport = class BrokenCloseTransport extends BaseTransport {
    async close() { throw new Error('close failed'); }
  };
  const BaseClient = deps.Client;
  deps.Client = class FailingClient extends BaseClient {
    async connect() { throw new Error('connect failed'); }
  };
  const client = createGhostClient({ serial: SERIAL }, deps);

  await assert.rejects(client.start(), /connect failed/);
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

test('ghost client: callTool overrides a wrong device with the configured serial', async () => {
  const deps = makeDeps();
  const client = createGhostClient({ serial: SERIAL }, deps);
  await client.start();
  deps.clients[0].tools = [
    { name: 'tap', inputSchema: { type: 'object', properties: { device: { type: 'string' }, x: { type: 'integer' } }, required: ['device', 'x'] } },
    { name: 'wait', inputSchema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] } },
  ];
  await client.listTools();

  await client.callTool('tap', { device: 'wrong-serial', x: 5 });
  assert.deepEqual(deps.clients[0].callToolCalls[0], {
    name: 'tap', arguments: { device: SERIAL, x: 5 },
  });

  // Tools that do not require a device must not receive an extra argument.
  await client.callTool('wait', { seconds: 1 });
  assert.deepEqual(deps.clients[0].callToolCalls[1], {
    name: 'wait', arguments: { seconds: 1 },
  });
});

test('ghost client: setSerial retargets tools whose schema has an optional device', async () => {
  const deps = makeDeps();
  const client = createGhostClient({ serial: SERIAL }, deps);
  await client.start();
  deps.clients[0].tools = [
    { name: 'list_apps', inputSchema: { type: 'object', properties: { device: { type: 'string' } } } },
    { name: 'wait', inputSchema: { type: 'object', properties: { seconds: { type: 'number' } } } },
  ];
  await client.listTools();
  client.setSerial('SERIAL-B');

  await client.callTool('list_apps', {});
  assert.deepEqual(deps.clients[0].callToolCalls[0], {
    name: 'list_apps', arguments: { device: 'SERIAL-B' },
  });
  await client.callTool('wait', { seconds: 1 });
  assert.deepEqual(deps.clients[0].callToolCalls[1], {
    name: 'wait', arguments: { seconds: 1 },
  });
});

test('ghost client: setSerial before listTools still overrides device', async () => {
  const deps = makeDeps();
  const client = createGhostClient({ serial: SERIAL }, deps);
  await client.start();
  client.setSerial('SERIAL-B');
  await client.callTool('tap', { device: 'wrong' });
  assert.deepEqual(deps.clients[0].callToolCalls[0], {
    name: 'tap', arguments: { device: 'SERIAL-B' },
  });
});
