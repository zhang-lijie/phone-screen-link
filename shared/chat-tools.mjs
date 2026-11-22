// Device tools the chat agent may expose to the model. Kept deliberately small:
// read-only inspection plus a fixed set of safe UI actions.
export const ALLOWED_TOOLS = Object.freeze([
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
]);

// Ghost tools we explicitly refuse, mirrored here for tests/documentation parity.
export const DENIED_TOOLS = Object.freeze([
  'shell',
  'install',
  'uninstall',
  'push',
  'pull',
  'clipboard_get',
  'unlock_device',
]);

const ALLOWED_SET = new Set(ALLOWED_TOOLS);

export function isAllowedTool(name, config) {
  if (!ALLOWED_SET.has(name)) return false;
  if (name === 'screenshot') return config?.screenshot === true;
  return true;
}

// Map MCP tools/list entries to the OpenAI tool definition shape.
export function filterToolDefinitions(tools, config) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && isAllowedTool(tool.name, config))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
}

function typeMatches(value, expected) {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

// Shallow validation only: required-field presence and basic declared types.
// Full JSON Schema validation is intentionally out of scope.
export function validateToolArgs(name, args, definitions) {
  if (!ALLOWED_SET.has(name)) {
    return { ok: false, error: `Tool not allowed: ${name}` };
  }

  const def = Array.isArray(definitions)
    ? definitions.find((item) => item && item.name === name)
    : undefined;
  if (!def) return { ok: false, error: `Unknown tool: ${name}` };

  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: `Invalid arguments for ${name}: expected an object` };
  }

  const schema = def.inputSchema ?? {};
  // `device` is injected by the MCP client from the configured serial. It is
  // a transport concern, so the model is not required to supply it.
  const required = (Array.isArray(schema.required) ? schema.required : []).filter((f) => f !== 'device');
  for (const field of required) {
    if (!Object.hasOwn(args, field)) {
      return { ok: false, error: `${name} requires field: ${field}` };
    }
  }

  const properties = schema.properties ?? {};
  for (const [field, prop] of Object.entries(properties)) {
    if (field === 'device') continue;
    if (!Object.hasOwn(args, field) || !prop || typeof prop.type !== 'string') continue;
    if (!typeMatches(args[field], prop.type)) {
      return { ok: false, error: `${name}.${field} must be a ${prop.type}` };
    }
  }

  return { ok: true };
}
