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
    getSerial,
    command = DEFAULT_GHOST_COMMAND,
    args = DEFAULT_GHOST_ARGS,
    env = {},
  } = {},
  deps = {},
) {
  const ClientImpl = deps.Client ?? Client;
  const TransportImpl = deps.StdioClientTransport ?? StdioClientTransport;

  function currentSerial() {
    return getSerial ? getSerial() : serial;
  }

  let client = null;
  // Names of tools whose schema requires a `device` argument. Populated by
  // listTools(); null until then (we inject conservatively in that case).
  let deviceRequiredTools = null;

  async function start() {
    if (client) return;
    const transport = new TransportImpl({
      command,
      args,
      // ghost selects the device via DEFAULT_DEVICE; the SDK merges these
      // over its safe inherited-environment defaults.
      env: { ...env, DEFAULT_DEVICE: currentSerial() },
    });
    const next = new ClientImpl({ name: 'phone-screen-link', version: '1.0.0' });
    try {
      await next.connect(transport);
    } catch (err) {
      // A rejected connect may still have spawned the child process: close
      // the transport so no ghost process leaks, then surface the original
      // error (a close failure must not mask it).
      try {
        await transport.close();
      } catch {
        // The transport may never have started; nothing else to release.
      }
      throw err;
    }
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
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    deviceRequiredTools = new Set(
      tools
        .filter((tool) => Array.isArray(tool?.inputSchema?.required) && tool.inputSchema.required.includes('device'))
        .map((tool) => tool.name),
    );
    return tools;
  }

  async function callTool(name, toolArgs = {}, targetSerial = currentSerial()) {
    const args = { ...toolArgs };
    const deviceSerial = targetSerial;
    // ghost tools are device-scoped. Inject/override the serial so neither
    // internal calls nor model-generated calls can target the wrong device.
    if (deviceSerial && (deviceRequiredTools === null || deviceRequiredTools.has(name))) {
      args.device = deviceSerial;
    }
    return requireClient().callTool({ name, arguments: args });
  }

  return { start, stop, listTools, callTool, getSerial: currentSerial };
}
