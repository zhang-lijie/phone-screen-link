import http from 'node:http';
import { KEY_CODES } from '../shared/keys.mjs';
import { DEFAULT_USB_SERIAL } from './adb.mjs';

const DEFAULT_HOST = '127.0.0.1';
const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:8000', 'http://localhost:8000']);
const MAX_BODY_BYTES = 64 * 1024;
const TOO_LARGE = Symbol('too-large');
const INVALID_JSON = Symbol('invalid-json');
const PREFLIGHT_METHODS = {
  '/health': 'GET, OPTIONS',
  '/keyevent': 'POST, OPTIONS',
  '/chat': 'POST, OPTIONS',
  '/api/chat-command': 'POST, OPTIONS',
  '/api/chat-config': 'GET, POST, OPTIONS',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settle(TOO_LARGE);
        req.resume();
        sendJson(res, 413, { error: 'payload too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        settle(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        settle(INVALID_JSON);
      }
    });
    req.on('error', () => settle(INVALID_JSON));
  });
}

// `chat` is `{ run(userText, lang, config) }`, wired in scripts/start.mjs
// around the agent loop; `config` is the store snapshot the /chat gate already
// loaded. `chatConfig` is the backend store: it gates /chat and backs the
// /api/chat-config routes.
export function createBridge({ adb, host, port, chatConfig, chat }) {
  const bindHost = host ?? DEFAULT_HOST;
  let server;
  let boundAddress;

  async function handleRequest(req, res) {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');

      const origin = req.headers.origin;
      if (ALLOWED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }

      // CORS only gates response reading: a hostile page can still send a
      // preflight-free "simple request" (e.g. content-type:text/plain) that
      // mutates state. Every POST must therefore carry either no Origin
      // (curl and other non-browser clients) or an allowlisted one.
      if (req.method === 'POST' && origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
        sendJson(res, 403, { error: 'origin not allowed' });
        return;
      }

      if (req.method === 'OPTIONS' && Object.hasOwn(PREFLIGHT_METHODS, pathname)) {
        res.writeHead(204, {
          'access-control-allow-methods': PREFLIGHT_METHODS[pathname],
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true, online: await adb.isOnline(), serial: DEFAULT_USB_SERIAL });
        return;
      }

      if (req.method === 'POST' && pathname === '/keyevent') {
        const body = await readJsonBody(req, res);
        if (body === TOO_LARGE) return;
        if (body === INVALID_JSON) {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        const key = body?.key;
        if (typeof key !== 'string' || !Object.hasOwn(KEY_CODES, key)) {
          sendJson(res, 400, { error: 'unknown key' });
          return;
        }
        if (!(await adb.isOnline())) {
          sendJson(res, 503, { error: 'device offline' });
          return;
        }
        await adb.keyEvent(key);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/chat') {
        const body = await readJsonBody(req, res);
        if (body === TOO_LARGE) return;
        if (body === INVALID_JSON) {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        // The request body is never trusted for configuration: only `message`
        // and `lang` are read from it. Enablement and model come from the
        // backend store and are checked before the agent can reach the model.
        if (body === null || typeof body !== 'object') {
          sendJson(res, 400, { error: 'message required' });
          return;
        }
        const message = body.message;
        if (typeof message !== 'string') {
          sendJson(res, 400, { error: 'message required' });
          return;
        }
        const lang = typeof body.lang === 'string' ? body.lang : undefined;
        if (!chat || !chatConfig) {
          sendJson(res, 503, { error: 'chat unavailable' });
          return;
        }
        const config = chatConfig.load();
        if (config.enabled !== true || typeof config.model !== 'string' || config.model === '') {
          sendJson(res, 503, { error: 'chat disabled' });
          return;
        }
        // Model/tool failures carry readable messages (model-client, agent
        // timeout): surface them as 502 so the frontend can show them in a
        // bubble. The config loaded for the gate is handed to the agent so
        // the store is read exactly once per request (no TOCTOU re-load).
        let result;
        try {
          result = await chat.run(message, lang, config);
        } catch (err) {
          const detail = err instanceof Error && err.message ? err.message : 'chat request failed';
          sendJson(res, 502, { error: detail });
          return;
        }
        sendJson(res, 200, { reply: result.reply, steps: result.steps });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/chat-command') {
        const body = await readJsonBody(req, res);
        if (body === TOO_LARGE) return;
        if (body === INVALID_JSON) {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        if (body === null || typeof body !== 'object' || typeof body.command !== 'string') {
          sendJson(res, 400, { error: 'command required' });
          return;
        }
        const lang = typeof body.lang === 'string' ? body.lang : undefined;
        if (!chat?.runCommand) {
          sendJson(res, 503, { error: 'chat unavailable' });
          return;
        }
        try {
          const result = await chat.runCommand(body.command, lang);
          sendJson(res, 200, { reply: result.reply, ok: result.ok, steps: result.steps });
        } catch (err) {
          const detail = err instanceof Error && err.message ? err.message : 'command failed';
          sendJson(res, 502, { error: detail });
        }
        return;
      }

      if (pathname === '/api/chat-config' && (req.method === 'GET' || req.method === 'POST')) {
        if (!chatConfig) {
          sendJson(res, 503, { error: 'chat config unavailable' });
          return;
        }
        if (req.method === 'GET') {
          sendJson(res, 200, chatConfig.publicConfig());
          return;
        }
        const body = await readJsonBody(req, res);
        if (body === TOO_LARGE) return;
        if (body === INVALID_JSON) {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        sendJson(res, 200, chatConfig.save(body));
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      if (server) {
        reject(new Error('bridge already started'));
        return;
      }
      const instance = http.createServer(handleRequest);
      instance.once('error', reject);
      instance.listen(port ?? 0, bindHost, () => {
        instance.removeListener('error', reject);
        server = instance;
        const { port: boundPort } = instance.address();
        boundAddress = `http://${bindHost}:${boundPort}`;
        resolve({ address: boundAddress });
      });
    });
  }

  function stop() {
    return new Promise((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      const instance = server;
      server = undefined;
      boundAddress = undefined;
      instance.close((err) => (err ? reject(err) : resolve()));
    });
  }

  function address() {
    return boundAddress;
  }

  return { start, stop, address };
}
