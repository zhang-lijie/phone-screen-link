// Agent loop for the chat feature: phone-state gate, model calls, tool-call
// whitelist/schema enforcement, and result feedback. Everything external
// (ghost MCP, model endpoint) is injectable via `deps` so tests stay fake.

import { chatCompletion as defaultChatCompletion } from './model-client.mjs';
import { filterToolDefinitions, isAllowedTool, validateToolArgs } from '../shared/chat-tools.mjs';
import { resolveCommand } from '../shared/chat-commands.mjs';

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

const STRINGS = {
  zh: {
    system: (toolsHint) =>
      `你是手机操控助手，通过工具控制一台安卓手机。规则：` +
      `1) 始终使用与用户相同的语言回复，默认使用中文。` +
      `2) 只能调用本次提供的工具列表中的工具${toolsHint ? `（${toolsHint}）` : ''}，绝不尝试列表之外的操作。` +
      `3) 不要尝试解锁手机；手机锁定时系统会提示用户先解锁。` +
      `4) 完成操作或无法完成时，用简短文字向用户说明结果。`,
    locked: '手机当前处于锁定或休眠状态，我无法操作。请先在手机上解锁，然后重新发送请求。',
    refused: (name) => `抱歉，工具「${name}」不在允许列表中，我已拒绝执行该操作。`,
    invalidArgs: (name, error) => `工具「${name}」的参数无效：${error}，我已停止执行。`,
    maxSteps: (n) => `已达到单次请求的最大步数（${n}），操作已停止。请继续发送消息或缩小请求范围。`,
    noContent: '操作已结束，但模型没有返回文字回复。',
  },
  en: {
    system: (toolsHint) =>
      `You are a phone assistant that controls an Android device through tools. Rules: ` +
      `1) Always reply in the same language as the user; this prompt is written in English, so default to English. ` +
      `2) Only call tools from the provided tool list${toolsHint ? ` (${toolsHint})` : ''}; never attempt anything outside it. ` +
      `3) Never attempt to unlock the phone; while it is locked the system prompts the user to unlock first. ` +
      `4) When the task is done or cannot be done, explain the result briefly in text.`,
    locked: 'The phone is locked or asleep, so I cannot operate it. Please unlock the phone first, then send your request again.',
    refused: (name) => `Sorry, the tool "${name}" is not in the allowed list, so I refused to run it.`,
    invalidArgs: (name, error) => `Invalid arguments for tool "${name}": ${error}. Execution stopped.`,
    maxSteps: (n) => `Reached the maximum number of steps (${n}) for this request; stopping here. Send another message or narrow it down.`,
    noContent: 'The actions finished but the model returned no text reply.',
  },
};

function strings(lang) {
  return STRINGS[lang] ?? STRINGS.en;
}

function textOf(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

// screenshot comes back as MCP image content; OpenAI vision needs a data URI.
function imageDataUriOf(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const image = parts.find((p) => p && p.type === 'image' && typeof p.data === 'string');
  if (image) return `data:${image.mimeType ?? 'image/png'};base64,${image.data}`;
  const inline = parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text.trim())
    .find((t) => /^data:image\/[a-z0-9.+-]+;base64,/i.test(t));
  return inline ?? null;
}

function imagePartOf(result) {
  const url = imageDataUriOf(result);
  return url ? { type: 'image_url', image_url: { url } } : null;
}

// Run a preset slash command by calling its tool directly — no model call.
// Reuses the same lock gate and callTool injection as the agent loop.
export async function runPresetCommand({ commandId, lang, deps = {} }) {
  const command = resolveCommand(commandId);
  if (!command) {
    return { ok: false, reply: strings(lang).noContent, steps: [] };
  }
  let locked = true;
  try {
    if (typeof deps.isLocked === 'function') {
      const value = await deps.isLocked();
      locked = typeof value === 'boolean' ? value : true;
    }
  } catch {
    locked = true;
  }
  if (locked) {
    return { ok: false, reply: strings(lang).locked, steps: [] };
  }
  const callTool = deps.callTool ?? ((name, toolArgs) => deps.ghost.callTool(name, toolArgs));
  try {
    const result = await callTool(command.tool, { ...command.args });
    const ok = result?.isError !== true;
    const text = textOf(result);
    // Full text is returned; the chat panel folds long messages (double-click
    // to expand) instead of silently truncating command output.
    const reply = text || strings(lang).noContent;
    return { ok, reply, steps: [{ tool: command.tool, ok }] };
  } catch (err) {
    return { ok: false, reply: String(err?.message ?? err), steps: [{ tool: command.tool, ok: false }] };
  }
}

export async function runAgentTurn({ config, ghost, userText, lang, deps = {} }) {
  const listTools = deps.listTools ?? (() => ghost.listTools());
  const callTool = deps.callTool ?? ((name, toolArgs) => ghost.callTool(name, toolArgs));
  const complete =
    deps.chatCompletion ??
    ((params) =>
      defaultChatCompletion({
        baseUrl: params.baseUrl,
        model: params.model,
        apiKey: params.apiKey,
        messages: params.messages,
        tools: params.tools,
        signal: params.signal,
      }));

  // Spec §5.5: every model call is bounded. The AbortSignal cancels the real
  // fetch; the race additionally bounds completions that ignore the signal
  // and turns the abort into a readable error the bridge surfaces as 502.
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
    ? deps.timeoutMs
    : DEFAULT_MODEL_TIMEOUT_MS;

  async function completeStep(params) {
    let timer;
    try {
      return await Promise.race([
        complete({ ...params, signal: AbortSignal.timeout(timeoutMs) }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Model request timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error(`Model request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  const t = strings(lang);
  const maxSteps = Number.isFinite(config?.maxSteps) && config.maxSteps >= 1
    ? Math.floor(config.maxSteps)
    : DEFAULT_MAX_STEPS;

  // Backend-side lock gate: never call the model or any action tool when
  // locked/asleep. The check is injected by the caller (ADB-backed in
  // production) because ghost's get_phone_state reports the current app,
  // not lock state. A missing or failing checker fails closed.
  let locked = true;
  try {
    if (typeof deps.isLocked === 'function') {
      const value = await deps.isLocked();
      locked = typeof value === 'boolean' ? value : true;
    }
  } catch {
    locked = true;
  }
  if (locked) {
    return { reply: t.locked, steps: [] };
  }

  const rawTools = await listTools();
  const definitions = filterToolDefinitions(rawTools, config);

  const messages = [
    { role: 'system', content: t.system(definitions.map((d) => d.function.name).join(', ')) },
    { role: 'user', content: userText },
  ];
  const steps = [];

  for (let step = 0; step < maxSteps; step += 1) {
    const response = await completeStep({
      baseUrl: config?.baseUrl,
      model: config?.model,
      apiKey: config?.apiKey,
      messages: [...messages],
      tools: definitions,
    });

    const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
    if (toolCalls.length === 0) {
      const content = typeof response?.content === 'string' && response.content.trim() !== ''
        ? response.content
        : t.noContent;
      return { reply: content, steps };
    }

    // Some endpoints omit tool_call ids; strict OpenAI-compatible servers
    // reject empty or mismatched ids, so synthesize stable per-step ones and
    // reuse them verbatim in the role:'tool' responses below.
    const calls = toolCalls.map((call, i) => ({ ...call, id: call.id || `call_${step}_${i}` }));

    messages.push({
      role: 'assistant',
      content: typeof response.content === 'string' ? response.content : null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      })),
    });

    // All role:'tool' responses must precede any new user message on strict
    // OpenAI endpoints, so image parts are collected and appended once after
    // the whole batch of tool results.
    const imageParts = [];

    for (const call of calls) {
      const name = call.name;
      const args = call.arguments ?? {};

      if (!isAllowedTool(name, config)) {
        steps.push({ tool: name, ok: false });
        return { reply: t.refused(name), steps };
      }
      const validation = validateToolArgs(name, args, rawTools);
      if (!validation.ok) {
        steps.push({ tool: name, ok: false });
        return { reply: t.invalidArgs(name, validation.error), steps };
      }

      const result = await callTool(name, args);
      const ok = result?.isError !== true;
      steps.push({ tool: name, ok });

      const text = textOf(result);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        // Empty content is invalid on strict endpoints; give the model an
        // explicit placeholder instead of an empty string.
        content: text !== '' ? text : (name === 'screenshot' ? 'Screenshot captured.' : '(no output)'),
      });

      if (name === 'screenshot') {
        const part = imagePartOf(result);
        if (part) imageParts.push(part);
      }
    }

    if (imageParts.length > 0) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: 'screenshot result:' }, ...imageParts],
      });
    }
  }

  return { reply: t.maxSteps(maxSteps), steps };
}
