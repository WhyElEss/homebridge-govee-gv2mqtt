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

function makePlatform(platformConfig, cachedKeys = []) {
  const broker = new MockBroker();
  currentBroker = broker;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv2-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ platforms: [{ platform: 'GoveeGv2Mqtt', ...platformConfig }] }));

  const registered = new Map();
  const api = new EventEmitter();
  api.hap = hap;
  api.platformAccessory = FakePlatformAccessory;
  api.user = { configPath: () => configPath };
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
  return { broker, platform, registered, names, savedDevices };
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

test('the platform asks gv2mqtt to re-announce every 10 minutes by default', (t) => {
  timers(t);
  const { broker } = makePlatform({ mqttUrl: 'mqtt://x', autoDiscover: true, devices: [lampConfig] });
  const births = () => broker.published.filter((p) => p.topic === 'homeassistant/status').length;
  const before = births();
  t.mock.timers.tick(30 * MIN);
  assert.strictEqual(births() - before, 3);
});

test('a device gv2mqtt stops announcing is removed after an hour of others being announced', (t) => {
  timers(t);
  const { broker, names, savedDevices } = makePlatform({ mqttUrl: 'mqtt://x', autoDiscover: true, devices: [lampConfig] });
  announceLamp(broker);
  announceHumidifier(broker);
  for (let i = 0; i < 7; i++) {
    t.mock.timers.tick(10 * MIN);
    announceLamp(broker);
  }
  assert.deepStrictEqual(names(), ['Table Lamp', 'Table Lamp Effects']);
  assert.ok(savedDevices().some((d) => d.deviceId === HUMIDIFIER), 'its config entry is kept');
});

test('silence from gv2mqtt as a whole removes nothing', (t) => {
  timers(t);
  const { broker, names } = makePlatform({ mqttUrl: 'mqtt://x', autoDiscover: true, devices: [lampConfig] });
  announceLamp(broker);
  t.mock.timers.tick(5 * 60 * MIN);
  assert.deepStrictEqual(names(), ['Table Lamp', 'Table Lamp Effects']);
});

test('nothing is removed with periodic refresh turned off', (t) => {
  timers(t);
  const { broker, names } = makePlatform({
    mqttUrl: 'mqtt://x',
    autoDiscover: true,
    periodicRefreshIntervalMs: 0,
    devices: [lampConfig, { name: 'Gone', deviceId: 'AAAA' }],
  });
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(10 * MIN);
    announceLamp(broker);
  }
  assert.ok(names().includes('Gone'));
});

test('a removed device that comes back is exposed again', (t) => {
  timers(t);
  const { broker, names } = makePlatform({ mqttUrl: 'mqtt://x', autoDiscover: true, devices: [lampConfig] });
  announceLamp(broker);
  announceHumidifier(broker);
  for (let i = 0; i < 7; i++) {
    t.mock.timers.tick(10 * MIN);
    announceLamp(broker);
  }
  assert.ok(!names().includes('Smart Humidifier Lite'));
  announceHumidifier(broker);
  assert.ok(names().includes('Smart Humidifier Lite'));
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
