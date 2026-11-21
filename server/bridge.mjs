import http from 'node:http';
import { KEY_CODES } from '../shared/keys.mjs';

const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const TOO_LARGE = Symbol('too-large');
const INVALID_JSON = Symbol('invalid-json');

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

export function createBridge({ adb, host, port }) {
  const bindHost = host ?? DEFAULT_HOST;
  let server;
  let boundAddress;

  async function handleRequest(req, res) {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true, online: await adb.isOnline() });
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
