import http from 'node:http';
import { KEY_CODES, WIRELESS_AUTO_WARNING_CODES } from '../shared/keys.mjs';
import { DEFAULT_USB_SERIAL } from './adb.mjs';

const DEFAULT_HOST = '127.0.0.1';
const WIRELESS_WARNING_CODES = new Set(Object.values(WIRELESS_AUTO_WARNING_CODES));
const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:8000', 'http://localhost:8000']);
const MAX_BODY_BYTES = 64 * 1024;
const TOO_LARGE = Symbol('too-large');
const INVALID_JSON = Symbol('invalid-json');
const PREFLIGHT_METHODS = {
  '/health': 'GET, OPTIONS',
  '/keyevent': 'POST, OPTIONS',
  '/chat': 'POST, OPTIONS',
  '/api/chat-screen': 'POST, OPTIONS',
  '/api/chat-command': 'POST, OPTIONS',
  '/api/chat-config': 'GET, POST, OPTIONS',
  '/api/wireless': 'GET, OPTIONS',
  '/api/wireless/pair': 'POST, OPTIONS',
  '/api/wireless/legacy': 'POST, OPTIONS',
  '/api/wireless/usb': 'POST, OPTIONS',
  '/api/wireless/auto': 'POST, OPTIONS',
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

function errorDetail(err, fallback) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

function redactedErrorDetail(err, pairingCode, fallback) {
  const detail = errorDetail(err, fallback);
  return pairingCode ? detail.split(pairingCode).join('[redacted]') || fallback : detail;
}

function validateHost(value, field) {
  const host = typeof value === 'string' ? value.trim() : '';
  let valid;
  if (/^[\d.]+$/.test(host)) {
    const parts = host.split('.');
    valid = parts.length === 4 && parts.every((part) => (
      /^\d{1,3}$/.test(part) && Number(part) <= 255
    ));
  } else {
    valid = host.length <= 253 && host.split('.').every((label) => (
      label.length >= 1
      && label.length <= 63
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    ));
  }
  if (!valid) throw new Error(`${field} must be a valid IPv4 address or hostname`);
}

function validatePort(value, field) {
  const text = typeof value === 'string' ? value.trim() : value;
  const port = typeof text === 'number' ? text : (
    typeof text === 'string' && /^\d+$/.test(text) ? Number(text) : NaN
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${field} must be an integer between 1 and 65535`);
  }
}

function validatePairingInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('pairing input is required');
  }
  validateHost(input.pairHost, 'pairHost');
  validatePort(input.pairPort, 'pairPort');
  if (typeof input.pairCode !== 'string' || !/^\d{6}$/.test(input.pairCode)) {
    throw new Error('pairCode must be exactly 6 digits');
  }
  validateHost(input.connectHost, 'connectHost');
  validatePort(input.connectPort, 'connectPort');
}

function validateLegacyInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('legacy input is required');
  }
  validateHost(input.host, 'host');
  validatePort(input.port, 'port');
  if (input.enableTcpip !== undefined && typeof input.enableTcpip !== 'boolean') {
    throw new Error('enableTcpip must be a boolean');
  }
}

function wirelessStatusPayload(status) {
  return {
    ok: true,
    mode: status?.mode,
    method: status?.method,
    serial: status?.serial,
    online: status?.online,
    usbOnline: status?.usbOnline === true,
  };
}

function wirelessDiscoveryPayload(result) {
  return {
    usbSerial: result?.usbSerial,
    pairHost: result?.pairHost ?? null,
    pairPort: result?.pairPort ?? null,
    connectHost: result?.connectHost ?? null,
    connectPort: result?.connectPort ?? null,
    warnings: Array.isArray(result?.warnings)
      ? [...new Set(result.warnings.filter((warning) => WIRELESS_WARNING_CODES.has(warning)))]
      : [],
  };
}

// `chat` is `{ run(userText, lang, config) }`, wired in scripts/start.mjs
// around the agent loop; `config` is the store snapshot the /chat gate already
// loaded. `chatConfig` is the backend store: it gates /chat and backs the
// /api/chat-config routes. `connectionService` owns pairing, persistence, and
// the active ADB transport.
export function createBridge({ adb, host, port, chatConfig, chat, connectionService }) {
  const bindHost = host ?? DEFAULT_HOST;
  let server;
  let boundAddress;
  let savedScreenTimeout = null; // original timeout while chat keeps screen awake

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
        const serial = typeof adb.getSerial === 'function' ? adb.getSerial() : DEFAULT_USB_SERIAL;
        const mode = typeof adb.getMode === 'function' ? adb.getMode() : 'usb';
        sendJson(res, 200, { ok: true, online: await adb.isOnline(), serial, mode });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/wireless') {
        if (!connectionService) {
          sendJson(res, 503, { error: 'wireless connection unavailable' });
          return;
        }
        try {
          sendJson(res, 200, wirelessStatusPayload(await connectionService.status()));
        } catch (err) {
          sendJson(res, 502, { error: errorDetail(err, 'wireless status failed') });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/wireless/auto') {
        if (!connectionService || typeof connectionService.discoverWirelessConfig !== 'function') {
          sendJson(res, 503, { error: 'wireless connection unavailable' });
          return;
        }
        try {
          const discovery = await connectionService.discoverWirelessConfig();
          sendJson(res, 200, wirelessDiscoveryPayload(discovery));
        } catch (err) {
          if (err?.code === 'USB_OFFLINE') {
            sendJson(res, 409, { error: errorDetail(err, 'USB device is offline') });
            return;
          }
          sendJson(res, 502, { error: errorDetail(err, 'wireless auto discovery failed') });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/wireless/pair') {
        if (!connectionService) {
          sendJson(res, 503, { error: 'wireless connection unavailable' });
          return;
        }
        const body = await readJsonBody(req, res);
        if (body === TOO_LARGE) return;
        if (body === INVALID_JSON) {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        try {
          validatePairingInput(body);
        } catch (err) {
          sendJson(res, 400, { error: errorDetail(err, 'invalid pairing input') });
          return;
        }
        try {
          const status = await connectionService.pairAndConnect(body);
          sendJson(res, 200, wirelessStatusPayload(status));
        } catch (err) {
          sendJson(res, 502, {
            error: redactedErrorDetail(err, body.pairCode, 'wireless pairing failed'),
          });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/wireless/legacy') {
        if (!connectionService || typeof connectionService.connectLegacy !== 'function') {
          sendJson(res, 503, { error: 'wireless connection unavailable' });
          return;
        }
        const body = await readJsonBody(req, res);
        if (body === TOO_LARGE) return;
        if (body === INVALID_JSON) {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        try {
          validateLegacyInput(body);
        } catch (err) {
          sendJson(res, 400, { error: errorDetail(err, 'invalid legacy input') });
          return;
        }
        try {
          const status = await connectionService.connectLegacy(body);
          sendJson(res, 200, wirelessStatusPayload(status));
        } catch (err) {
          if (err?.code === 'USB_OFFLINE') {
            sendJson(res, 409, { error: errorDetail(err, 'USB device is offline') });
            return;
          }
          sendJson(res, 502, { error: errorDetail(err, 'legacy wireless connect failed') });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/wireless/usb') {
        if (!connectionService) {
          sendJson(res, 503, { error: 'wireless connection unavailable' });
          return;
        }
        try {
          sendJson(res, 200, wirelessStatusPayload(await connectionService.switchToUsb()));
        } catch (err) {
          sendJson(res, 502, { error: errorDetail(err, 'usb switch failed') });
        }
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

      if (req.method === 'POST' && pathname === '/api/chat-screen') {
        const body = await readJsonBody(req, res);
        if (body === TOO_LARGE) return;
        if (body === INVALID_JSON) {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        const action = body?.action;
        if (action !== 'wake' && action !== 'restore') {
          sendJson(res, 400, { error: 'invalid action' });
          return;
        }
        if (!(await adb.isOnline())) {
          sendJson(res, 503, { error: 'device offline' });
          return;
        }
        try {
          if (action === 'wake') {
            if (savedScreenTimeout === null) {
              const current = await adb.getScreenTimeout();
              if (current !== null) savedScreenTimeout = current;
            }
            await adb.wakeScreen();
            await adb.setScreenTimeout(60 * 60 * 1000); // keep awake for 1h while chatting
          } else {
            if (savedScreenTimeout !== null) {
              await adb.setScreenTimeout(savedScreenTimeout);
              savedScreenTimeout = null;
            }
          }
          sendJson(res, 200, { ok: true });
        } catch (err) {
          const detail = err instanceof Error && err.message ? err.message : 'screen control failed';
          sendJson(res, 502, { error: detail });
        }
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
