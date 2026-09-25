import { Logger, PlatformAccessory, Service } from 'homebridge';
import { MqttClient } from 'mqtt';
import type { GoveeGv2MqttPlatform } from './platform';
import { ResolvedDeviceConfig } from './config';
import { hueSatToRgb, RGB, rgbToHueSat } from './color';

/**
 * The Manual work mode's mist levels. Govee's Platform API lists Manual
 * modeValue 1-9 for the H7140, and all nine were checked on the device on
 * 2026-09-24 - the mist visibly grows level by level.
 */
const MIN_LEVEL = 1;
const MAX_LEVEL = 9;

/** Fixed window that gathers a slider drag or a scene's batch into one command. */
const COALESCE_MS = 350;

/**
 * gv2mqtt only polls after a command Govee accepted; one rejected ("Device is
 * offline") leaves no report at all. So after every command the plugin asks
 * for a fresh poll itself, this long after the echo window has closed, so the
 * answer can't be mistaken for (or masked as) the command's own echo.
 */
const VERIFY_AFTER_ECHO_MS = 1000;

/** Govee takes the power command first; the level follows once it is on. */
const LEVEL_AFTER_POWER_MS = 1000;

/** HomeKit speed for a level: the top of its band, rounded down so it maps back to the same level. */
export function levelToPercent(level: number): number {
  return Math.floor((level * 100) / MAX_LEVEL);
}

/** HomeKit speed to a level. 0 is not "off" here - power is the switch's job - so it is the lowest level. */
export function percentToLevel(percent: number): number {
  return Math.min(Math.max(Math.ceil((percent * MAX_LEVEL) / 100), MIN_LEVEL), MAX_LEVEL);
}

function sameColor(a: RGB, b: RGB): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/**
 * A Govee humidifier through gv2mqtt, as one accessory with two services:
 *
 * - HumidifierDehumidifier: power only on its main control. The mist level is
 *   its RotationSpeed, which the Home app shows in the accessory's settings;
 *   it can be set while the device is off and is sent when it comes on.
 *   CurrentRelativeHumidity is mandatory for the service, but the device has
 *   no sensor, so it stays 0.
 * - Lightbulb: the night light, on/off, colour and brightness. No colour
 *   temperature - the device has none.
 *
 * Topics are gv2mqtt's (wez/govee2mqtt src/service/hass.rs, hass_mqtt/*).
 * gv2mqtt drives this device over Govee's cloud API and learns the result by
 * polling a few seconds later, so a report that predates a command can arrive
 * after it: for `echoWindowMs` after a command - the lamps' window - a report
 * on that property is believed only if it agrees. Just after that window the
 * plugin asks gv2mqtt for a fresh poll, so what HomeKit shows ends up being
 * what the device does even when a command was rejected. While Govee reports
 * the device offline, HomeKit shows it as not responding.
 *
 * An empty tank needs nothing from the plugin: the device switches itself
 * off, and that "off" reaches HomeKit like any other report.
 */
export class GoveeHumidifier {
  private humidifier?: Service;
  private light?: Service;

  private isOn = false;
  /** The level HomeKit wants; sent whenever the device is on. */
  private level = MIN_LEVEL;
  /** Whether the night light is lit - what HomeKit shows. */
  private lightOn = false;
  /**
   * Whether it is switched on, lit or not. Measured on the device on
   * 2026-09-24: switching the device off puts the light out too, and switching
   * it on brings the light back as it was, colour and brightness included.
   */
  private lightEnabled = false;
  /** Govee's own view of whether the device is reachable, from gv2mqtt's status sensor. */
  private online = true;
  /** What the device's light last had, sent or reported; only changes are sent. */
  private deviceBrightness: number | null = null;
  private deviceColor: RGB | null = null;
  private brightness = 100;
  private hue = 0;
  private saturation = 100;

  private levelTimer?: NodeJS.Timeout;
  private lightTimer?: NodeJS.Timeout;
  private verifyTimer?: NodeJS.Timeout;

  private readonly commanded = new Map<string, { value: unknown; at: number }>();

  private readonly topics: {
    powerState: string;
    powerCommand: string;
    levelState: string;
    levelCommand: string;
    lightToggleState: string;
    lightToggleCommand: string;
    lightState: string;
    lightCommand: string;
    status: string;
    requestState: string;
  };

  constructor(
    private readonly platform: GoveeGv2MqttPlatform,
    private readonly client: MqttClient,
    private readonly config: ResolvedDeviceConfig,
    /**
     * The platform's optimisticCacheMs, the same window the lamps use: for
     * this long after a command, a report on that property is believed only
     * if it agrees. gv2mqtt learns a cloud-driven device's state by polling
     * seconds later, and Govee can still answer with the old state then.
     */
    private readonly echoWindowMs: number,
    private readonly log: Logger,
  ) {
    const id = config.deviceId;
    this.topics = {
      powerState: `gv2mqtt/humidifier/${id}/state`,
      powerCommand: `gv2mqtt/switch/${id}/command/powerSwitch`,
      levelState: `gv2mqtt/number/${id}/state/manual`,
      // "1" is the Manual work mode's value in this device's capabilities.
      levelCommand: `gv2mqtt/number/${id}/command/manual/1`,
      lightToggleState: `gv2mqtt/switch/${id}/nightlightToggle/state`,
      lightToggleCommand: `gv2mqtt/switch/${id}/command/nightlightToggle`,
      lightState: `gv2mqtt/light/${id}/state`,
      lightCommand: `gv2mqtt/light/${id}/command`,
      // gv2mqtt's status sensor; its attributes carry Govee's "online" flag.
      status: `gv2mqtt/sensor/sensor-${id}-gv2mqtt-status/attributes`,
      // gv2mqtt's "Request Platform API State" button: poll now and publish.
      requestState: `gv2mqtt/${id}/request-platform-data`,
    };

    const t = this.topics;
    for (const topic of [t.powerState, t.levelState, t.lightToggleState, t.lightState, t.status]) {
      this.client.subscribe(topic, (err) => {
        if (err) {
          this.log.error(`[${this.name}] failed to subscribe to ${topic}: ${err.message}`);
        }
      });
    }
    this.client.on('message', (topic, payload) => this.onMessage(topic, payload.toString()));
  }

  get name(): string {
    return this.config.name;
  }

  get deviceId(): string {
    return this.config.deviceId;
  }

  /** Builds the accessory's services; called again if the accessory is re-created. */
  attach(accessory: PlatformAccessory): void {
    const { Service: Svc, Characteristic: C } = this.platform;

    accessory
      .getService(Svc.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Govee')
      .setCharacteristic(C.Model, 'gv2mqtt Humidifier')
      .setCharacteristic(C.SerialNumber, this.deviceId);

    const named = (service: Service, name: string) => {
      service.setCharacteristic(C.Name, name);
      if (!service.testCharacteristic(C.ConfiguredName)) {
        service.addOptionalCharacteristic(C.ConfiguredName);
        service.setCharacteristic(C.ConfiguredName, name);
      }
      return service;
    };

    const humidifier = named(
      accessory.getService(Svc.HumidifierDehumidifier) ?? accessory.addService(Svc.HumidifierDehumidifier, this.name),
      this.name,
    );
    humidifier.setPrimaryService(true);
    const light = named(
      accessory.getService(Svc.Lightbulb) ?? accessory.addService(Svc.Lightbulb, `${this.name} Night Light`),
      `${this.name} Night Light`,
    );
    this.humidifier = humidifier;
    this.light = light;

    // While Govee reports the device offline, reads and writes fail so Home
    // shows "No Response" instead of a state the device may not be in.
    const read = <T>(value: () => T) => () => {
      this.assertOnline();
      return value();
    };
    const write = (apply: (value: unknown) => void) => (value: unknown) => {
      this.assertOnline();
      apply(value);
    };

    const { INACTIVE, HUMIDIFYING } = C.CurrentHumidifierDehumidifierState;
    const { HUMIDIFIER } = C.TargetHumidifierDehumidifierState;

    humidifier
      .getCharacteristic(C.Active)
      .onGet(read(() => (this.isOn ? 1 : 0)))
      .onSet(write((value) => this.setOn(value === 1)));
    humidifier
      .getCharacteristic(C.CurrentHumidifierDehumidifierState)
      .onGet(read(() => (this.isOn ? HUMIDIFYING : INACTIVE)));
    humidifier
      .getCharacteristic(C.TargetHumidifierDehumidifierState)
      .updateValue(HUMIDIFIER)
      .setProps({ validValues: [HUMIDIFIER] })
      .onGet(() => HUMIDIFIER)
      .onSet(() => undefined);
    humidifier.getCharacteristic(C.CurrentRelativeHumidity).onGet(() => 0);
    humidifier
      .getCharacteristic(C.RotationSpeed)
      .onGet(read(() => levelToPercent(this.level)))
      .onSet(write((value) => this.setSpeed(value as number)));

    light
      .getCharacteristic(C.On)
      .onGet(read(() => this.lightOn))
      .onSet(write((value) => this.setLightOn(value as boolean)));
    light
      .getCharacteristic(C.Brightness)
      .onGet(read(() => this.brightness))
      .onSet(write((value) => this.setLightAppearance({ brightness: value as number })));
    light
      .getCharacteristic(C.Hue)
      .onGet(read(() => this.hue))
      .onSet(write((value) => this.setLightAppearance({ hue: value as number })));
    light
      .getCharacteristic(C.Saturation)
      .onGet(read(() => this.saturation))
      .onSet(write((value) => this.setLightAppearance({ saturation: value as number })));
  }

  // ---- HomeKit writes ----------------------------------------------------

  setOn(on: boolean): void {
    const pending = this.recent('on');
    if (pending && pending.value === on) {
      // Home repeats writes in bursts; one command per change is enough. Not
      // deduplicated beyond that: if our idea of the power is stale, an
      // automation's "on" must still get through.
      return;
    }
    this.isOn = on;
    this.command('on', on);
    this.send(this.topics.powerCommand, on ? 'ON' : 'OFF');
    this.lightFollowsPower();
    if (on) {
      // The level chosen while it was off, or simply the current one: sent
      // every time, so what HomeKit shows is what the device does. Claimed
      // now, so a report of the old level arriving first can't replace it.
      this.command('level', this.level);
      clearTimeout(this.levelTimer);
      this.levelTimer = setTimeout(() => this.sendLevel(), LEVEL_AFTER_POWER_MS);
    }
    this.pushHumidifier();
  }

  /** The device puts its light out when switched off and brings it back as it was when switched on. */
  private lightFollowsPower(): void {
    const lit = this.isOn ? this.lightEnabled : false;
    if (lit !== this.lightOn) {
      this.lightOn = lit;
      this.pushLight();
    }
  }

  setSpeed(percent: number): void {
    this.level = percentToLevel(percent);
    // Snap the slider onto the level's own position.
    setImmediate(() => this.humidifier?.updateCharacteristic(this.platform.Characteristic.RotationSpeed, levelToPercent(this.level)));
    if (!this.isOn) {
      return; // kept for the next power-on
    }
    this.command('level', this.level);
    if (!this.levelTimer) {
      this.levelTimer = setTimeout(() => this.sendLevel(), COALESCE_MS);
    }
  }

  private sendLevel(): void {
    this.levelTimer = undefined;
    if (!this.isOn) {
      return;
    }
    this.command('level', this.level);
    this.send(this.topics.levelCommand, String(this.level));
  }

  setLightOn(on: boolean): void {
    this.lightOn = on;
    this.lightEnabled = on;
    this.command('lightOn', on);
    this.send(this.topics.lightToggleCommand, on ? 'ON' : 'OFF');
    if (on) {
      // Colour and brightness follow in the same window, so a scene's values
      // written alongside this On go out in one command.
      this.scheduleLightAppearance();
    }
  }

  setLightAppearance(patch: { brightness?: number; hue?: number; saturation?: number }): void {
    if (patch.brightness !== undefined) {
      this.brightness = patch.brightness;
    }
    if (patch.hue !== undefined) {
      this.hue = patch.hue;
    }
    if (patch.saturation !== undefined) {
      this.saturation = patch.saturation;
    }
    if (this.lightOn) {
      this.scheduleLightAppearance();
    }
  }

  private scheduleLightAppearance(): void {
    if (!this.lightTimer) {
      this.lightTimer = setTimeout(() => {
        this.lightTimer = undefined;
        if (this.lightOn) {
          this.sendLightAppearance(this.brightness, this.currentRgb());
        }
      }, COALESCE_MS);
    }
  }

  /** Colour at full value; the level travels in brightness, which the device keeps separately. */
  private currentRgb(): RGB {
    return hueSatToRgb(this.hue, this.saturation, 100);
  }

  /**
   * Sends only what differs from what the device has: each field is a separate
   * Govee cloud call. Never a bare {"state":"ON"} - for a device that is not a
   * light gv2mqtt turns that into brightness 100.
   */
  private sendLightAppearance(requested: number, color: RGB): void {
    // gv2mqtt turns brightness 0 into "off" for a device that is not a light;
    // off is the On switch's job.
    const brightness = Math.max(1, Math.round(requested));
    const payload: { state: 'ON'; brightness?: number; color?: RGB } = { state: 'ON' };
    if (brightness !== this.deviceBrightness) {
      payload.brightness = brightness;
      this.command('brightness', brightness);
    }
    if (!this.deviceColor || !sameColor(color, this.deviceColor)) {
      payload.color = color;
      this.command('color', color);
    }
    if (payload.brightness === undefined && payload.color === undefined) {
      return;
    }
    this.deviceBrightness = brightness;
    this.deviceColor = color;
    this.send(this.topics.lightCommand, JSON.stringify(payload));
  }

  // ---- Reports from gv2mqtt ----------------------------------------------

  private onMessage(topic: string, text: string): void {
    const t = this.topics;
    if (topic === t.status) {
      this.onStatusReport(text);
      return;
    }
    if (topic === t.powerState || topic === t.levelState || topic === t.lightToggleState || topic === t.lightState) {
      this.log.debug(`[${this.name}] report ${topic} = ${text}`);
    }
    if (topic === t.powerState) {
      this.onPowerReport(text.trim().toUpperCase() === 'ON');
    } else if (topic === t.levelState) {
      if (!this.isOn) {
        return; // while off, the level is whatever HomeKit last chose, for the next power-on
      }
      const level = Number(text.trim());
      if (Number.isInteger(level) && level >= MIN_LEVEL && level <= MAX_LEVEL && this.accepts('level', level)) {
        if (level !== this.level) {
          this.level = level;
          this.pushHumidifier();
        }
      }
    } else if (topic === t.lightToggleState) {
      const on = text.trim().toUpperCase() === 'ON';
      if (!this.accepts('lightOn', on)) {
        return;
      }
      // Off while the device is off says nothing about whether the light comes
      // back with it; anything else is the light's own switch.
      if (on || this.isOn) {
        this.lightEnabled = on;
      }
      if (on !== this.lightOn) {
        this.lightOn = on;
        this.pushLight();
      }
    } else if (topic === t.lightState) {
      this.onLightReport(text);
    }
  }

  private onPowerReport(on: boolean): void {
    if (on !== this.isOn && this.accepts('on', on)) {
      this.isOn = on;
      this.pushHumidifier();
      this.lightFollowsPower();
    }
  }

  private onStatusReport(text: string): void {
    let online: unknown;
    try {
      online = JSON.parse(text)?.overall?.online;
    } catch {
      return;
    }
    if (typeof online !== 'boolean' || online === this.online) {
      return;
    }
    this.online = online;
    if (online) {
      this.log.info(`[${this.name}] Govee reports the device online again`);
      this.pushHumidifier();
      this.pushLight();
    } else {
      this.log.warn(`[${this.name}] Govee reports the device offline; showing it as not responding`);
      const C = this.platform.Characteristic;
      const error = this.communicationFailure();
      for (const c of [C.Active, C.CurrentHumidifierDehumidifierState, C.RotationSpeed]) {
        this.humidifier?.updateCharacteristic(c, error);
      }
      for (const c of [C.On, C.Brightness, C.Hue, C.Saturation]) {
        this.light?.updateCharacteristic(c, error);
      }
    }
  }

  private onLightReport(text: string): void {
    let msg: { brightness?: unknown; color?: { r?: unknown; g?: unknown; b?: unknown } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    let changed = false;
    if (typeof msg.brightness === 'number' && msg.brightness >= 1 && msg.brightness <= 100) {
      if (this.accepts('brightness', msg.brightness)) {
        this.deviceBrightness = msg.brightness;
        if (msg.brightness !== this.brightness) {
          this.brightness = msg.brightness;
          changed = true;
        }
      }
    }
    const c = msg.color;
    if (c && typeof c.r === 'number' && typeof c.g === 'number' && typeof c.b === 'number') {
      const color = { r: c.r, g: c.g, b: c.b };
      if (this.accepts('color', color)) {
        this.deviceColor = color;
        const { hue, saturation } = rgbToHueSat(color.r, color.g, color.b);
        const current = this.currentRgb();
        if (current.r !== color.r || current.g !== color.g || current.b !== color.b) {
          this.hue = hue;
          this.saturation = saturation;
          changed = true;
        }
      }
    }
    if (changed) {
      this.pushLight();
    }
  }

  // ---- Helpers -----------------------------------------------------------

  private send(topic: string, payload: string): void {
    this.client.publish(topic, payload);
    clearTimeout(this.verifyTimer);
    this.verifyTimer = setTimeout(() => {
      this.verifyTimer = undefined;
      this.client.publish(this.topics.requestState, 'PRESS');
    }, this.echoWindowMs + VERIFY_AFTER_ECHO_MS);
  }

  private communicationFailure(): Error {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private assertOnline(): void {
    if (!this.online) {
      throw this.communicationFailure();
    }
  }

  private command(prop: string, value: unknown): void {
    this.commanded.set(prop, { value, at: Date.now() });
  }

  private recent(prop: string): { value: unknown } | undefined {
    const cmd = this.commanded.get(prop);
    if (cmd && Date.now() - cmd.at > this.echoWindowMs) {
      this.commanded.delete(prop);
      return undefined;
    }
    return cmd;
  }

  private accepts(prop: string, value: unknown): boolean {
    const cmd = this.recent(prop);
    return !cmd || JSON.stringify(cmd.value) === JSON.stringify(value);
  }

  private pushHumidifier(): void {
    const C = this.platform.Characteristic;
    const s = this.humidifier;
    if (!s) {
      return;
    }
    s.updateCharacteristic(C.Active, this.isOn ? 1 : 0);
    s.updateCharacteristic(
      C.CurrentHumidifierDehumidifierState,
      this.isOn ? C.CurrentHumidifierDehumidifierState.HUMIDIFYING : C.CurrentHumidifierDehumidifierState.INACTIVE,
    );
    s.updateCharacteristic(C.RotationSpeed, levelToPercent(this.level));
  }

  private pushLight(): void {
    const C = this.platform.Characteristic;
    const s = this.light;
    if (!s) {
      return;
    }
    s.updateCharacteristic(C.On, this.lightOn);
    s.updateCharacteristic(C.Brightness, this.brightness);
    s.updateCharacteristic(C.Hue, this.hue);
    s.updateCharacteristic(C.Saturation, this.saturation);
  }
}
