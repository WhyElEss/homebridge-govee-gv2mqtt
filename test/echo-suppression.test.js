'use strict';

/**
 * Regression tests for "whose change is it": telling gv2mqtt's echo of a
 * command we just sent apart from a change that really happened at the lamp.
 *
 * The mock bridge below is deliberately *not* silent. A mock that only
 * accepts commands and never reports back hides this entire class of bug,
 * because the bug only exists in what the plugin does with a device's
 * unsolicited state reports. So it answers every command the way the real
 * bridge was observed to on 2026-08-31: a state report a moment later,
 * including Govee's known spurious OFF blip a couple of seconds after an
 * effect/color command (see the OFF_UNSOLICITED_GRACE_MS comment in
 * govee-device.ts and commit e300f20). Real delays are compressed to
 * milliseconds; every window the plugin cares about is seconds long, so the
 * ordering under test is unchanged.
 */

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { GoveeDevice } = require('../dist/govee-device');

const DEVICE_ID = 'TESTDEVICE';
const STATE_TOPIC = `gv2mqtt/light/${DEVICE_ID}/state`;
const COMMAND_TOPIC = `gv2mqtt/light/${DEVICE_ID}/command`;

const BLIP_DELAY_MS = 20;
const REPORT_DELAY_MS = 60;

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, log() {} };

function deviceConfig() {
  return {
    name: 'Test Lamp',
    deviceId: DEVICE_ID,
    enabled: true,
    minMireds: 111,
    maxMireds: 500,
    adaptiveLighting: true,
    enableEffects: true,
    colorSaturationThreshold: 0.75,
    turnOffOnStartup: false,
    turnOffOnStartupDelayMs: 10000,
    enableAlert: false,
    alertHue: 0,
    alertSaturation: 100,
    alertBrightness: 100,
    stateTopic: STATE_TOPIC,
    commandTopic: COMMAND_TOPIC,
    discoveryConfigTopic: `homeassistant/light/gv2mqtt-${DEVICE_ID}/config`,
  };
}

/**
 * Stands in for gv2mqtt plus the lamp behind it. `blipAfterCommand` models
 * the transient OFF Govee's cloud emits shortly after an effect/color
 * command, followed by the truthful report.
 */
class MockBridge extends EventEmitter {
  constructor({ blipAfterCommand = false } = {}) {
    super();
    this.published = [];
    this.blipAfterCommand = blipAfterCommand;
    this.timers = [];
    this.lampState = { state: 'OFF', brightness: 100, color_temp: 370, color_mode: 'color_temp', effect: null };
  }

  subscribe(_topic, cb) {
    if (cb) {
      cb(null);
    }
  }

  publish(topic, payload) {
    const command = JSON.parse(payload);
    this.published.push(command);

    if (command.state === 'ON') {
      this.lampState.state = 'ON';
      if (command.effect !== undefined) {
        this.lampState.effect = command.effect;
      }
      if (typeof command.brightness === 'number') {
        this.lampState.brightness = command.brightness;
      }
      if (typeof command.color_temp === 'number') {
        this.lampState.color_temp = command.color_temp;
      }
      if (this.blipAfterCommand) {
        this.at(BLIP_DELAY_MS, () => this.report({ state: 'OFF' }));
      }
    } else {
      this.lampState.state = 'OFF';
    }
    this.at(REPORT_DELAY_MS, () => this.report({ ...this.lampState }));
  }

  /** An unsolicited report - the lamp's own button, or the Govee app. */
  report(msg) {
    this.emit('message', STATE_TOPIC, Buffer.from(JSON.stringify(msg)));
  }

  at(ms, fn) {
    this.timers.push(setTimeout(fn, ms));
  }

  stop() {
    this.timers.forEach(clearTimeout);
  }
}

/**
 * What HomeKit actually ends up holding. Mirrors hap-nodejs 2.2.2's rule
 * (Accessory.handleCharacteristicChangeEvent): an updateCharacteristic only
 * reaches the controller as an event when oldValue !== newValue, so a push
 * of the value HomeKit already has is invisible and a push of a different
 * one is not. Watches the same fields LightAccessory and EffectsAccessory
 * forward on every 'change'.
 */
function mirrorHomeKit(device) {
  const held = { On: undefined, Brightness: undefined, ColorTemperature: undefined, ActiveIdentifier: undefined };
  const events = [];
  device.on('change', (state) => {
    const pushed = {
      On: state.isOn,
      Brightness: state.brightness,
      ColorTemperature: state.mireds,
      ActiveIdentifier: state.effectIndex,
    };
    for (const [name, value] of Object.entries(pushed)) {
      if (held[name] !== value) {
        held[name] = value;
        events.push({ name, value });
      }
    }
  });
  return { held, events, of: (name) => events.filter((e) => e.name === name).map((e) => e.value) };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a spurious OFF blip right after our effect command never reaches HomeKit', async (t) => {
  const bridge = new MockBridge({ blipAfterCommand: true });
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);
  const homekit = mirrorHomeKit(device);

  // The user picks an effect on the Effects accessory.
  device.identifierForName('Night');
  device.setEffectIndex(device.identifierForName('Night'));
  assert.strictEqual(homekit.held.On, true, 'selecting an effect turns the tile on');

  await settle(BLIP_DELAY_MS + 10); // the blip has been and gone

  assert.deepStrictEqual(
    homekit.of('On'),
    [true],
    'HomeKit must never be told the light went off - the blip is our own ON coming back',
  );
  assert.strictEqual(device.getState().isOn, true, 'the cache must not follow the blip either');
  assert.strictEqual(device.getState().mode, 'effect', 'and the effect must survive it');

  await settle(REPORT_DELAY_MS + 10); // the truthful report lands
  assert.deepStrictEqual(homekit.of('On'), [true], 'still no off; the real report agrees with us');
});

test('after the blip, tapping the tile does not wipe the effect', async (t) => {
  const bridge = new MockBridge({ blipAfterCommand: true });
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);
  const homekit = mirrorHomeKit(device);

  const night = device.identifierForName('Night');
  device.setEffectIndex(night);
  await settle(BLIP_DELAY_MS + 10);

  // The user taps the Lightbulb tile. Before the guard this arrived with a
  // cached isOn of false, so setOn took its full power-on path and reset the
  // lamp to normal light - the effect selected a moment ago, gone.
  device.setOn(true, 'lightbulb');

  assert.strictEqual(device.getState().mode, 'effect', 'the effect must still be running');
  assert.strictEqual(device.getState().effectIndex, night);
  assert.ok(
    !bridge.published.some((c) => typeof c.color_temp === 'number' && c.effect === undefined),
    'no plain color-temperature command should have been sent to cancel the effect',
  );
  assert.deepStrictEqual(homekit.of('ActiveIdentifier'), [night], 'the Effects accessory never left the effect');
});

test('a genuine off at the lamp still reaches HomeKit and arms the watchdog', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);
  const homekit = mirrorHomeKit(device);

  // The lamp is on, and nothing we sent put it there (no command published,
  // so the off below is out of band by any measure).
  bridge.report({ state: 'ON', brightness: 100, color_temp: 370, color_mode: 'color_temp', effect: null });
  assert.strictEqual(homekit.held.On, true);

  bridge.report({ state: 'OFF' });
  assert.strictEqual(device.getState().isOn, false, 'an off nobody asked for is the user at the lamp');
  assert.deepStrictEqual(homekit.of('On'), [true, false], 'HomeKit must be told');

  // ...and Govee's cloud settling a stale command must now be pushed back.
  const before = bridge.published.length;
  bridge.report({ state: 'ON', brightness: 100, color_temp: 370, color_mode: 'color_temp', effect: null });
  assert.strictEqual(device.getState().isOn, false, 'the bogus relight is not accepted');
  assert.deepStrictEqual(
    bridge.published.slice(before),
    [{ state: 'OFF' }],
    'the watchdog answers it with an OFF',
  );
});

test('an off we asked for ourselves is reflected as normal', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);
  const homekit = mirrorHomeKit(device);

  device.setOn(true, 'lightbulb');
  await settle(REPORT_DELAY_MS + 10);
  assert.strictEqual(device.getState().isOn, true);

  device.setOn(false, 'lightbulb');
  assert.strictEqual(device.getState().isOn, false, 'a HomeKit off applies immediately');

  await settle(REPORT_DELAY_MS + 10); // the bridge echoes the off back
  assert.strictEqual(device.getState().isOn, false, 'and the echo must not undo it');
  assert.deepStrictEqual(homekit.of('On'), [true, false]);
});
