import { EventEmitter } from 'events';
import { Logger } from 'homebridge';
import { MqttClient } from 'mqtt';
import { ResolvedDeviceConfig } from './config';
import { EFFECT_NAMES, effectIndexByName } from './effects';
import { hueSatToRgb, rgbToHueSat } from './color';

export type GoveeColorMode = 'adaptive' | 'rgb' | 'effect';

export interface GoveeDeviceState {
  isOn: boolean;
  brightness: number;
  mireds: number;
  hue: number;
  saturation: number;
  mode: GoveeColorMode;
  /** 1-based; matches the television accessory's Input identifiers. 1 = no effect. */
  effectIndex: number;
}

interface IncomingMessage {
  state?: string;
  brightness?: number;
  color_temp?: number;
  color?: { r: number; g: number; b: number };
  color_mode?: string;
  effect?: string;
}

const DEFAULT_STATE: GoveeDeviceState = {
  isOn: false,
  brightness: 100,
  mireds: 250,
  hue: 0,
  saturation: 0,
  mode: 'adaptive',
  effectIndex: 1,
};

/**
 * Owns the cached state for one physical Govee light and talks to it over the
 * shared MQTT connection. Replaces the `global.govee` object that the original
 * mqttthing config used to share state between its two accessories.
 */
export class GoveeDevice extends EventEmitter {
  private state: GoveeDeviceState = { ...DEFAULT_STATE };
  private lastLocalSetAt = 0;
  private pendingHueSat: { hue?: number; saturation?: number } | null = null;
  private hueSatFlushTimer?: NodeJS.Timeout;

  constructor(
    private readonly client: MqttClient,
    public readonly config: ResolvedDeviceConfig,
    private readonly optimisticCacheMs: number,
    private readonly log: Logger,
  ) {
    super();

    this.client.subscribe(config.stateTopic, (err) => {
      if (err) {
        this.log.error(`[${config.name}] failed to subscribe to ${config.stateTopic}: ${err.message}`);
      }
    });
    this.client.on('message', (topic, payload) => {
      if (topic === config.stateTopic) {
        this.handleMessage(payload.toString());
      }
    });

    if (config.turnOffOnStartup) {
      setTimeout(() => this.publish({ state: 'OFF' }), config.turnOffOnStartupDelayMs);
    }
  }

  getState(): GoveeDeviceState {
    return { ...this.state };
  }

  private withinOptimisticWindow(): boolean {
    return Date.now() - this.lastLocalSetAt < this.optimisticCacheMs;
  }

  private publish(payload: Record<string, unknown>): void {
    this.client.publish(this.config.commandTopic, JSON.stringify(payload));
  }

  private markLocalChange(): void {
    this.lastLocalSetAt = Date.now();
  }

  private handleMessage(payload: string): void {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(payload);
    } catch {
      this.log.warn(`[${this.config.name}] ignoring unparseable MQTT payload: ${payload}`);
      return;
    }

    this.state.isOn = msg.state === 'ON';
    if (!this.state.isOn) {
      this.state.mode = 'adaptive';
      this.state.effectIndex = 1;
    }

    if (this.state.isOn && !this.withinOptimisticWindow()) {
      if (msg.effect) {
        this.state.mode = 'effect';
        this.state.effectIndex = effectIndexByName(msg.effect, this.state.effectIndex);
      } else {
        this.state.mode = msg.color_mode === 'rgb' ? 'rgb' : 'adaptive';
        this.state.effectIndex = 1;
        if (typeof msg.color_temp === 'number') {
          this.state.mireds = msg.color_temp;
        }
        if (msg.color_mode === 'rgb' && msg.color) {
          const hs = rgbToHueSat(msg.color.r, msg.color.g, msg.color.b);
          this.state.hue = hs.hue;
          this.state.saturation = hs.saturation;
        }
      }
      if (typeof msg.brightness === 'number') {
        this.state.brightness = msg.brightness;
      }
    }

    this.emit('change', this.getState());
  }

  setOn(on: boolean): void {
    this.markLocalChange();
    this.state.isOn = on;
    this.state.mode = 'adaptive';
    this.state.effectIndex = 1;
    if (on) {
      this.publish({ state: 'ON', color_temp: this.state.mireds, brightness: this.state.brightness });
    } else {
      this.publish({ state: 'OFF' });
    }
    this.emit('change', this.getState());
  }

  setBrightness(brightness: number): void {
    this.markLocalChange();
    this.state.brightness = Math.round(brightness);
    if (!this.state.isOn) {
      return;
    }
    if (this.state.mode === 'effect') {
      this.state.mode = 'adaptive';
      this.state.effectIndex = 1;
      this.publish({ state: 'ON', color_temp: this.state.mireds, brightness: this.state.brightness });
    } else {
      this.publish({ state: 'ON', brightness: this.state.brightness });
    }
    this.emit('change', this.getState());
  }

  setColorTemperature(mireds: number): void {
    this.markLocalChange();
    this.state.mireds = Math.round(mireds);
    if (!this.state.isOn || this.state.mode === 'effect') {
      return;
    }
    this.state.mode = 'adaptive';
    this.publish({ state: 'ON', color_temp: this.state.mireds, brightness: this.state.brightness });
    this.emit('change', this.getState());
  }

  setHue(hue: number): void {
    this.queueHueSat({ hue });
  }

  setSaturation(saturation: number): void {
    this.queueHueSat({ saturation });
  }

  private queueHueSat(partial: { hue?: number; saturation?: number }): void {
    this.pendingHueSat = { ...this.pendingHueSat, ...partial };
    if (this.hueSatFlushTimer) {
      clearTimeout(this.hueSatFlushTimer);
    }
    // Home sends Hue and Saturation as two separate characteristic writes when
    // dragging the color wheel; coalesce them into a single command instead of
    // publishing (and deciding color-vs-white) twice.
    this.hueSatFlushTimer = setTimeout(() => this.flushHueSat(), 50);
  }

  private flushHueSat(): void {
    if (!this.pendingHueSat) {
      return;
    }
    const hue = this.pendingHueSat.hue ?? this.state.hue;
    const saturation = this.pendingHueSat.saturation ?? this.state.saturation;
    this.pendingHueSat = null;

    this.markLocalChange();
    this.state.hue = hue;
    this.state.saturation = saturation;

    const { r, g, b } = hueSatToRgb(hue, saturation, this.state.brightness);
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    const bri = Math.round((mx / 255) * 100) || 1;
    this.state.brightness = bri;

    if (sat < this.config.colorSaturationThreshold) {
      // Low saturation: Home's color wheel was used to pick a "white", so send
      // it to the device as a color-temperature command instead of RGB.
      const ratio = r > 0 ? b / r : 0.5;
      const mireds = Math.round(
        Math.max(this.config.minMireds, Math.min(this.config.maxMireds, 500 - ratio * 390)),
      );
      this.state.mireds = mireds;
      if (this.state.isOn && this.state.mode !== 'effect') {
        this.state.mode = 'adaptive';
        this.publish({ state: 'ON', color_temp: mireds, brightness: bri });
      }
    } else {
      if (this.state.isOn) {
        this.state.mode = 'rgb';
        this.publish({ state: 'ON', color: { r, g, b }, brightness: bri });
      }
    }
    this.emit('change', this.getState());
  }

  setEffectIndex(index: number): void {
    this.markLocalChange();
    if (index <= 1) {
      this.state.effectIndex = 1;
      this.state.mode = 'adaptive';
      this.publish({ state: 'ON', color_temp: this.state.mireds, brightness: this.state.brightness });
    } else {
      this.state.effectIndex = index;
      this.state.mode = 'effect';
      this.publish({ state: 'ON', effect: EFFECT_NAMES[index - 1] });
    }
    this.emit('change', this.getState());
  }
}

export interface GoveeDevice {
  on(event: 'change', listener: (state: GoveeDeviceState) => void): this;
  emit(event: 'change', state: GoveeDeviceState): boolean;
}
