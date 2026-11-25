import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_CHAT_CONFIG = Object.freeze({
  enabled: false,
  baseUrl: 'http://192.168.3.123:8080/v1',
  model: 'local',
  maxSteps: 100,
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
    const previousMaxSteps = config.maxSteps;
    for (const key of WRITABLE_FIELDS) {
      const value = fieldValue(fields, key);
      if (value !== undefined) config[key] = value;
    }
    // maxSteps policy: integers are CLAMPED to 1..100 (the settings input's
    // range, web/index.html max=100); non-integers are dropped like any other
    // type mismatch, keeping the previously stored value.
    if (Object.hasOwn(fields, 'maxSteps')) {
      const value = fields.maxSteps;
      config.maxSteps = typeof value === 'number' && Number.isInteger(value)
        ? Math.min(100, Math.max(1, value))
        : previousMaxSteps;
    }
    mkdirSync(dirname(file), { recursive: true });
    // The file holds the API key: owner-only permissions, and an atomic
    // temp-file + rename so readers never see a half-written config.
    const tmp = `${file}.tmp`;
    rmSync(tmp, { force: true }); // a crashed earlier save may have left one
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
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
