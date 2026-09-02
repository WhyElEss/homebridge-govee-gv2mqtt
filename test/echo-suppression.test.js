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

/**
 * Home writes Hue and Saturation *before* On when a color is picked on a
 * light that is off. Reproduces the capture from 2026-09-02 09:48:38-41,
 * where red at 100% on an off lamp reached the lamp as plain white: no
 * color command was ever put on the wire.
 */
test('a color picked while the light is off survives being turned on', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);

  assert.strictEqual(device.getState().isOn, false, 'the lamp starts off');

  // Home's color picker: hue and saturation first...
  device.setHue(0);
  device.setSaturation(100);
  await settle(420); // the shared coalescing window

  assert.strictEqual(bridge.published.length, 0, 'touching the color wheel must not wake an off lamp');

  // ...then, well after any same-gesture grace window, the user reaches for
  // the power control. The intent has no deadline: picking a color and then
  // turning the lamp on is one action however long they take over it.
  await settle(2200);
  device.setBrightness(3);
  device.setOn(true, 'lightbulb');

  const colorCommands = bridge.published.filter((c) => c.color);
  assert.strictEqual(colorCommands.length, 1, 'turning on must send the color that was just chosen');
  assert.ok(colorCommands[0].color.r > 0, `expected red, got ${JSON.stringify(colorCommands[0].color)}`);
  assert.strictEqual(colorCommands[0].color.g, 0);
  assert.strictEqual(colorCommands[0].color.b, 0);
  assert.ok(
    !bridge.published.some((c) => typeof c.color_temp === 'number'),
    'no color-temperature command may overwrite the color on the way on',
  );
  assert.strictEqual(device.getState().mode, 'rgb');
});

/**
 * The other direction, and the reason the intent is only remembered when the
 * color was picked on an already-off lamp: a lamp switched off while lit must
 * still come back to normal light. The Adaptive-Lighting scene handling
 * depends on that, so this is the behaviour the widened intent must not eat.
 */
test('a lamp switched off while lit still comes back to normal light', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);

  // On, and coloured red while it was on.
  device.setOn(true, 'lightbulb');
  device.setHue(0);
  device.setSaturation(100);
  await settle(420);
  assert.strictEqual(device.getState().mode, 'rgb');
  assert.ok(bridge.published.some((c) => c.color), 'a lit lamp gets the color immediately');

  device.setOn(false, 'lightbulb');
  const afterOff = bridge.published.length;

  device.setOn(true, 'lightbulb');
  assert.ok(
    !bridge.published.slice(afterOff).some((c) => c.color),
    'the color of a lamp switched off while lit is not restored on power-on',
  );
  assert.strictEqual(device.getState().mode, 'adaptive');
});

/** Picking a white on an off lamp cancels a color picked on it a moment before. */
test('a white picked after a color on an off lamp wins', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);

  device.setHue(0);
  device.setSaturation(100);
  await settle(420);

  device.setSaturation(0); // back to white on the wheel
  await settle(420);

  device.setOn(true, 'lightbulb');
  assert.ok(!bridge.published.some((c) => c.color), 'the cancelled color must not come back');
  assert.ok(bridge.published.some((c) => typeof c.color_temp === 'number'));
  assert.strictEqual(device.getState().mode, 'adaptive');
});

/**
 * The exact brightness burst captured on 2026-09-02 10:19:31-34 while the
 * user dragged the slider: 26 writes, each of which the plugin published as
 * its own command, each answered by its own state report. The lamp was still
 * chasing that queue eight seconds after the drag began.
 */
const CAPTURED_DRAG = [
  100, 100, 100, 100, 100, 100, 100, 100, 56, 1, 100, 99, 1, 100, 100, 74,
  91, 100, 100, 100, 69, 4, 100, 74, 100, 100,
];

test('a slider drag is coalesced into one command', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);

  device.setOn(true, 'lightbulb');
  const before = bridge.published.length;

  for (const value of CAPTURED_DRAG) {
    device.setBrightness(value);
  }
  // The cache must track the finger even though the wire does not.
  assert.strictEqual(device.getState().brightness, 100, 'the cache follows every write immediately');
  assert.strictEqual(bridge.published.length, before, 'nothing is published mid-drag');

  await settle(420);

  const sent = bridge.published.slice(before);
  assert.deepStrictEqual(sent, [{ state: 'ON', brightness: 100 }], `26 writes must collapse to one, got ${sent.length}`);
});

test('a slow drag still tracks live', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);

  device.setOn(true, 'lightbulb');
  const before = bridge.published.length;

  device.setBrightness(40);
  await settle(420);
  device.setBrightness(80);
  await settle(420);

  assert.deepStrictEqual(bridge.published.slice(before), [
    { state: 'ON', brightness: 40 },
    { state: 'ON', brightness: 80 },
  ], 'writes further apart than the coalescing window still go out one by one');
});

/**
 * The drag that defeated v0.7.7's sliding window: Home's slider writes are
 * roughly 250ms apart, so every one of them outran a 100ms window that was
 * rescheduled on each write. A fixed window collapses them whatever their
 * spacing. Values and spacing are from the capture of 2026-09-02 11:31:25-28,
 * which produced nine commands - four of them repeats of a value already sent.
 */
test('a drag at Home\'s real cadence is collapsed, not published per step', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);

  device.setOn(true, 'lightbulb');
  const before = bridge.published.length;

  for (const value of [94, 53, 31, 22, 21, 21, 20, 20, 20]) {
    device.setBrightness(value);
    // Wider than v0.7.7's 100ms window and narrower than this one - the
    // gap that made a sliding window publish every single write.
    await settle(150);
  }
  await settle(420);

  const sent = bridge.published.slice(before);
  assert.ok(sent.length <= 3, `nine writes must not become nine commands, got ${sent.length}`);
  assert.strictEqual(sent[sent.length - 1].brightness, 20, 'and the last one carries where the finger stopped');
});

/**
 * The device stores hue and level independently - through the same capture
 * the reports kept color:{r:128,g:0,b:255} while brightness walked 94 -> 21.
 * Scaling the RGB by brightness as well dims it twice.
 */
test('colour goes out at full value, with brightness as its own field', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);

  device.setOn(true, 'lightbulb');
  device.setBrightness(17);
  await settle(420);
  const before = bridge.published.length;

  device.setHue(270);
  device.setSaturation(100);
  await settle(420);

  const sent = bridge.published.slice(before);
  assert.strictEqual(sent.length, 1, `one command for one colour pick, got ${sent.length}`);
  assert.deepStrictEqual(sent[0].color, { r: 128, g: 0, b: 255 }, 'full-value purple, not dimmed to (22,0,43)');
  assert.strictEqual(sent[0].brightness, 17, 'the level travels in its own field');
});

/** A gesture that changes colour and brightness together is one command. */
test('colour and brightness in one gesture become one command', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);

  device.setOn(true, 'lightbulb');
  await settle(420);
  const before = bridge.published.length;

  device.setHue(120);
  device.setSaturation(100);
  device.setBrightness(45);
  await settle(420);

  const sent = bridge.published.slice(before);
  assert.strictEqual(sent.length, 1, `expected one command, got ${sent.length}`);
  assert.deepStrictEqual(sent[0], { state: 'ON', color: { r: 0, g: 255, b: 0 }, brightness: 45 });
});

test('a drag that ends where it began does not cancel a running effect', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);

  const night = device.identifierForName('Night');
  device.setEffectIndex(night);
  const before = bridge.published.length;

  // Dragged down and back up: the intermediate values are not a change.
  device.setBrightness(40);
  device.setBrightness(10);
  device.setBrightness(100);
  await settle(420);

  assert.strictEqual(device.getState().mode, 'effect', 'the effect must survive a round-trip drag');
  assert.strictEqual(device.getState().effectIndex, night);
  assert.deepStrictEqual(bridge.published.slice(before), [], 'and nothing should have been sent');
});

test('a real brightness change still exits effect mode, once', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);

  device.setEffectIndex(device.identifierForName('Night'));
  const before = bridge.published.length;

  device.setBrightness(80);
  device.setBrightness(60);
  device.setBrightness(42);
  await settle(420);

  assert.strictEqual(device.getState().mode, 'adaptive', 'a real change backs out of the effect');
  const sent = bridge.published.slice(before);
  assert.strictEqual(sent.length, 1, `expected one command, got ${sent.length}`);
  assert.strictEqual(sent[0].brightness, 42, 'and it carries the value the finger settled on');
});

const DISCOVERY_TOPIC = `homeassistant/light/gv2mqtt-${DEVICE_ID}/config`;

function announceEffects(bridge, names) {
  bridge.emit('message', DISCOVERY_TOPIC, Buffer.from(JSON.stringify({ effect_list: names })));
}

/**
 * The point of the accessory-cache catalog: a run that starts already
 * knowing the real effect list must not rebuild anything when gv2mqtt
 * announces that same list ~17s later. A rebuild is what changes the
 * bridge's configuration and makes HomeKit re-read every service - measured
 * at three configuration-number increments per restart before this.
 */
test('a restored catalog makes the next discovery a no-op', async (t) => {
  const first = new MockBridge();
  t.after(() => first.stop());
  const device = new GoveeDevice(first, deviceConfig(), 10000, silentLog);

  const real = ['Night', 'Sunrise', 'Aurora'];
  announceEffects(first, real);
  assert.ok(device.effectsDiscovered, 'the first run discovers the list');
  const catalog = device.effectCatalog();

  // Next restart: the catalog comes back before anything is built from it.
  const second = new MockBridge();
  t.after(() => second.stop());
  const restarted = new GoveeDevice(second, deviceConfig(), 10000, silentLog);
  restarted.restoreEffectCatalog(catalog.effectNames, catalog.identifiers);

  let changes = 0;
  restarted.on('change', () => { changes += 1; });
  announceEffects(second, real);

  assert.strictEqual(changes, 0, 'an unchanged list must not announce a rebuild');
  assert.deepStrictEqual(restarted.effectCatalog(), catalog, 'and the numbering is byte-for-byte the one Home knows');
});

/**
 * Identifiers are Home's key into its own input cache, so a restored catalog
 * must keep every number it had; only genuinely new effects get new ones.
 */
test('a restored catalog keeps its numbering when the list grows', async (t) => {
  const first = new MockBridge();
  t.after(() => first.stop());
  const device = new GoveeDevice(first, deviceConfig(), 10000, silentLog);
  announceEffects(first, ['Night', 'Sunrise']);
  const catalog = device.effectCatalog();
  const nightId = catalog.identifiers.Night;
  const sunriseId = catalog.identifiers.Sunrise;

  const second = new MockBridge();
  t.after(() => second.stop());
  const restarted = new GoveeDevice(second, deviceConfig(), 10000, silentLog);
  restarted.restoreEffectCatalog(catalog.effectNames, catalog.identifiers);

  let changes = 0;
  restarted.on('change', () => { changes += 1; });
  announceEffects(second, ['Night', 'Sunrise', 'Brand New DIY']);

  assert.strictEqual(changes, 1, 'a genuinely changed list does rebuild');
  const after = restarted.effectCatalog();
  assert.strictEqual(after.identifiers.Night, nightId, 'existing identifiers must not move');
  assert.strictEqual(after.identifiers.Sunrise, sunriseId);
  const newId = after.identifiers['Brand New DIY'];
  assert.ok(newId > 0 && newId !== nightId && newId !== sunriseId, `new effect got a colliding id: ${newId}`);
});

/** A catalog with a gap (an effect Govee has since dropped) must not collide. */
test('a gappy restored catalog still hands out unused identifiers', async (t) => {
  const bridge = new MockBridge();
  t.after(() => bridge.stop());
  const device = new GoveeDevice(bridge, deviceConfig(), 10000, silentLog);

  // Identifier 2 is missing - "Normal Light" is 1, the survivor is 7.
  device.restoreEffectCatalog(['Normal Light', 'Survivor'], { 'Normal Light': 1, Survivor: 7 });

  const fresh = device.identifierForName('Newcomer');
  assert.strictEqual(fresh, 8, `expected one past the highest in use, got ${fresh}`);
  assert.strictEqual(device.nameForIdentifier(7), 'Survivor', 'the survivor keeps its number');
});
