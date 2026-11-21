// MCP client for ghost-in-the-droid's stdio server (android-agent-mcp).
// The SDK Client/transport are injectable via `deps` so tests never spawn a
// real process; production wiring uses the official SDK defaults.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const DEFAULT_GHOST_COMMAND = 'uvx';
export const DEFAULT_GHOST_ARGS = Object.freeze(['--from', 'ghost-in-the-droid', 'android-agent-mcp']);

export function createGhostClient(
  {
    serial,
    command = DEFAULT_GHOST_COMMAND,
    args = DEFAULT_GHOST_ARGS,
    env = {},
  } = {},
  deps = {},
) {
  const ClientImpl = deps.Client ?? Client;
  const TransportImpl = deps.StdioClientTransport ?? StdioClientTransport;

  let client = null;

  async function start() {
    if (client) return;
    const transport = new TransportImpl({
      command,
      args,
      // ghost selects the device via DEFAULT_DEVICE; the SDK merges these
      // over its safe inherited-environment defaults.
      env: { ...env, DEFAULT_DEVICE: serial },
    });
    const next = new ClientImpl({ name: 'phone-screen-link', version: '1.0.0' });
    await next.connect(transport);
    client = next;
  }

  async function stop() {
    const current = client;
    client = null;
    if (current) await current.close();
  }

  function requireClient() {
    if (!client) throw new Error('ghost client is not started');
    return client;
  }

  async function listTools() {
    const result = await requireClient().listTools();
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async function callTool(name, toolArgs = {}) {
    return requireClient().callTool({ name, arguments: toolArgs });
  }

  return { start, stop, listTools, callTool };
}
