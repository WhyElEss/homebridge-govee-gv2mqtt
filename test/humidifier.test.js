'use strict';

/**
 * GoveeHumidifier against a mock gv2mqtt and the real HAP-NodeJS. Like the
 * lamp tests, the mock is not silent where it matters: gv2mqtt learns a
 * cloud-driven device's state by polling a few seconds after a command, so a
 * report that predates the command can arrive after it.
 */

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const hap = require('hap-nodejs');
const { GoveeHumidifier, levelToPercent, percentToLevel } = require('../dist/humidifier');

const ID = '1426D4ADFC840924';
const C = hap.Characteristic;
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, log() {} };

const T = {
  power: `gv2mqtt/switch/${ID}/command/powerSwitch`,
  level: `gv2mqtt/number/${ID}/command/manual/1`,
  toggle: `gv2mqtt/switch/${ID}/command/nightlightToggle`,
  light: `gv2mqtt/light/${ID}/command`,
  requestState: `gv2mqtt/${ID}/request-platform-data`,
  status: `gv2mqtt/sensor/sensor-${ID}-gv2mqtt-status/attributes`,
  powerState: `gv2mqtt/humidifier/${ID}/state`,
  levelState: `gv2mqtt/number/${ID}/state/manual`,
  toggleState: `gv2mqtt/switch/${ID}/nightlightToggle/state`,
  lightState: `gv2mqtt/light/${ID}/state`,
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
  publish(topic, payload) {
    this.published.push([topic, String(payload)]);
  }
  report(topic, payload) {
    this.emit('message', topic, Buffer.from(payload));
  }
  sent(topic) {
    return this.published.filter(([t]) => t === topic).map(([, p]) => p);
  }
}

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate', 'Date'] });
  const broker = new MockBroker();
  const platform = { Service: hap.Service, Characteristic: C, api: { hap } };
  const config = { name: 'Humidifier', deviceId: ID };
  const humidifier = new GoveeHumidifier(platform, broker, config, 10000, silentLog);
  const accessory = new hap.Accessory('Humidifier', hap.uuid.generate(ID));
  humidifier.attach(accessory);
  return {
    broker,
    humidifier,
    tick: (ms) => t.mock.timers.tick(ms),
    main: accessory.getService(hap.Service.HumidifierDehumidifier),
    light: accessory.getService(hap.Service.Lightbulb),
  };
}

test('one accessory: humidifier and night light', (t) => {
  const { main, light } = setup(t);
  assert.ok(main && light);
  assert.ok(main.isPrimaryService);
  assert.deepStrictEqual(main.getCharacteristic(C.TargetHumidifierDehumidifierState).props.validValues, [1]);
});

test('each slider band is one of nine levels, and 0 is the lowest level, not off', () => {
  for (let level = 1; level <= 9; level++) {
    assert.strictEqual(percentToLevel(levelToPercent(level)), level);
  }
  assert.strictEqual(levelToPercent(9), 100);
  assert.strictEqual(percentToLevel(0), 1);
  assert.strictEqual(percentToLevel(50), 5);
});

test('a level chosen while off is not sent, and goes out right after power-on', (t) => {
  const { broker, humidifier, tick } = setup(t);
  humidifier.setSpeed(levelToPercent(7));
  tick(2000);
  assert.deepStrictEqual(broker.sent(T.level), []);
  humidifier.setOn(true);
  assert.deepStrictEqual(broker.sent(T.power), ['ON']);
  tick(1000);
  assert.deepStrictEqual(broker.sent(T.level), ['7']);
});

test('while off, the device\'s own level report does not replace the chosen one', (t) => {
  const { broker, humidifier, tick } = setup(t);
  humidifier.setSpeed(levelToPercent(7));
  broker.report(T.levelState, '1');
  humidifier.setOn(true);
  broker.report(T.levelState, '1'); // polled before the level command landed
  tick(1000);
  assert.deepStrictEqual(broker.sent(T.level), ['7']);
});

test('a drag while on is sent once, at the level it ends on', (t) => {
  const { broker, humidifier, tick } = setup(t);
  humidifier.setOn(true);
  tick(1000);
  broker.published.length = 0;
  for (const p of [20, 40, 60, 80]) {
    humidifier.setSpeed(p);
  }
  tick(400);
  assert.deepStrictEqual(broker.sent(T.level), ['8']);
});

test('a stale OFF right after our ON does not flip HomeKit back; repeated writes send once', (t) => {
  const { broker, humidifier, main } = setup(t);
  humidifier.setOn(true);
  humidifier.setOn(true);
  broker.report(T.powerState, 'OFF');
  assert.strictEqual(main.getCharacteristic(C.Active).value, 1);
  assert.deepStrictEqual(broker.sent(T.power), ['ON']);
});

test('the device switched off at its own button is reflected once the echo window is over', (t) => {
  const { broker, humidifier, main, tick } = setup(t);
  humidifier.setOn(true);
  tick(11000);
  broker.report(T.powerState, 'OFF');
  assert.strictEqual(main.getCharacteristic(C.Active).value, 0);
});

test('the night light takes colour and brightness in one command, at full-value colour', (t) => {
  const { broker, humidifier, tick } = setup(t);
  humidifier.setLightOn(true);
  humidifier.setLightAppearance({ hue: 120 });
  humidifier.setLightAppearance({ saturation: 100 });
  humidifier.setLightAppearance({ brightness: 40 });
  tick(400);
  assert.deepStrictEqual(broker.sent(T.toggle), ['ON']);
  assert.deepStrictEqual(broker.sent(T.light).map((p) => JSON.parse(p)), [
    { state: 'ON', brightness: 40, color: { r: 0, g: 255, b: 0 } },
  ]);
});

test('brightness 0 never reaches gv2mqtt, where it means off', (t) => {
  const { broker, humidifier, tick } = setup(t);
  humidifier.setLightOn(true);
  humidifier.setLightAppearance({ brightness: 0 });
  tick(400);
  assert.strictEqual(JSON.parse(broker.sent(T.light)[0]).brightness, 1);
});

test('the night light switches off through nightlightToggle', (t) => {
  const { broker, humidifier } = setup(t);
  humidifier.setLightOn(false);
  assert.deepStrictEqual(broker.sent(T.toggle), ['OFF']);
  assert.deepStrictEqual(broker.sent(T.light), []);
});

test('light reports reach HomeKit', (t) => {
  const { broker, light } = setup(t);
  broker.report(T.toggleState, 'ON');
  broker.report(T.lightState, JSON.stringify({ state: 'ON', brightness: 60, color: { r: 0, g: 0, b: 255 } }));
  assert.strictEqual(light.getCharacteristic(C.On).value, true);
  assert.strictEqual(light.getCharacteristic(C.Brightness).value, 60);
  assert.strictEqual(light.getCharacteristic(C.Hue).value, 240);
});

test('switching the device off puts the light out in HomeKit at once, and on brings it back', (t) => {
  const { broker, humidifier, light } = setup(t);
  humidifier.setOn(true);
  humidifier.setLightOn(true);
  humidifier.setOn(false);
  assert.strictEqual(light.getCharacteristic(C.On).value, false);
  assert.deepStrictEqual(broker.sent(T.toggle), ['ON'], 'no command for the light - the device does it');
  humidifier.setOn(true);
  assert.strictEqual(light.getCharacteristic(C.On).value, true);
});

test('the device switched off elsewhere puts the light out in HomeKit too', (t) => {
  const { broker, light } = setup(t);
  broker.report(T.powerState, 'ON');
  broker.report(T.toggleState, 'ON');
  broker.report(T.powerState, 'OFF');
  broker.report(T.toggleState, 'OFF');
  assert.strictEqual(light.getCharacteristic(C.On).value, false);
  broker.report(T.powerState, 'ON');
  assert.strictEqual(light.getCharacteristic(C.On).value, true, 'it comes back with the device');
});

test('the light can be on with the mist off', (t) => {
  const { broker, light } = setup(t);
  broker.report(T.powerState, 'OFF');
  broker.report(T.toggleState, 'ON');
  assert.strictEqual(light.getCharacteristic(C.On).value, true);
});

test('every command is followed by a fresh poll, once, just after the echo window', (t) => {
  const { broker, humidifier, tick } = setup(t);
  humidifier.setOn(true);
  humidifier.setLightOn(true);
  tick(1000); // the level and the light's colour follow the power and toggle commands
  tick(10500);
  assert.deepStrictEqual(broker.sent(T.requestState), []);
  tick(1000);
  assert.deepStrictEqual(broker.sent(T.requestState), ['PRESS']);
});

test('a rejected command is corrected by that poll', (t) => {
  const { broker, humidifier, main, tick } = setup(t);
  humidifier.setOn(false);
  tick(11000);
  broker.report(T.powerState, 'ON'); // Govee refused the OFF; the poll says it still runs
  assert.strictEqual(main.getCharacteristic(C.Active).value, 1);
});

test('offline: Home shows no response and nothing is sent', (t) => {
  const { broker, main } = setup(t);
  broker.report(T.status, JSON.stringify({ overall: { online: false } }));
  const active = main.getCharacteristic(C.Active);
  broker.published.length = 0;
  return active
    .handleGetRequest()
    .then(
      () => assert.fail('a read should fail'),
      () => undefined,
    )
    .then(() => active.handleSetRequest(1))
    .then(
      () => assert.fail('a write should fail'),
      () => assert.deepStrictEqual(broker.published, []),
    );
});

test('back online: HomeKit gets the state again', (t) => {
  const { broker, main } = setup(t);
  broker.report(T.status, JSON.stringify({ overall: { online: false } }));
  broker.report(T.status, JSON.stringify({ overall: { online: true } }));
  return main.getCharacteristic(C.Active).handleGetRequest().then((v) => assert.strictEqual(v, 0));
});

test('only the light values that changed are sent', (t) => {
  const { broker, humidifier, tick } = setup(t);
  broker.report(T.lightState, JSON.stringify({ state: 'ON', brightness: 60, color: { r: 0, g: 0, b: 255 } }));
  humidifier.setLightOn(true);
  tick(400);
  assert.deepStrictEqual(broker.sent(T.light), [], 'nothing to change - the device keeps its colour');
  humidifier.setLightAppearance({ brightness: 30 });
  tick(400);
  assert.deepStrictEqual(broker.sent(T.light).map((p) => JSON.parse(p)), [{ state: 'ON', brightness: 30 }]);
});
