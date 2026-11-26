import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findAppPids, stopPids } from '../scripts/stop.mjs';

const projectDir = '/home/me/phoneLink';
const psOutput = `  100 /usr/bin/node /other/scripts/start.mjs
  201 /usr/bin/node scripts/start.mjs
  202 /usr/bin/node dist/index.js
  203 /usr/bin/npm start
  204 /bin/sh -c npm start
`;

test('findAppPids returns only matching processes from this project', () => {
  const cwdForPid = (pid) => (pid === 201 || pid === 202 ? projectDir : '/somewhere/else');
  assert.deepEqual(findAppPids({ psOutput, cwdForPid, projectDir }), [201, 202]);
});

test('findAppPids ignores other checkouts with identical command lines', () => {
  const cwdForPid = () => '/other/phoneLink';
  assert.deepEqual(findAppPids({ psOutput, cwdForPid, projectDir }), []);
});

test('stopPids escalates to SIGKILL only for processes that survive SIGTERM', async () => {
  const calls = [];
  const result = await stopPids({
    pids: [201, 202],
    kill: (pid, signal) => calls.push([pid, signal]),
    waitForExit: async () => [202],
    log: () => {},
  });

  assert.deepEqual(calls, [
    [201, 'SIGTERM'],
    [202, 'SIGTERM'],
    [202, 'SIGKILL'],
  ]);
  assert.equal(result.killed, 1);
  assert.equal(result.forceKilled, 1);
});

test('package.json exposes npm run stop', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.stop, 'node scripts/stop.mjs');
});
