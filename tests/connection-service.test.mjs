import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdb } from '../server/adb.mjs';
import { createConnectionConfigStore } from '../server/connection-config.mjs';
import { createConnectionService } from '../server/connection-service.mjs';

const USB_SERIAL = 'USB-DEFAULT';
const WIRELESS_ADDRESS = 'phone.local:5555';
const PHONE_IP = '192.168.1.42';
const PAIR_PORT = 37123;
const CONNECT_PORT = 42123;
const PAIR_SERVICE = '_adb-tls-pairing._tcp';
const CONNECT_SERVICE = '_adb-tls-connect._tcp';
const PAIR_INPUT = Object.freeze({
  pairHost: '192.168.1.20',
  pairPort: '37123',
  pairCode: '123456',
  connectHost: 'phone.local',
  connectPort: '5555',
});

function setup(t, { runner, initial, stored, sleep } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'connection-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'connection.json');
  const store = createConnectionConfigStore({ file });
  store.save(stored ?? { mode: 'usb', address: '' });
  const adb = createAdb(runner ?? (async () => ''), initial ?? { mode: 'usb', serial: 'USB-ORIGINAL' });
  const service = createConnectionService({ adb, store, usbSerial: USB_SERIAL, sleep });
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
    mode: 'wifi', serial: WIRELESS_ADDRESS, online: true, usbOnline: true,
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
  assert.deepEqual(store.load(), { mode: 'wifi', address: WIRELESS_ADDRESS });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mode: 'wifi', address: WIRELESS_ADDRESS });
  assert.deepEqual(result, {
    mode: 'wifi', serial: WIRELESS_ADDRESS, online: true, usbOnline: true,
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
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
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
  assert.deepEqual(store.load(), { mode: 'wifi', address: WIRELESS_ADDRESS });
  assert.deepEqual(readFileSync(file), before);
});

test('connection service: a post-commit wireless status failure does not turn pairing into a failure', async (t) => {
  const { adb, store, service } = setup(t, {
    runner: async () => 'device\n',
  });
  adb.isOnline = async () => { throw new Error('status read failed after commit'); };

  assert.deepEqual(await service.pairAndConnect(PAIR_INPUT), {
    mode: 'wifi', serial: WIRELESS_ADDRESS, online: true, usbOnline: false,
  });
  assert.equal(adb.getMode(), 'wifi');
  assert.deepEqual(store.load(), { mode: 'wifi', address: WIRELESS_ADDRESS });
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
    mode: 'usb', serial: USB_SERIAL, online: false, usbOnline: false,
  });
  assert.equal(adb.getMode(), 'usb');
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
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
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
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
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
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
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
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
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
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
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
  assert.deepEqual(result, { mode: 'usb', serial: USB_SERIAL, online: true, usbOnline: true });
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
    assert.deepEqual(store.load(), { mode: 'wifi', address: previousAddress });
  } finally {
    pairGate.resolve();
    await Promise.allSettled([pairPromise, usbPromise]);
  }

  assert.deepEqual(await pairPromise, {
    mode: 'wifi', serial: WIRELESS_ADDRESS, online: true, usbOnline: true,
  });
  assert.deepEqual(await usbPromise, { mode: 'usb', serial: USB_SERIAL, online: true, usbOnline: true });
  assert.equal(adb.getMode(), 'usb');
  assert.deepEqual(store.load(), { mode: 'usb', address: '' });
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
  assert.deepEqual(store.load(), { mode: 'wifi', address: previousAddress });
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
      label: 'offline stderr',
      failure: Object.assign(new Error('Command failed: adb -s USB-DEFAULT get-state'), {
        stderr: `error: device '${USB_SERIAL}' offline\n`,
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
    mode: 'wifi', serial: WIRELESS_ADDRESS, online: true, usbOnline: false,
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
      'Wireless connect port is unavailable; make sure Wireless debugging is enabled.',
      'Wireless pairing port is unavailable; open the Android pairing dialog and try again.',
    ],
  });
  assert.deepEqual(calls, [
    ['-s', USB_SERIAL, 'get-state'],
    ['-s', USB_SERIAL, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
    ['-s', USB_SERIAL, 'shell', 'getprop', 'service.adb.tls.port'],
    ...Array.from({ length: 17 }, () => ['mdns', 'services']),
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
  assert.deepEqual(store.load(), { mode: 'wifi', address: WIRELESS_ADDRESS });
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
    warnings: ['Wireless pairing port is unavailable; open the Android pairing dialog and try again.'],
  });
  assert.equal(calls.filter((args) => args[0] === 'mdns').length, 17);
  assert.deepEqual(sleeps, Array(16).fill(500));
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
    warnings: ['Wireless pairing port is unavailable; open the Android pairing dialog and try again.'],
  });
  assert.equal(calls.filter((args) => args[0] === 'mdns').length, 17);
  assert.deepEqual(sleeps, Array(16).fill(500));
});

test('connection service: discovery surfaces a Wi-Fi IP command failure without polling mDNS', async (t) => {
  const calls = [];
  const { service } = setup(t, {
    runner: async (args) => {
      calls.push(args);
      if (args[0] === '-s' && args[2] === 'get-state') return 'device\n';
      throw new Error('wlan0 query failed');
    },
  });

  await assert.rejects(service.discoverWirelessConfig(), /wlan0 query failed/);
  assert.deepEqual(calls, [
    ['-s', USB_SERIAL, 'get-state'],
    ['-s', USB_SERIAL, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
    ['-s', USB_SERIAL, 'shell', 'ip', 'route', 'show', 'dev', 'wlan0'],
  ]);
});
