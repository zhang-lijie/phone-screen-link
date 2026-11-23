// Thin client for an OpenAI-compatible /v1/chat/completions endpoint.
// fetch is injected so callers (and tests) control the transport.

export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';

function parseArguments(raw, name) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.warn(`[model-client] Invalid arguments for tool ${name}: expected an object`);
    return {};
  } catch {
    console.warn(`[model-client] Invalid arguments JSON for tool ${name}: ${String(raw).slice(0, 200)}`);
    return {};
  }
}

export async function chatCompletion({
  baseUrl = DEFAULT_BASE_URL,
  model,
  apiKey = '',
  messages = [],
  tools = [],
  fetchImpl = fetch,
  signal,
} = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
    ...(signal ? { signal } : {}),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Model API error ${response.status}: ${raw.slice(0, 500)}`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Model API returned invalid JSON: ${raw.slice(0, 500)}`);
  }

  const message = payload?.choices?.[0]?.message ?? {};
  const content = typeof message.content === 'string' ? message.content : null;

  const toolCalls = [];
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const fn = call?.function ?? {};
    toolCalls.push({
      id: call?.id ?? '',
      name: fn.name ?? '',
      arguments: parseArguments(fn.arguments, fn.name),
    });
  }

  return { content, toolCalls };
}
