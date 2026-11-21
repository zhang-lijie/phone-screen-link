import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_CHAT_CONFIG = Object.freeze({
  enabled: false,
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: '',
  maxSteps: 8,
  screenshot: true,
  apiKey: '',
});

const WRITABLE_FIELDS = ['enabled', 'baseUrl', 'model', 'maxSteps', 'screenshot', 'apiKey'];

function fieldValue(source, key) {
  if (!Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  return typeof value === typeof DEFAULT_CHAT_CONFIG[key] ? value : undefined;
}

export function createChatConfigStore({ file }) {
  function load() {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { ...DEFAULT_CHAT_CONFIG };
      throw error;
    }

    let stored;
    try {
      stored = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_CHAT_CONFIG };
    }
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
      return { ...DEFAULT_CHAT_CONFIG };
    }

    const config = { ...DEFAULT_CHAT_CONFIG };
    for (const key of WRITABLE_FIELDS) {
      const value = fieldValue(stored, key);
      if (value !== undefined) config[key] = value;
    }
    return config;
  }

  function save(patch = {}) {
    const config = load();
    const fields = patch !== null && typeof patch === 'object' ? patch : {};
    for (const key of WRITABLE_FIELDS) {
      const value = fieldValue(fields, key);
      if (value !== undefined) config[key] = value;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    return publicConfig();
  }

  function publicConfig() {
    const config = load();
    return {
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      model: config.model,
      maxSteps: config.maxSteps,
      screenshot: config.screenshot,
      hasApiKey: Boolean(config.apiKey),
    };
  }

  return { load, save, publicConfig };
}
