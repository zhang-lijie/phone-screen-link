import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdb, DEFAULT_USB_SERIAL } from '../server/adb.mjs';
import { createConnectionConfigStore } from '../server/connection-config.mjs';
import { createConnectionService } from '../server/connection-service.mjs';

const USB_SERIAL = 'USB-DEFAULT';
const WIRELESS_ADDRESS = 'phone.local:5555';
const PHONE_IP = '192.168.1.42';
const PAIR_PORT = 37123;
const CONNECT_PORT = 42123;
const PAIR_SERVICE = '_adb-tls-pairing._tcp';
const CONNECT_SERVICE = '_adb-tls-connect._tcp';
const WIFI_IP_WARNING = 'WIFI_IP_UNAVAILABLE';
const CONNECT_PORT_WARNING = 'CONNECT_PORT_UNAVAILABLE';
const PAIRING_PORT_WARNING = 'PAIRING_PORT_UNAVAILABLE';
const PAIR_INPUT = Object.freeze({
  pairHost: '192.168.1.20',
  pairPort: '37123',
  pairCode: '123456',
  connectHost: 'phone.local',
  connectPort: '5555',
});

function setup(t, { runner, initial, stored, sleep, deadlineWait, now, warn } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'connection-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'connection.json');
  const store = createConnectionConfigStore({ file });
  store.save(stored ?? { mode: 'usb', address: '' });
  const adb = createAdb(runner ?? (async () => ''), initial ?? { mode: 'usb', serial: 'USB-ORIGINAL' });
  let testSleep = sleep;
  let testNow = now;
  if (testSleep && testNow === undefined) {
    let elapsed = 0;
    testNow = () => elapsed;
    const injectSleep = testSleep;
    testSleep = async (ms) => {
      elapsed += ms;
      await injectSleep(ms);
    };
  }
  const service = createConnectionService({
    adb, store, usbSerial: USB_SERIAL, sleep: testSleep, deadlineWait, now: testNow,
    warn: warn ?? (() => {}),
  });
  return { adb, store, service, file };
}

function mdnsOutput(services) {
  return [
    'List of discovered mdns services',
    ...services.map(({ service, host = PHONE_IP, port }) => `${service}\t${host}:${port}`),
  ].join('\n');
}

function discoveryRunner({
  calls,
  ipOutput = `    inet ${PHONE_IP}/24 scope global wlan0\n`,
  connectOutput = `${CONNECT_PORT}\n`,
  services = [],
} = {}) {
  return async (args) => {
    calls?.push(args);
    if (args[0] === '-s' && args[2] === 'get-state') return 'device\n';
    if (args[0] === '-s' && args[2] === 'shell' && args.includes('addr')) return ipOutput;
    if (args[0] === '-s' && args[2] === 'shell' && args.includes('route')) return '';
    if (args[0] === '-s' && args[2] === 'shell' && args.includes('getprop')) return connectOutput;
    if (args[0] === 'mdns') {
      const current = typeof services === 'function' ? services() : services;
      return mdnsOutput(current);
    }
    throw new Error(`unexpected adb command: ${args.join(' ')}`);
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

test('connection service: status reports active wireless and targeted USB state without enumerating USB devices', async (t) => {
  const calls = [];
  const { service } = setup(t, {
    initial: { mode: 'wifi', serial: WIRELESS_ADDRESS },
    stored: { mode: 'wifi', address: WIRELESS_ADDRESS },
    runner: async (args) => { calls.push(args); return 'device\n'; },
  });

  assert.deepEqual(await service.status(), {
    mode: 'wifi', serial: WIRELESS_ADDRESS, online: true, usbOnline: true, method: 'pair',
  });
  assert.deepEqual(calls, [
    ['-s', WIRELESS_ADDRESS, 'get-state'],
    ['-s', USB_SERIAL, 'get-state'],
  ]);
});

test('connection service: pairAndConnect pairs, connects, confirms online, then switches and persists', async (t) => {
  const calls = [];
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => { calls.push(args); return 'device\n'; },
  });

  const result = await service.pairAndConnect(PAIR_INPUT);

  assert.deepEqual(calls.slice(0, 3), [
    ['pair', '192.168.1.20:37123', '123456'],
    ['connect', 'phone.local:5555'],
    ['-s', 'phone.local:5555', 'get-state'],
  ]);
  assert.equal(calls.some((args) => args[0] === 'devices'), false);
  assert.equal(adb.getMode(), 'wifi');
  assert.equal(adb.getSerial(), WIRELESS_ADDRESS);
  assert.deepEqual(store.load(), { mode: 'wifi', method: 'pair', address: WIRELESS_ADDRESS });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mode: 'wifi', method: 'pair', address: WIRELESS_ADDRESS });
  assert.deepEqual(result, {
    mode: 'wifi', serial: WIRELESS_ADDRESS, online: true, usbOnline: true, method: 'pair',
  });
  assert.equal(JSON.stringify(result).includes(PAIR_INPUT.pairCode), false);
});

test('connection service: a persistence failure before USB-to-wireless activation leaves runtime and disk unchanged', async (t) => {
  const { adb, store, service, file } = setup(t, {
    runner: async () => 'device\n',
  });
  store.save = () => { throw new Error('connection config is read-only'); };
  const before = readFileSync(file);

  await assert.rejects(service.pairAndConnect(PAIR_INPUT), /read-only/);

  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: a persistence failure before wireless-to-USB activation leaves runtime and disk unchanged', async (t) => {
  const { adb, store, service, file } = setup(t, {
    initial: { mode: 'wifi', serial: WIRELESS_ADDRESS },
    stored: { mode: 'wifi', address: WIRELESS_ADDRESS },
  });
  store.save = () => { throw new Error('connection config is read-only'); };
  const before = readFileSync(file);

  await assert.rejects(service.switchToUsb(), /read-only/);

  assert.equal(adb.getMode(), 'wifi');
  assert.equal(adb.getSerial(), WIRELESS_ADDRESS);
  assert.deepEqual(store.load(), { mode: 'wifi', method: 'pair', address: WIRELESS_ADDRESS });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: a post-commit wireless status failure does not turn pairing into a failure', async (t) => {
  const { adb, store, service } = setup(t, {
    runner: async () => 'device\n',
  });
  adb.isOnline = async () => { throw new Error('status read failed after commit'); };

  assert.deepEqual(await service.pairAndConnect(PAIR_INPUT), {
    mode: 'wifi', serial: WIRELESS_ADDRESS, online: true, usbOnline: false, method: 'pair',
  });
  assert.equal(adb.getMode(), 'wifi');
  assert.deepEqual(store.load(), { mode: 'wifi', method: 'pair', address: WIRELESS_ADDRESS });
});

test('connection service: a post-commit USB status failure does not turn a completed switch into a failure', async (t) => {
  const { adb, store, service } = setup(t, {
    initial: { mode: 'wifi', serial: WIRELESS_ADDRESS },
    stored: { mode: 'wifi', address: WIRELESS_ADDRESS },
    runner: async (args) => {
      if (args[0] === '-s' && args[1] === USB_SERIAL && args[2] === 'get-state') {
        throw new Error('USB status read failed after commit');
      }
      return '';
    },
  });

  assert.deepEqual(await service.switchToUsb(), {
    mode: 'usb', serial: USB_SERIAL, online: false, usbOnline: false, method: 'pair',
  });
  assert.equal(adb.getMode(), 'usb');
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
});

test('connection service: a pair failure leaves the active device and persisted config unchanged', async (t) => {
  const calls = [];
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => {
      calls.push(args);
      throw new Error('pair rejected');
    },
  });
  const before = readFileSync(file);

  await assert.rejects(service.pairAndConnect(PAIR_INPUT), /pair rejected/);

  assert.deepEqual(calls, [['pair', '192.168.1.20:37123', '123456']]);
  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: a connect failure after pairing leaves the active device and persisted config unchanged', async (t) => {
  const calls = [];
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => {
      calls.push(args);
      if (args[0] === 'connect') throw new Error('connect rejected');
      return '';
    },
  });
  const before = readFileSync(file);

  await assert.rejects(service.pairAndConnect(PAIR_INPUT), /connect rejected/);

  assert.deepEqual(calls, [
    ['pair', '192.168.1.20:37123', '123456'],
    ['connect', 'phone.local:5555'],
  ]);
  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: an offline device after connect is not activated or persisted', async (t) => {
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => {
      if (args[0] === '-s') throw new Error('device offline');
      return '';
    },
  });
  const before = readFileSync(file);

  await assert.rejects(service.pairAndConnect(PAIR_INPUT), /offline after connect/i);

  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: invalid pairing input is rejected before any ADB command or persistence', async (t) => {
  const calls = [];
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => { calls.push(args); return ''; },
  });
  const before = readFileSync(file);
  const invalidInputs = [
    [{ pairHost: '' }, /pairHost/],
    [{ pairHost: 'bad host' }, /pairHost/],
    [{ pairHost: '192.168.1.999' }, /pairHost/],
    [{ pairPort: 0 }, /pairPort/],
    [{ pairPort: 65536 }, /pairPort/],
    [{ pairPort: 'abc' }, /pairPort/],
    [{ pairCode: '12345' }, /pairCode/],
    [{ pairCode: '1234567' }, /pairCode/],
    [{ pairCode: 'abcdef' }, /pairCode/],
    [{ connectHost: '' }, /connectHost/],
    [{ connectPort: -1 }, /connectPort/],
    [{ connectPort: '65536' }, /connectPort/],
  ];

  for (const [patch, expected] of invalidInputs) {
    await assert.rejects(service.pairAndConnect({ ...PAIR_INPUT, ...patch }), expected);
  }

  assert.deepEqual(calls, []);
  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: surfaced ADB errors never contain the pairing code', async (t) => {
  const { service } = setup(t, {
    runner: async () => {
      throw new Error(`pair command failed for code ${PAIR_INPUT.pairCode}`);
    },
  });

  await assert.rejects(service.pairAndConnect(PAIR_INPUT), (err) => {
    assert.match(err.message, /pair command failed/);
    assert.equal(err.message.includes(PAIR_INPUT.pairCode), false);
    return true;
  });
});

test('connection service: switchToUsb restores the supplied USB serial and clears the stored address', async (t) => {
  const calls = [];
  const { adb, store, service } = setup(t, {
    initial: { mode: 'wifi', serial: WIRELESS_ADDRESS },
    stored: { mode: 'wifi', address: WIRELESS_ADDRESS },
    runner: async (args) => {
      calls.push(args);
      return args[0] === '-s' && args[2] === 'get-state' ? 'device\n' : '';
    },
  });

  const result = await service.switchToUsb();

  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), USB_SERIAL);
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
  assert.deepEqual(result, { mode: 'usb', serial: USB_SERIAL, online: true, usbOnline: true, method: 'pair' });
  assert.deepEqual(calls, [['-s', USB_SERIAL, 'get-state']]);
});

test('connection service: concurrent pair and USB mutations serialize and return their own transaction status', async (t) => {
  const pairGate = deferred();
  let pairStartedResolve;
  const pairStarted = new Promise((resolve) => { pairStartedResolve = resolve; });
  const previousAddress = '10.0.0.9:5555';
  const { adb, store, service } = setup(t, {
    initial: { mode: 'wifi', serial: previousAddress },
    stored: { mode: 'wifi', address: previousAddress },
    runner: async (args) => {
      if (args[0] === 'pair') {
        pairStartedResolve();
        await pairGate.promise;
        return '';
      }
      if (args[0] === '-s') return 'device\n';
      if (args[0] === 'devices') return `List of devices attached\n${USB_SERIAL} device\n`;
      return '';
    },
  });

  const pairPromise = service.pairAndConnect(PAIR_INPUT);
  await pairStarted;
  const usbPromise = service.switchToUsb();
  try {
    assert.equal(adb.getMode(), 'wifi', 'USB mutation must wait for the in-flight pair transaction');
    assert.deepEqual(store.load(), { mode: 'wifi', method: 'pair', address: previousAddress });
  } finally {
    pairGate.resolve();
    await Promise.allSettled([pairPromise, usbPromise]);
  }

  assert.deepEqual(await pairPromise, {
    mode: 'wifi', serial: WIRELESS_ADDRESS, online: true, usbOnline: true, method: 'pair',
  });
  assert.deepEqual(await usbPromise, { mode: 'usb', serial: USB_SERIAL, online: true, usbOnline: true, method: 'pair' });
  assert.equal(adb.getMode(), 'usb');
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
});

test('connection service: wireless-to-wireless connect failure leaves the previous wireless runtime and disk state unchanged', async (t) => {
  const previousAddress = '10.0.0.9:5555';
  const { adb, store, service, file } = setup(t, {
    initial: { mode: 'wifi', serial: previousAddress },
    stored: { mode: 'wifi', address: previousAddress },
    runner: async (args) => {
      if (args[0] === 'connect') throw new Error('new wireless endpoint rejected');
      return '';
    },
  });
  const before = readFileSync(file);

  await assert.rejects(service.pairAndConnect(PAIR_INPUT), /new wireless endpoint rejected/);

  assert.equal(adb.getMode(), 'wifi');
  assert.equal(adb.getSerial(), previousAddress);
  assert.deepEqual(store.load(), { mode: 'wifi', method: 'pair', address: previousAddress });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: discovery rejects explicit offline or device-not-found output before shell or mDNS work', async (t) => {
  const cases = [
    { label: 'offline stdout', output: 'offline\n' },
    {
      label: 'not-found stderr',
      failure: Object.assign(new Error('Command failed: adb -s USB-DEFAULT get-state'), {
        stderr: `error: device '${USB_SERIAL}' not found\n`,
      }),
    },
    {
      label: 'adb-prefixed not-found stdout',
      failure: Object.assign(new Error('Command failed: adb -s USB-DEFAULT get-state'), {
        stdout: `adb: error: device '${USB_SERIAL}' not found\n`,
      }),
    },
    {
      label: 'adb-prefixed not-found stderr',
      failure: Object.assign(new Error('Command failed: adb -s USB-DEFAULT get-state'), {
        stderr: `adb: error: device '${USB_SERIAL}' not found\n`,
      }),
    },
    {
      label: 'offline stderr',
      failure: Object.assign(new Error('Command failed: adb -s USB-DEFAULT get-state'), {
        stderr: `error: device '${USB_SERIAL}' offline\n`,
      }),
    },
    {
      label: 'adb-prefixed offline stdout',
      failure: Object.assign(new Error('Command failed: adb -s USB-DEFAULT get-state'), {
        stdout: `adb: error: device '${USB_SERIAL}' offline\n`,
      }),
    },
    {
      label: 'adb-prefixed offline stderr',
      failure: Object.assign(new Error('Command failed: adb -s USB-DEFAULT get-state'), {
        stderr: `adb: error: device '${USB_SERIAL}' offline\n`,
      }),
    },
  ];

  for (const { label, output, failure } of cases) {
    const calls = [];
    const { service } = setup(t, {
      runner: async (args) => {
        calls.push(args);
        if (args[0] === '-s' && args[2] === 'get-state') {
          if (failure) throw failure;
          return output;
        }
        throw new Error('discovery must stop when USB is offline');
      },
    });

    await assert.rejects(service.discoverWirelessConfig(), (err) => {
      assert.equal(err.code, 'USB_OFFLINE', label);
      assert.match(err.message, /USB device is offline/);
      return true;
    });
    assert.deepEqual(calls, [['-s', USB_SERIAL, 'get-state']]);
  }
});

test('connection service: discovery preserves a missing-adb failure instead of reporting USB offline', async (t) => {
  const calls = [];
  const failure = Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' });
  const { service } = setup(t, {
    runner: async (args) => {
      calls.push(args);
      throw failure;
    },
  });

  await assert.rejects(service.discoverWirelessConfig(), (err) => err === failure);
  assert.deepEqual(calls, [['-s', USB_SERIAL, 'get-state']]);
});

test('connection service: discovery propagates host-side get-state rejections instead of reporting USB offline', async (t) => {
  const failures = [
    new Error('get-state failed unexpectedly'),
    Object.assign(new Error('Command failed: adb -s USB-DEFAULT get-state'), {
      stderr: "error: cannot connect to daemon at 'tcp:5037': Connection refused\n",
    }),
    Object.assign(new Error('Command failed: adb -s USB-DEFAULT get-state'), {
      stderr: 'error: failed to open transport: Permission denied\n',
    }),
  ];

  for (const failure of failures) {
    const calls = [];
    const { service } = setup(t, {
      runner: async (args) => {
        calls.push(args);
        throw failure;
      },
    });

    await assert.rejects(service.discoverWirelessConfig(), (err) => err === failure);
    assert.deepEqual(calls, [['-s', USB_SERIAL, 'get-state']]);
  }
});

test('connection service: status reports usbOnline from the configured USB serial while wireless is active', async (t) => {
  const calls = [];
  const { service } = setup(t, {
    initial: { mode: 'wifi', serial: WIRELESS_ADDRESS },
    stored: { mode: 'wifi', address: WIRELESS_ADDRESS },
    runner: async (args) => {
      calls.push(args);
      if (args[0] === '-s' && args[1] === USB_SERIAL) return 'offline\n';
      return 'device\n';
    },
  });

  assert.deepEqual(await service.status(), {
    mode: 'wifi', serial: WIRELESS_ADDRESS, online: true, usbOnline: false, method: 'pair',
  });
  assert.deepEqual(calls, [
    ['-s', WIRELESS_ADDRESS, 'get-state'],
    ['-s', USB_SERIAL, 'get-state'],
  ]);
});

test('connection service: discovery returns an IP-only partial result when wireless debugging is disabled', async (t) => {
  const calls = [];
  const sleeps = [];
  const { service } = setup(t, {
    runner: discoveryRunner({ calls, connectOutput: '\n', services: [] }),
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.deepEqual(await service.discoverWirelessConfig(), {
    usbSerial: USB_SERIAL,
    pairHost: PHONE_IP,
    pairPort: null,
    connectHost: PHONE_IP,
    connectPort: null,
    warnings: [
      CONNECT_PORT_WARNING,
      PAIRING_PORT_WARNING,
    ],
  });
  assert.deepEqual(calls, [
    ['-s', USB_SERIAL, 'get-state'],
    ['-s', USB_SERIAL, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
    ['-s', USB_SERIAL, 'shell', 'getprop', 'service.adb.tls.port'],
    ...Array.from({ length: 16 }, () => ['mdns', 'services']),
  ]);
  assert.deepEqual(sleeps, Array(16).fill(500));
});

test('connection service: discovery uses the TLS connect property and same-IP pairing endpoint without mutating state', async (t) => {
  const calls = [];
  const sleeps = [];
  const { adb, store, service, file } = setup(t, {
    initial: { mode: 'wifi', serial: WIRELESS_ADDRESS },
    stored: { mode: 'wifi', address: WIRELESS_ADDRESS },
    runner: discoveryRunner({
      calls,
      services: [
        { service: PAIR_SERVICE, host: '192.168.1.99', port: 40000 },
        { service: CONNECT_SERVICE, host: '192.168.1.99', port: 40001 },
        { service: PAIR_SERVICE, port: PAIR_PORT },
      ],
    }),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const before = readFileSync(file);
  adb.setConnection = () => { throw new Error('discovery must not change the active connection'); };
  store.save = () => { throw new Error('discovery must not persist connection config'); };

  const result = await service.discoverWirelessConfig();

  assert.deepEqual(result, {
    usbSerial: USB_SERIAL,
    pairHost: PHONE_IP,
    pairPort: PAIR_PORT,
    connectHost: PHONE_IP,
    connectPort: CONNECT_PORT,
    warnings: [],
  });
  assert.equal(Object.hasOwn(result, 'pairCode'), false);
  assert.equal(JSON.stringify(result).includes(PAIR_INPUT.pairCode), false);
  assert.deepEqual(calls, [
    ['-s', USB_SERIAL, 'get-state'],
    ['-s', USB_SERIAL, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
    ['-s', USB_SERIAL, 'shell', 'getprop', 'service.adb.tls.port'],
    ['mdns', 'services'],
  ]);
  assert.deepEqual(sleeps, []);
  assert.equal(adb.getMode(), 'wifi');
  assert.equal(adb.getSerial(), WIRELESS_ADDRESS);
  assert.deepEqual(store.load(), { mode: 'wifi', method: 'pair', address: WIRELESS_ADDRESS });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: discovery falls back to same-IP mDNS connect data while polling for pairing', async (t) => {
  const calls = [];
  const sleeps = [];
  let poll = 0;
  const { service } = setup(t, {
    runner: discoveryRunner({
      calls,
      connectOutput: '\n',
      services: () => {
        poll += 1;
        return poll === 1
          ? [
            { service: CONNECT_SERVICE, host: '192.168.1.99', port: 40001 },
            { service: CONNECT_SERVICE, port: CONNECT_PORT },
          ]
          : [
            { service: PAIR_SERVICE, host: '192.168.1.99', port: 40000 },
            { service: PAIR_SERVICE, port: PAIR_PORT },
            { service: CONNECT_SERVICE, port: CONNECT_PORT },
          ];
      },
    }),
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.deepEqual(await service.discoverWirelessConfig(), {
    usbSerial: USB_SERIAL,
    pairHost: PHONE_IP,
    pairPort: PAIR_PORT,
    connectHost: PHONE_IP,
    connectPort: CONNECT_PORT,
    warnings: [],
  });
  assert.equal(calls.filter((args) => args[0] === 'mdns').length, 2);
  assert.deepEqual(sleeps, [500]);
});

test('connection service: a connect-property command failure falls back to mDNS without discarding the IP', async (t) => {
  const calls = [];
  const runner = discoveryRunner({
    calls,
    services: [
      { service: CONNECT_SERVICE, port: CONNECT_PORT },
      { service: PAIR_SERVICE, port: PAIR_PORT },
    ],
  });
  const { service } = setup(t, {
    runner: async (args) => {
      if (args[0] === '-s' && args.includes('getprop')) {
        calls.push(args);
        throw new Error('getprop unavailable');
      }
      return runner(args);
    },
    sleep: async () => {},
  });

  assert.deepEqual(await service.discoverWirelessConfig(), {
    usbSerial: USB_SERIAL,
    pairHost: PHONE_IP,
    pairPort: PAIR_PORT,
    connectHost: PHONE_IP,
    connectPort: CONNECT_PORT,
    warnings: [],
  });
  assert.equal(calls.filter((args) => args[0] === 'mdns').length, 1);
});

test('connection service: pairing poll timeout returns connect data with an actionable warning', async (t) => {
  const calls = [];
  const sleeps = [];
  const { service } = setup(t, {
    runner: discoveryRunner({ calls, services: [] }),
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.deepEqual(await service.discoverWirelessConfig(), {
    usbSerial: USB_SERIAL,
    pairHost: PHONE_IP,
    pairPort: null,
    connectHost: PHONE_IP,
    connectPort: CONNECT_PORT,
    warnings: [PAIRING_PORT_WARNING],
  });
  assert.equal(calls.filter((args) => args[0] === 'mdns').length, 16);
  assert.deepEqual(sleeps, Array(16).fill(500));
});

test('connection service: mDNS execution time counts toward the absolute polling deadline', async (t) => {
  const calls = [];
  const sleeps = [];
  let elapsed = 0;
  const runner = discoveryRunner({ calls, services: [] });
  const { service } = setup(t, {
    runner: async (args) => {
      if (args[0] === 'mdns') elapsed += 7_800;
      return runner(args);
    },
    now: () => elapsed,
    sleep: async (ms) => {
      sleeps.push(ms);
      elapsed += ms;
    },
  });

  assert.deepEqual(await service.discoverWirelessConfig(), {
    usbSerial: USB_SERIAL,
    pairHost: PHONE_IP,
    pairPort: null,
    connectHost: PHONE_IP,
    connectPort: CONNECT_PORT,
    warnings: [PAIRING_PORT_WARNING],
  });
  assert.equal(calls.filter((args) => args[0] === 'mdns').length, 1);
  assert.deepEqual(sleeps, [200]);
  assert.equal(elapsed, 8_000);
});

test('connection service: mDNS command failures preserve connect data and return a pairing warning', async (t) => {
  const calls = [];
  const sleeps = [];
  const runner = discoveryRunner({ calls });
  const { service } = setup(t, {
    runner: async (args) => {
      if (args[0] === 'mdns') {
        calls.push(args);
        throw new Error('mdns unavailable');
      }
      return runner(args);
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.deepEqual(await service.discoverWirelessConfig(), {
    usbSerial: USB_SERIAL,
    pairHost: PHONE_IP,
    pairPort: null,
    connectHost: PHONE_IP,
    connectPort: CONNECT_PORT,
    warnings: [PAIRING_PORT_WARNING],
  });
  assert.equal(calls.filter((args) => args[0] === 'mdns').length, 16);
  assert.deepEqual(sleeps, Array(16).fill(500));
});

test('connection service: both Wi-Fi IP command failures return null fields and warnings instead of throwing', async (t) => {
  const calls = [];
  const { service } = setup(t, {
    runner: async (args) => {
      calls.push(args);
      if (args[0] === '-s' && args[2] === 'get-state') return 'device\n';
      throw new Error('wlan0 query failed');
    },
  });

  assert.deepEqual(await service.discoverWirelessConfig(), {
    usbSerial: USB_SERIAL,
    pairHost: null,
    pairPort: null,
    connectHost: null,
    connectPort: null,
    warnings: [WIFI_IP_WARNING, CONNECT_PORT_WARNING, PAIRING_PORT_WARNING],
  });
  assert.deepEqual(calls, [
    ['-s', USB_SERIAL, 'get-state'],
    ['-s', USB_SERIAL, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
    ['-s', USB_SERIAL, 'shell', 'ip', 'route', 'show', 'dev', 'wlan0'],
    ['-s', USB_SERIAL, 'shell', 'getprop', 'service.adb.tls.port'],
  ]);
});

test('connection service: a never-resolving mDNS command cannot defeat the deadline and late data is discarded', { timeout: 500 }, async (t) => {
  const calls = [];
  let elapsed = 0;
  let mdnsSignal;
  let releaseMdns;
  const runner = discoveryRunner({ calls, services: [] });
  const { service } = setup(t, {
    runner: async (args, options = {}) => {
      if (args[0] === 'mdns') {
        calls.push(args);
        mdnsSignal = options.signal;
        return new Promise((resolve) => { releaseMdns = resolve; });
      }
      return runner(args);
    },
    now: () => elapsed,
    deadlineWait: async (ms) => { elapsed += ms; },
    sleep: async (ms) => { elapsed += ms; },
  });

  const result = await service.discoverWirelessConfig();

  assert.deepEqual(result, {
    usbSerial: USB_SERIAL,
    pairHost: PHONE_IP,
    pairPort: null,
    connectHost: PHONE_IP,
    connectPort: CONNECT_PORT,
    warnings: [PAIRING_PORT_WARNING],
  });
  assert.equal(calls.filter((args) => args[0] === 'mdns').length, 1);
  assert.equal(elapsed, 8_000);
  assert.equal(mdnsSignal.aborted, true);

  releaseMdns(mdnsOutput([{ service: PAIR_SERVICE, port: PAIR_PORT }]));
  await Promise.resolve();
  assert.equal(result.pairPort, null, 'a result received after cancellation must not change the response');
});

test('connection service: mDNS data arriving after its remaining budget is discarded while earlier partial data survives', async (t) => {
  const calls = [];
  const sleeps = [];
  let elapsed = 0;
  let mdnsCalls = 0;
  let secondSignal;
  const runner = discoveryRunner({
    calls,
    connectOutput: '\n',
    services: [{ service: CONNECT_SERVICE, port: CONNECT_PORT }],
  });
  const { service } = setup(t, {
    runner: async (args, options = {}) => {
      if (args[0] === 'mdns') {
        calls.push(args);
        mdnsCalls += 1;
        if (mdnsCalls === 1) {
          elapsed += 7_000;
          return runner(args);
        }
        secondSignal = options.signal;
        elapsed += 600;
        return mdnsOutput([{ service: PAIR_SERVICE, port: PAIR_PORT }]);
      }
      return runner(args);
    },
    now: () => elapsed,
    sleep: async (ms) => {
      sleeps.push(ms);
      elapsed += ms;
    },
  });

  assert.deepEqual(await service.discoverWirelessConfig(), {
    usbSerial: USB_SERIAL,
    pairHost: PHONE_IP,
    pairPort: null,
    connectHost: PHONE_IP,
    connectPort: CONNECT_PORT,
    warnings: [PAIRING_PORT_WARNING],
  });
  assert.equal(mdnsCalls, 2);
  assert.deepEqual(sleeps, [500]);
  assert.equal(elapsed, 8_100);
  assert.equal(secondSignal.aborted, true);
});

test('connection service: discovery uses a monotonic clock rather than Date.now', async (t) => {
  t.mock.method(Date, 'now', () => { throw new Error('wall clock must not govern discovery'); });
  const store = { save() { throw new Error('discovery must not save'); } };
  const adb = createAdb(discoveryRunner({ services: [{ service: PAIR_SERVICE, port: PAIR_PORT }] }));
  const service = createConnectionService({
    adb,
    store,
    usbSerial: USB_SERIAL,
    sleep: async () => {},
  });

  const result = await service.discoverWirelessConfig();
  assert.equal(result.pairPort, PAIR_PORT);
  assert.deepEqual(result.warnings, []);
});

test('connection service: expiry terminates the real mDNS subprocess', { timeout: 3_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'connection-service-mdns-process-'));
  const pidFile = join(dir, 'mdns.pid');
  t.after(() => {
    if (!existsSync(pidFile)) return;
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeAdb = join(dir, 'fake-adb.mjs');
  writeFileSync(fakeAdb, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '-s' && args[2] === 'get-state') {
  console.log('device');
} else if (args[0] === '-s' && args.includes('addr')) {
  console.log('    inet ${PHONE_IP}/24 scope global wlan0');
} else if (args[0] === '-s' && args.includes('getprop')) {
  console.log('${CONNECT_PORT}');
} else if (args[0] === 'mdns') {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  throw new Error('unexpected adb command');
}
`);
  chmodSync(fakeAdb, 0o755);
  const previousAdb = process.env.PHONE_ADB;
  process.env.PHONE_ADB = fakeAdb;
  t.after(() => {
    if (previousAdb === undefined) delete process.env.PHONE_ADB;
    else process.env.PHONE_ADB = previousAdb;
  });

  const store = createConnectionConfigStore({ file: join(dir, 'connection.json') });
  const started = performance.now();
  let clockReads = 0;
  const service = createConnectionService({
    adb: createAdb(),
    store,
    usbSerial: USB_SERIAL,
    now: () => (clockReads++ === 0 ? 0 : 7_250 + performance.now() - started),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  const result = await service.discoverWirelessConfig();
  assert.equal(performance.now() - started < 2_000, true, 'discovery must return before the full poll window');
  assert.equal(result.connectPort, CONNECT_PORT);
  assert.equal(result.pairPort, null);
  assert.deepEqual(result.warnings, [PAIRING_PORT_WARNING]);
  assert.equal(existsSync(pidFile), true, 'the fake adb mDNS process must have started');

  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') break;
      throw err;
    }
    if (attempt === 99) assert.fail(`mDNS subprocess ${pid} survived cancellation`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

// ---------------------------------------------------------------------------
// Task 2: legacy connection service
// ---------------------------------------------------------------------------

const LEGACY_ADDRESS = '192.168.1.77:5555';
const LEGACY_INPUT = Object.freeze({ host: '192.168.1.77', port: 5555, enableTcpip: false });
const TCPIP_INPUT = Object.freeze({ host: '192.168.1.77', port: '5555', enableTcpip: true });

test('connection service: status exposes the active connection method', async (t) => {
  const { service } = setup(t, {
    initial: { mode: 'wifi', serial: LEGACY_ADDRESS, method: 'legacy' },
    stored: { mode: 'wifi', method: 'legacy', address: LEGACY_ADDRESS },
    runner: async () => 'device\n',
  });

  assert.deepEqual(await service.status(), {
    mode: 'wifi', serial: LEGACY_ADDRESS, online: true, usbOnline: true, method: 'legacy',
  });
});

test('connection service: USB status explicitly reports the pair method', async (t) => {
  const { service } = setup(t, {
    initial: { mode: 'usb', serial: USB_SERIAL },
    runner: async (args) => (args[0] === '-s' ? 'device\n' : ''),
  });

  assert.deepEqual(await service.status(), {
    mode: 'usb', serial: USB_SERIAL, online: true, usbOnline: true, method: 'pair',
  });
});

test('connection service: connectLegacy confirms the target before persisting and activating legacy mode', async (t) => {
  const calls = [];
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => { calls.push(args); return 'device\n'; },
  });

  const result = await service.connectLegacy(LEGACY_INPUT);

  assert.deepEqual(calls, [
    ['connect', LEGACY_ADDRESS],
    ['-s', LEGACY_ADDRESS, 'get-state'],
    ['-s', LEGACY_ADDRESS, 'get-state'],
    ['-s', USB_SERIAL, 'get-state'],
  ]);
  assert.equal(calls.some((args) => args[2] === 'tcpip'), false);
  assert.equal(calls.some((args) => args[0] === 'devices'), false);
  assert.equal(adb.getMode(), 'wifi');
  assert.equal(adb.getSerial(), LEGACY_ADDRESS);
  assert.equal(adb.getMethod(), 'legacy');
  assert.deepEqual(store.load(), { mode: 'wifi', method: 'legacy', address: LEGACY_ADDRESS });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    mode: 'wifi', method: 'legacy', address: LEGACY_ADDRESS,
  });
  assert.deepEqual(result, {
    mode: 'wifi', serial: LEGACY_ADDRESS, online: true, usbOnline: true, method: 'legacy',
  });
});

test('connection service: connectLegacy with bootstrap probes USB, runs tcpip, then connects', async (t) => {
  const calls = [];
  const { adb, store, service } = setup(t, {
    runner: async (args) => { calls.push(args); return 'device\n'; },
  });

  const result = await service.connectLegacy(TCPIP_INPUT);

  assert.deepEqual(calls, [
    ['-s', USB_SERIAL, 'get-state'],
    ['-s', USB_SERIAL, 'tcpip', '5555'],
    ['connect', LEGACY_ADDRESS],
    ['-s', LEGACY_ADDRESS, 'get-state'],
    ['-s', LEGACY_ADDRESS, 'get-state'],
    ['-s', USB_SERIAL, 'get-state'],
  ]);
  assert.equal(adb.getMethod(), 'legacy');
  assert.deepEqual(store.load(), { mode: 'wifi', method: 'legacy', address: LEGACY_ADDRESS });
  assert.deepEqual(result, {
    mode: 'wifi', serial: LEGACY_ADDRESS, online: true, usbOnline: true, method: 'legacy',
  });
});

test('connection service: legacy bootstrap rejects an offline USB before any network mutation', async (t) => {
  const cases = [
    { label: 'offline output', output: 'offline\n' },
    {
      label: 'device-not-found stderr',
      failure: Object.assign(new Error('Command failed: adb get-state'), {
        stderr: `error: device '${USB_SERIAL}' not found\n`,
      }),
    },
  ];
  for (const { label, output, failure } of cases) {
    const calls = [];
    const { adb, store, service, file } = setup(t, {
      runner: async (args) => {
        calls.push(args);
        if (failure) throw failure;
        return output;
      },
    });
    const before = readFileSync(file);

    await assert.rejects(service.connectLegacy(TCPIP_INPUT), (err) => {
      assert.equal(err.code, 'USB_OFFLINE', label);
      assert.match(err.message, /USB device is offline/);
      return true;
    });

    assert.deepEqual(calls, [['-s', USB_SERIAL, 'get-state']], label);
    assert.equal(adb.getMode(), 'usb');
    assert.equal(adb.getSerial(), 'USB-ORIGINAL');
    assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
    assert.deepEqual(readFileSync(file), before);
  }
});

test('connection service: legacy bootstrap preserves host-side get-state failures instead of reporting USB offline', async (t) => {
  const failures = [
    Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }),
    Object.assign(new Error('adb server failure'), {
      stderr: "error: cannot connect to daemon at 'tcp:5037': Connection refused\n",
    }),
  ];
  for (const failure of failures) {
    const calls = [];
    const { service } = setup(t, {
      runner: async (args) => { calls.push(args); throw failure; },
    });

    await assert.rejects(service.connectLegacy(TCPIP_INPUT), (err) => err === failure);
    assert.deepEqual(calls, [['-s', USB_SERIAL, 'get-state']]);
  }
});

test('connection service: a failed tcpip leaves the active device and persisted config unchanged', async (t) => {
  const calls = [];
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => {
      calls.push(args);
      if (args[2] === 'tcpip') throw new Error('tcpip rejected');
      return 'device\n';
    },
  });
  const before = readFileSync(file);

  await assert.rejects(service.connectLegacy(TCPIP_INPUT), /tcpip rejected/);

  assert.deepEqual(calls, [
    ['-s', USB_SERIAL, 'get-state'],
    ['-s', USB_SERIAL, 'tcpip', '5555'],
  ]);
  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.equal(adb.getMethod(), 'pair');
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: a connect failure after tcpip leaves the previous pair state unchanged', async (t) => {
  const previousAddress = '10.0.0.9:5555';
  const calls = [];
  const { adb, store, service, file } = setup(t, {
    initial: { mode: 'wifi', serial: previousAddress, method: 'pair' },
    stored: { mode: 'wifi', method: 'pair', address: previousAddress },
    runner: async (args) => {
      calls.push(args);
      if (args[0] === 'connect') throw new Error('connect rejected');
      return 'device\n';
    },
  });
  const before = readFileSync(file);

  await assert.rejects(service.connectLegacy(TCPIP_INPUT), /connect rejected/);

  assert.deepEqual(calls, [
    ['-s', USB_SERIAL, 'get-state'],
    ['-s', USB_SERIAL, 'tcpip', '5555'],
    ['connect', LEGACY_ADDRESS],
  ]);
  assert.equal(adb.getMode(), 'wifi');
  assert.equal(adb.getSerial(), previousAddress);
  assert.equal(adb.getMethod(), 'pair');
  assert.deepEqual(store.load(), { mode: 'wifi', method: 'pair', address: previousAddress });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: an offline target after connect is not activated or persisted as legacy', async (t) => {
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => (args[0] === '-s' ? 'offline\n' : ''),
  });
  const before = readFileSync(file);

  await assert.rejects(service.connectLegacy(LEGACY_INPUT), /offline after connect/i);

  assert.equal(adb.getMode(), 'usb');
  assert.equal(adb.getSerial(), 'USB-ORIGINAL');
  assert.equal(adb.getMethod(), 'pair');
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: invalid legacy input is rejected before any ADB command or persistence', async (t) => {
  const calls = [];
  const { adb, store, service, file } = setup(t, {
    runner: async (args) => { calls.push(args); return ''; },
  });
  const before = readFileSync(file);
  const invalidInputs = [
    [null, /input/],
    [[], /input/],
    [{ ...LEGACY_INPUT, host: '' }, /host/],
    [{ ...LEGACY_INPUT, host: 'bad host' }, /host/],
    [{ ...LEGACY_INPUT, host: '192.168.1.999' }, /host/],
    [{ ...LEGACY_INPUT, port: 0 }, /port/],
    [{ ...LEGACY_INPUT, port: 65536 }, /port/],
    [{ ...LEGACY_INPUT, port: 'abc' }, /port/],
    [{ ...LEGACY_INPUT, enableTcpip: 'yes' }, /enableTcpip/],
  ];

  for (const [input, expected] of invalidInputs) {
    await assert.rejects(service.connectLegacy(input), expected);
  }

  assert.deepEqual(calls, []);
  assert.equal(adb.getMode(), 'usb');
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: a failed user-triggered bootstrap warns once per outage window', async (t) => {
  let clock = 0;
  const warnings = [];
  const { service } = setup(t, {
    now: () => clock,
    warn: (message) => warnings.push(message),
    runner: async (args) => {
      if (args[2] === 'tcpip') throw new Error('tcpip rejected');
      return 'device\n';
    },
  });

  await assert.rejects(service.connectLegacy(TCPIP_INPUT), /tcpip rejected/);
  await assert.rejects(service.connectLegacy(TCPIP_INPUT), /tcpip rejected/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tcpip rejected/);

  clock = 60_000;
  await assert.rejects(service.connectLegacy(TCPIP_INPUT), /tcpip rejected/);
  assert.equal(warnings.length, 2);
});

test('connection service: pairAndConnect explicitly switches a legacy connection back to pair', async (t) => {
  const { adb, store, service } = setup(t, {
    initial: { mode: 'wifi', serial: LEGACY_ADDRESS, method: 'legacy' },
    stored: { mode: 'wifi', method: 'legacy', address: LEGACY_ADDRESS },
    runner: async () => 'device\n',
  });

  const result = await service.pairAndConnect(PAIR_INPUT);

  assert.equal(result.method, 'pair');
  assert.equal(adb.getMethod(), 'pair');
  assert.deepEqual(store.load(), { mode: 'wifi', method: 'pair', address: WIRELESS_ADDRESS });
});

test('connection service: switchToUsb defines the pair method when leaving legacy mode', async (t) => {
  const { adb, store, service } = setup(t, {
    initial: { mode: 'wifi', serial: LEGACY_ADDRESS, method: 'legacy' },
    stored: { mode: 'wifi', method: 'legacy', address: LEGACY_ADDRESS },
    runner: async () => 'device\n',
  });

  const result = await service.switchToUsb();

  assert.equal(result.method, 'pair');
  assert.equal(adb.getMethod(), 'pair');
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
});

test('connection service: concurrent legacy and USB mutations serialize and return their own status', async (t) => {
  const tcpipGate = deferred();
  let markTcpipStarted;
  const tcpipStarted = new Promise((resolve) => { markTcpipStarted = resolve; });
  const { adb, store, service } = setup(t, {
    runner: async (args) => {
      if (args[2] === 'tcpip') {
        markTcpipStarted();
        await tcpipGate.promise;
      }
      return 'device\n';
    },
  });

  const legacyPromise = service.connectLegacy(TCPIP_INPUT);
  await tcpipStarted;
  const usbPromise = service.switchToUsb();
  try {
    assert.equal(adb.getMode(), 'usb', 'the USB switch must wait for the legacy transaction');
    assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
  } finally {
    tcpipGate.resolve();
    await Promise.allSettled([legacyPromise, usbPromise]);
  }

  const legacy = await legacyPromise;
  assert.deepEqual(legacy, {
    mode: 'wifi', serial: LEGACY_ADDRESS, online: true, usbOnline: true, method: 'legacy',
  });
  const usb = await usbPromise;
  assert.deepEqual(usb, {
    mode: 'usb', serial: USB_SERIAL, online: true, usbOnline: true, method: 'pair',
  });
  assert.equal(adb.getMode(), 'usb');
  assert.deepEqual(store.load(), { mode: 'usb', method: 'pair', address: '' });
});

test('connection service: supervise passes legacy options with the configured USB serial and throttles warnings', async (t) => {
  let clock = 0;
  const warnings = [];
  const options = [];
  const { adb, service } = setup(t, {
    initial: { mode: 'wifi', serial: LEGACY_ADDRESS, method: 'legacy' },
    stored: { mode: 'wifi', method: 'legacy', address: LEGACY_ADDRESS },
    now: () => clock,
    warn: (message) => warnings.push(message),
  });
  // The injected adb is shared with the service; replace its supervision call
  // so the test observes exactly what the service hands to ADB.
  adb.ensureWirelessConnected = async (address, opts) => { options.push(opts); return false; };

  await service.supervise();
  clock = 30_000;
  await service.supervise();
  clock = 70_000;
  await service.supervise();

  assert.equal(options.length, 3);
  for (const opts of options) {
    assert.deepEqual(opts, { method: 'legacy', port: 5555, usbSerial: USB_SERIAL });
  }
  assert.equal(warnings.length, 2, 'repeated failing ticks must not spam warnings');
  assert.match(warnings[0], /legacy/i);
});

test('connection service: supervise stays quiet in pair mode and checks USB in USB mode', async (t) => {
  const warnings = [];
  const options = [];
  const { adb, service } = setup(t, {
    warn: (message) => warnings.push(message),
  });
  adb.ensureWirelessConnected = async (address, opts) => { options.push(opts); return false; };
  let usbChecks = 0;
  adb.ensureUsbOnly = async () => { usbChecks += 1; };

  await service.supervise();
  assert.deepEqual(warnings, []);
  assert.equal(options.length, 0);
  assert.equal(usbChecks, 1);

  adb.setConnection({ mode: 'wifi', serial: WIRELESS_ADDRESS, method: 'pair' });
  await service.supervise();
  assert.deepEqual(warnings, []);
  assert.deepEqual(options, [{ method: 'pair', port: 5555, usbSerial: USB_SERIAL }]);
});

test('connection service: supervision without an explicit serial uses the last-known USB serial', async (t) => {
  let bootstrapPhase = false;
  let wirelessChecks = 0;
  const calls = [];
  const { adb, service } = setup(t, {
    runner: async (args) => {
      calls.push(args);
      if (args[0] === '-s' && args[1] === LEGACY_ADDRESS && args[2] === 'get-state') {
        if (!bootstrapPhase) return 'device\n';
        wirelessChecks += 1;
        return wirelessChecks === 3 ? 'device\n' : 'offline\n';
      }
      if (args[0] === '-s' && args[1] === USB_SERIAL && args[2] === 'get-state') return 'device\n';
      return '';
    },
  });

  await service.connectLegacy(TCPIP_INPUT);
  bootstrapPhase = true;
  calls.length = 0;
  wirelessChecks = 0;

  assert.equal(await adb.ensureWirelessConnected(LEGACY_ADDRESS, { method: 'legacy' }), true);
  assert.ok(calls.some((args) => args.join(' ') === `-s ${USB_SERIAL} tcpip 5555`));
  assert.equal(calls.some((args) => args[1] === DEFAULT_USB_SERIAL && args[2] === 'tcpip'), false);
});
