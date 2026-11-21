// Agent loop for the chat feature: phone-state gate, model calls, tool-call
// whitelist/schema enforcement, and result feedback. Everything external
// (ghost MCP, model endpoint) is injectable via `deps` so tests stay fake.

import { chatCompletion as defaultChatCompletion } from './model-client.mjs';
import { filterToolDefinitions, isAllowedTool, validateToolArgs } from '../shared/chat-tools.mjs';

const DEFAULT_MAX_STEPS = 8;

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

function truthyLocked(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

// Lock state truth comes from ghost's get_phone_state only. ghost tools often
// return prose, some return JSON; structuredContent is the MCP standard slot.
function isPhoneLocked(result) {
  const structured = result?.structuredContent;
  if (structured && typeof structured === 'object' && Object.hasOwn(structured, 'locked')) {
    return truthyLocked(structured.locked);
  }
  const text = textOf(result);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'locked')) {
      return truthyLocked(parsed.locked);
    }
  } catch {
    // fall through to prose matching
  }
  if (/unlocked|not locked|locked["']?\s*[:=]\s*false/i.test(text)) return false;
  if (/locked|screen off|asleep/i.test(text)) return true;
  return false; // unknown state: let the model proceed, it sees the raw text
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
      }));

  const t = strings(lang);
  const maxSteps = Number.isFinite(config?.maxSteps) && config.maxSteps >= 1
    ? Math.floor(config.maxSteps)
    : DEFAULT_MAX_STEPS;

  // Backend-side lock gate: never call the model or any action tool when locked.
  const state = await callTool('get_phone_state', {});
  if (isPhoneLocked(state)) {
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
    const response = await complete({
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

    messages.push({
      role: 'assistant',
      content: typeof response.content === 'string' ? response.content : null,
      tool_calls: toolCalls.map((call) => ({
        id: call.id ?? '',
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      })),
    });

    for (const call of toolCalls) {
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
        tool_call_id: call.id ?? '',
        content: name === 'screenshot' && text === '' ? 'Screenshot captured.' : text,
      });

      if (name === 'screenshot') {
        const dataUri = imageDataUriOf(result);
        if (dataUri) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: 'screenshot result:' },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          });
        }
      }
    }
  }

  return { reply: t.maxSteps(maxSteps), steps };
}
