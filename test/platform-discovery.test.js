'use strict';

/**
 * The platform's device lifecycle against a mock broker and the real
 * HAP-NodeJS: what gets exposed when gv2mqtt announces something, and - the
 * part that can do damage - what gets taken out of HomeKit when it stops.
 * Removing an accessory by mistake loses every scene and automation built on
 * it, so the "never on silence alone" cases matter as much as the removal.
 */

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hap = require('hap-nodejs');

// mqtt's exports are getter-only, so the whole module is swapped in the
// require cache before the platform loads it.
let currentBroker = null;
const connect = () => currentBroker;
require.cache[require.resolve('mqtt')] = {
  id: 'mqtt',
  filename: require.resolve('mqtt'),
  loaded: true,
  exports: { __esModule: true, default: { connect }, connect },
};

class MockBroker extends EventEmitter {
  constructor() {
    super();
    this.published = [];
  }
  subscribe(_topic, cb) {
    if (cb) {
      cb(null);
    }
  }
  unsubscribe() {}
  publish(topic, payload) {
    this.published.push({ topic, payload: String(payload) });
  }
  announce(kind, uniqueId, payload) {
    this.emit('message', `homeassistant/${kind}/${uniqueId}/config`, Buffer.from(JSON.stringify(payload)));
  }
}

/** Homebridge's PlatformAccessory is a thin wrapper around this. */
class FakePlatformAccessory extends hap.Accessory {
  constructor(displayName, uuid) {
    super(displayName, uuid);
    this.context = {};
  }
}

const silentLog = Object.assign(() => {}, { debug() {}, info() {}, warn() {}, error() {}, log() {} });

const LAMP = '18DFD0C806467677';
const HUMIDIFIER = '1426D4ADFC840924';
const MIN = 60 * 1000;

/** Passing an earlier platform's `dir` is a restart: same config.json and persist directory. */
function makePlatform(platformConfig, cachedKeys = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv2-'))) {
  const broker = new MockBroker();
  currentBroker = broker;

  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ platforms: [{ platform: 'GoveeGv2Mqtt', ...platformConfig }] }));

  const registered = new Map();
  const api = new EventEmitter();
  api.hap = hap;
  api.platformAccessory = FakePlatformAccessory;
  const persistPath = path.join(dir, 'persist');
  fs.mkdirSync(persistPath, { recursive: true });
  api.user = { configPath: () => configPath, persistPath: () => persistPath };
  api.registerPlatformAccessories = (_p, _n, list) => list.forEach((a) => registered.set(a.UUID, a));
  api.unregisterPlatformAccessories = (_p, _n, list) => list.forEach((a) => registered.delete(a.UUID));
  api.updatePlatformAccessories = () => {};

  const { GoveeGv2MqttPlatform } = require('../dist/platform');
  const platform = new GoveeGv2MqttPlatform(silentLog, platformConfig, api);
  // What Homebridge hands back from its accessory cache before launch.
  for (const key of cachedKeys) {
    const accessory = new FakePlatformAccessory(key, hap.uuid.generate(`homebridge-govee-gv2mqtt:${key}`));
    registered.set(accessory.UUID, accessory);
    platform.configureAccessory(accessory);
  }
  api.emit('didFinishLaunching');
  const names = () => [...registered.values()].map((a) => a.displayName).sort();
  const savedDevices = () => JSON.parse(fs.readFileSync(configPath, 'utf8')).platforms[0].devices;
  return { broker, platform, registered, names, savedDevices, dir };
}

const lampConfig = { name: 'Table Lamp', deviceId: LAMP };

function announceLamp(broker) {
  broker.announce('light', `gv2mqtt-${LAMP}`, { name: null, device: { name: 'Table Lamp' } });
}

function announceHumidifier(broker, lightFirst = false) {
  const humidifier = () =>
    broker.announce('humidifier', `gv2mqtt-${HUMIDIFIER}-humidifier`, { name: null, device: { name: 'Smart Humidifier Lite' } });
  const light = () =>
    broker.announce('light', `gv2mqtt-${HUMIDIFIER}`, { name: 'Night Light', device: { name: 'Smart Humidifier Lite' } });
  if (lightFirst) {
    light();
    humidifier();
  } else {
    humidifier();
    light();
  }
}

function timers(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'setImmediate', 'Date'] });
}

test('a new humidifier is one accessory, with no separate light for its night light', (t) => {
  timers(t);
  const { broker, names, savedDevices } = makePlatform({ mqttUrl: 'mqtt://x', autoDiscover: true, devices: [lampConfig] });
  announceLamp(broker);
  announceHumidifier(broker);
  assert.deepStrictEqual(names(), ['Smart Humidifier Lite', 'Table Lamp', 'Table Lamp Effects']);
  assert.deepStrictEqual(
    savedDevices().find((d) => d.deviceId === HUMIDIFIER),
    { name: 'Smart Humidifier Lite', deviceId: HUMIDIFIER },
  );
});

test('a humidifier whose light config comes first still ends up as one accessory', (t) => {
  timers(t);
  const { broker, names } = makePlatform({ mqttUrl: 'mqtt://x', autoDiscover: true, devices: [lampConfig] });
  announceHumidifier(broker, true);
  assert.deepStrictEqual(names().filter((n) => n.startsWith('Smart')), ['Smart Humidifier Lite']);
});

test('the light and effects an older version made for a humidifier are removed', (t) => {
  timers(t);
  const { broker, names } = makePlatform(
    { mqttUrl: 'mqtt://x', autoDiscover: true, devices: [lampConfig, { name: 'Smart Humidifier Lite', deviceId: HUMIDIFIER }] },
    [`${HUMIDIFIER}-light`, `${HUMIDIFIER}-effects`],
  );
  announceLamp(broker);
  announceHumidifier(broker);
  t.mock.timers.tick(20000);
  assert.deepStrictEqual(names().filter((n) => n.includes(HUMIDIFIER) || n.startsWith('Smart')), ['Smart Humidifier Lite']);
});

test('no periodic re-announce by default: the birth message goes out only on connect', (t) => {
  timers(t);
  const { broker } = makePlatform({ mqttUrl: 'mqtt://x', autoDiscover: true, devices: [lampConfig] });
  broker.emit('connect');
  const births = () => broker.published.filter((p) => p.topic === 'homeassistant/status').length;
  const before = births();
  t.mock.timers.tick(60 * MIN);
  assert.strictEqual(births() - before, 0);
});

// ---- Following the Govee account through its device list ----------------

const MAC = { [LAMP]: '18:DF:D0:C8:06:46:76:77', [HUMIDIFIER]: '14:26:D4:AD:FC:84:09:24', NEW1: 'AA:BB:CC:DD:EE:FF:00:11' };

/** Replaces fetch with Govee's device list; `answer` can be changed between checks. */
function mockGovee(t, ids) {
  const state = { ids, ok: true, calls: 0 };
  const original = global.fetch;
  global.fetch = async () => {
    state.calls++;
    if (!state.ok) {
      return { ok: false, status: 500, json: async () => ({ code: 500 }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 200, data: state.ids.map((id) => ({ device: MAC[id] })) }) };
  };
  t.after(() => {
    global.fetch = original;
  });
  return state;
}

/** Device-list tests keep setImmediate real: fetch's promises must be able to settle. */
function listTimers(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
}

async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

async function runCheck(t, ms) {
  t.mock.timers.tick(ms);
  await settle();
}

test('without a Govee API key the device list is never read', async (t) => {
  listTimers(t);
  const govee = mockGovee(t, [LAMP]);
  makePlatform({ mqttUrl: 'mqtt://x', autoDiscover: true, devices: [lampConfig] });
  await runCheck(t, 30 * MIN);
  assert.strictEqual(govee.calls, 0);
});

test('a device added to the Govee account makes gv2mqtt announce, once', async (t) => {
  listTimers(t);
  const govee = mockGovee(t, [LAMP, HUMIDIFIER]);
  const { broker } = makePlatform({ mqttUrl: 'mqtt://x', autoDiscover: true, goveeApiKey: 'K', devices: [lampConfig] });
  const births = () => broker.published.filter((p) => p.topic === 'homeassistant/status').length;
  await runCheck(t, 30000); // baseline
  const before = births();
  await runCheck(t, 10 * MIN); // unchanged list
  assert.strictEqual(births(), before, 'no announce while nothing changes');
  govee.ids = [LAMP, HUMIDIFIER, 'NEW1'];
  await runCheck(t, 10 * MIN);
  assert.strictEqual(births(), before + 1);
  await runCheck(t, 10 * MIN);
  assert.strictEqual(births(), before + 1, 'and not again');
});

test('a device missing from the Govee list twice in a row leaves HomeKit, and gv2mqtt cannot bring it back', async (t) => {
  listTimers(t);
  const govee = mockGovee(t, [LAMP, HUMIDIFIER]);
  const { broker, names, savedDevices } = makePlatform({ mqttUrl: 'mqtt://x', autoDiscover: true, goveeApiKey: 'K', devices: [lampConfig] });
  announceLamp(broker);
  announceHumidifier(broker);
  await runCheck(t, 30000);
  govee.ids = [LAMP];
  await runCheck(t, 10 * MIN);
  assert.ok(names().includes('Smart Humidifier Lite'), 'one miss is not enough');
  await runCheck(t, 10 * MIN);
  assert.deepStrictEqual(names(), ['Table Lamp', 'Table Lamp Effects']);
  assert.ok(savedDevices().some((d) => d.deviceId === HUMIDIFIER), 'its config entry is kept');
  announceHumidifier(broker); // gv2mqtt still remembers it until it restarts
  assert.ok(!names().includes('Smart Humidifier Lite'));
});

test('a removed device that returns to the account is exposed again', async (t) => {
  listTimers(t);
  const govee = mockGovee(t, [LAMP, HUMIDIFIER]);
  const { broker, names } = makePlatform({ mqttUrl: 'mqtt://x', autoDiscover: true, goveeApiKey: 'K', devices: [lampConfig] });
  announceLamp(broker);
  announceHumidifier(broker);
  await runCheck(t, 30000);
  govee.ids = [LAMP];
  await runCheck(t, 10 * MIN);
  await runCheck(t, 10 * MIN);
  assert.ok(!names().includes('Smart Humidifier Lite'));
  govee.ids = [LAMP, HUMIDIFIER];
  const births = broker.published.filter((p) => p.topic === 'homeassistant/status').length;
  await runCheck(t, 10 * MIN);
  assert.strictEqual(broker.published.filter((p) => p.topic === 'homeassistant/status').length, births + 1);
  announceHumidifier(broker);
  assert.ok(names().includes('Smart Humidifier Lite'));
});

test('a device that left the account stays out of HomeKit after a restart, and comes back if it returns', async (t) => {
  listTimers(t);
  const govee = mockGovee(t, [LAMP, HUMIDIFIER]);
  const config = { mqttUrl: 'mqtt://x', autoDiscover: true, goveeApiKey: 'K', devices: [lampConfig] };
  const first = makePlatform(config);
  announceLamp(first.broker);
  announceHumidifier(first.broker);
  await runCheck(t, 30000);
  govee.ids = [LAMP];
  await runCheck(t, 10 * MIN);
  await runCheck(t, 10 * MIN);
  assert.ok(!first.names().includes('Smart Humidifier Lite'));

  // The restart reads config.json as autoDiscover left it: the humidifier is in devices[].
  const second = makePlatform({ ...config, devices: first.savedDevices() }, [], first.dir);
  assert.ok(!second.names().includes('Smart Humidifier Lite'), 'not restored at startup');
  announceHumidifier(second.broker);
  assert.ok(!second.names().includes('Smart Humidifier Lite'), 'gv2mqtt cannot bring it back');

  govee.ids = [LAMP, HUMIDIFIER];
  await runCheck(t, 30000);
  announceHumidifier(second.broker);
  assert.ok(second.names().includes('Smart Humidifier Lite'), 'exposed once it is back');

  const third = makePlatform({ ...config, devices: first.savedDevices() }, [], first.dir);
  assert.ok(third.names().includes('Smart Humidifier Lite'), 'and is exposed at the next startup');
});

test('without a Govee API key a device removed earlier is exposed again', async (t) => {
  listTimers(t);
  const govee = mockGovee(t, [LAMP, HUMIDIFIER]);
  const config = { mqttUrl: 'mqtt://x', autoDiscover: true, goveeApiKey: 'K', devices: [lampConfig] };
  const first = makePlatform(config);
  announceLamp(first.broker);
  announceHumidifier(first.broker);
  await runCheck(t, 30000);
  govee.ids = [LAMP];
  await runCheck(t, 10 * MIN);
  await runCheck(t, 10 * MIN);
  const { goveeApiKey: _key, ...noKey } = config;
  const second = makePlatform({ ...noKey, devices: first.savedDevices() }, [], first.dir);
  announceHumidifier(second.broker);
  assert.ok(second.names().includes('Smart Humidifier Lite'));
});

test('a failed or empty answer from Govee removes nothing', async (t) => {
  listTimers(t);
  const govee = mockGovee(t, [LAMP, HUMIDIFIER]);
  const { broker, names } = makePlatform({ mqttUrl: 'mqtt://x', autoDiscover: true, goveeApiKey: 'K', devices: [lampConfig] });
  announceLamp(broker);
  announceHumidifier(broker);
  await runCheck(t, 30000);
  govee.ok = false;
  await runCheck(t, 10 * MIN);
  await runCheck(t, 10 * MIN);
  govee.ok = true;
  govee.ids = [];
  await runCheck(t, 10 * MIN);
  await runCheck(t, 10 * MIN);
  assert.ok(names().includes('Smart Humidifier Lite'));
  assert.ok(names().includes('Table Lamp'));
});

test('a disabled device is never exposed, whatever gv2mqtt announces', (t) => {
  timers(t);
  const { broker, names } = makePlatform({
    mqttUrl: 'mqtt://x',
    autoDiscover: true,
    devices: [lampConfig, { name: 'Smart Humidifier Lite', deviceId: HUMIDIFIER, enabled: false }],
  });
  announceHumidifier(broker);
  assert.ok(!names().some((n) => n.startsWith('Smart Humidifier')));
});
