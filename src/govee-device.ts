import { EventEmitter } from 'events';
import { Logger } from 'homebridge';
import { MqttClient } from 'mqtt';
import { ResolvedDeviceConfig } from './config';
import { buildEffectNames, NORMAL_LIGHT } from './effects';
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
  /** Index 0 is always "Normal Light"; see buildEffectNames. */
  effectNames: string[];
  /** Whether triggerAlert() has been called without a matching restoreSnapshot() yet. */
  alertActive: boolean;
}

interface StateSnapshot {
  isOn: boolean;
  mode: GoveeColorMode;
  mireds: number;
  hue: number;
  saturation: number;
  brightness: number;
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

interface DiscoveryConfigMessage {
  effect_list?: unknown;
}

/**
 * How long to sit on an Adaptive Lighting color-temperature nudge before
 * actually publishing it. AL's nudges arrive on a fixed schedule regardless
 * of the light's real power state (HAP-NodeJS keeps calling the SET handler
 * even while the light is off), so when the light gets switched off by its
 * physical button, a nudge can fire inside the few seconds it takes the
 * "off" report to travel Govee's cloud -> gv2mqtt -> us, while our cached
 * isOn is still stale-true - and gv2mqtt maps the resulting command onto
 * Govee API calls that power the lamp back on. AL drifts a few mireds a
 * minute, so delaying a nudge is invisible; it gives the "off" report time
 * to land first, at which point the re-check below drops the nudge.
 */
const AL_PUBLISH_DELAY_MS = 5000;

/**
 * Backstop for the race AL_PUBLISH_DELAY_MS narrows but can't close (an
 * "off" report that takes longer than the delay to arrive): if the device
 * reports "off" within this window after we published an AL nudge, the
 * nudge probably raced a physical power-off and woke the lamp back up, so
 * re-assert the off.
 */
const AL_OFF_REASSERT_WINDOW_MS = 20000;

const DEFAULT_STATE: GoveeDeviceState = {
  isOn: false,
  brightness: 100,
  mireds: 250,
  hue: 0,
  saturation: 0,
  mode: 'adaptive',
  effectIndex: 1,
  effectNames: buildEffectNames(null),
  alertActive: false,
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
  private effectReassertTimer?: NodeJS.Timeout;
  private alPublishTimer?: NodeJS.Timeout;
  private lastAlCommandAt = 0;
  private snapshot: StateSnapshot | null = null;

  /**
   * Stable name<->identifier mapping, shared by this device's own effectIndex
   * bookkeeping and by EffectsAccessory's InputSource Identifier values, so
   * both agree on what a given number means. An identifier is assigned once,
   * the first time its name is seen, and never reassigned - Govee's API
   * doesn't guarantee effect_list order stays the same between discovery
   * refreshes, and reassigning identifiers by array position on every
   * refresh let the same number silently point at a different effect,
   * desyncing Home's own Input cache (entries could vanish from its UI even
   * though the underlying InputSource services were all present and
   * correct).
   */
  private readonly identifierByName = new Map<string, number>();
  private readonly nameByIdentifier = new Map<number, string>();

  constructor(
    private readonly client: MqttClient,
    public readonly config: ResolvedDeviceConfig,
    private readonly optimisticCacheMs: number,
    private readonly log: Logger,
  ) {
    super();

    this.identifierForName(NORMAL_LIGHT); // guarantee it's always identifier 1

    this.client.subscribe(config.stateTopic, (err) => {
      if (err) {
        this.log.error(`[${config.name}] failed to subscribe to ${config.stateTopic}: ${err.message}`);
      }
    });
    this.client.subscribe(config.discoveryConfigTopic, (err) => {
      if (err) {
        this.log.warn(
          `[${config.name}] failed to subscribe to ${config.discoveryConfigTopic}: ${err.message}` +
            ' (real per-device effect list will be unavailable; falling back to the built-in list)',
        );
      }
    });
    this.client.on('message', (topic, payload) => {
      if (topic === config.stateTopic) {
        this.handleMessage(payload.toString());
      } else if (topic === config.discoveryConfigTopic) {
        this.handleDiscoveryConfig(payload.toString());
      }
    });

    if (config.turnOffOnStartup) {
      setTimeout(() => this.publish({ state: 'OFF' }), config.turnOffOnStartupDelayMs);
    }
  }

  getState(): GoveeDeviceState {
    return { ...this.state };
  }

  /** Looks up (assigning on first use) the stable 1-based identifier for an effect name. */
  identifierForName(name: string): number {
    let id = this.identifierByName.get(name);
    if (id === undefined) {
      id = this.identifierByName.size + 1;
      this.identifierByName.set(name, id);
      this.nameByIdentifier.set(id, name);
    }
    return id;
  }

  /** Reverse of identifierForName; undefined if that identifier hasn't been assigned yet. */
  nameForIdentifier(id: number): string | undefined {
    return this.nameByIdentifier.get(id);
  }

  private withinOptimisticWindow(): boolean {
    return Date.now() - this.lastLocalSetAt < this.optimisticCacheMs;
  }

  private publish(payload: Record<string, unknown>): void {
    this.log.debug(`[${this.config.name}] Publishing MQTT: ${this.config.commandTopic} = ${JSON.stringify(payload)}`);
    this.client.publish(this.config.commandTopic, JSON.stringify(payload));
  }

  private markLocalChange(): void {
    this.lastLocalSetAt = Date.now();
  }

  private handleMessage(payload: string): void {
    this.log.debug(`[${this.config.name}] Received MQTT: ${this.config.stateTopic} = ${payload}`);
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(payload);
    } catch {
      this.log.warn(`[${this.config.name}] ignoring unparseable MQTT payload: ${payload}`);
      return;
    }

    this.state.isOn = msg.state === 'ON';
    if (!this.state.isOn && Date.now() - this.lastAlCommandAt < AL_OFF_REASSERT_WINDOW_MS) {
      // The device reports "off" moments after we published an Adaptive
      // Lighting nudge - almost certainly the light was just powered off
      // physically (its button) and our automatic nudge raced that through
      // Govee's cloud. gv2mqtt maps a color-temperature command onto Govee
      // API calls that wake the lamp back up, so re-assert the off the user
      // asked for with the button. Never triggered by deliberate HomeKit
      // changes - lastAlCommandAt is only ever set by AL's background nudges.
      this.lastAlCommandAt = 0;
      this.log.debug(
        `[${this.config.name}] Device reported OFF right after an Adaptive Lighting nudge; ` +
          're-asserting OFF in case the nudge woke it back up',
      );
      this.publish({ state: 'OFF' });
    }
    if (!this.state.isOn && !this.withinOptimisticWindow()) {
      // Only trust an "off" report enough to reset mode/effect bookkeeping
      // once we're past the optimistic window. gv2mqtt/Govee's cloud can
      // report a spurious/transient "off" a moment after we've just
      // published an "on with effect" command (seemingly an eventual-
      // consistency race server-side, not anything this plugin published) -
      // still reflect isOn honestly either way, but don't let a blip like
      // that wipe out an effect selection that was just made.
      this.state.mode = 'adaptive';
      this.state.effectIndex = 1;
    }

    if (this.state.isOn && !this.withinOptimisticWindow()) {
      if (msg.effect) {
        this.state.mode = 'effect';
        this.state.effectIndex = this.identifierForName(msg.effect);
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

  /**
   * gv2mqtt fetches this device's real scene/music/DIY effect list from
   * Govee's own API (per the SKU's supported scene library plus the
   * account's DIY scenes) and republishes it here as part of its Home
   * Assistant MQTT discovery config for the light entity. Neither this topic
   * nor the state topic is retained, so this only arrives after gv2mqtt's own
   * startup or after it sees a Home Assistant "birth" message (see
   * GoveeGv2MqttPlatform's refreshStateOnConnect).
   */
  private handleDiscoveryConfig(payload: string): void {
    if (!payload) {
      // Empty payload is Home Assistant's convention for "entity removed";
      // keep whatever effect list we already have rather than clearing it.
      return;
    }
    let cfg: DiscoveryConfigMessage;
    try {
      cfg = JSON.parse(payload);
    } catch {
      this.log.warn(`[${this.config.name}] ignoring unparseable discovery config payload`);
      return;
    }
    if (!Array.isArray(cfg.effect_list)) {
      return;
    }
    const names = cfg.effect_list.filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (names.length === 0) {
      return;
    }

    const current = this.state.effectNames.slice(1);
    if (current.length === names.length && current.every((n, i) => n === names[i])) {
      return;
    }

    this.state.effectNames = buildEffectNames(names);
    for (const effectName of this.state.effectNames) {
      this.identifierForName(effectName);
    }
    this.log.info(`[${this.config.name}] Discovered ${names.length} real effect(s) from gv2mqtt`);
    this.emit('change', this.getState());
  }

  setOn(on: boolean): void {
    const wasOn = this.state.isOn;
    this.log.debug(`[${this.config.name}] setOn(${on}) - wasOn=${wasOn}, mode=${this.state.mode}`);

    if (on && wasOn) {
      // Already on - this is a redundant "on" (e.g. Adaptive Lighting
      // re-asserting state a few seconds after the Lightbulb and Effects
      // accessories' shared isOn flips to true, or Home resending state for
      // any other reason), not a real off->on transition. Applying our
      // normal "turn on" behavior here would reset an effect that was just
      // selected via the Effects accessory back to Normal Light.
      this.log.debug(`[${this.config.name}] setOn: no-op (already on)`);
      return;
    }

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
    const rounded = Math.round(brightness);
    const changed = rounded !== this.state.brightness;
    this.log.debug(
      `[${this.config.name}] setBrightness(${rounded}) - was=${this.state.brightness}, changed=${changed}, ` +
        `isOn=${this.state.isOn}, mode=${this.state.mode}`,
    );
    this.markLocalChange();
    this.state.brightness = rounded;
    if (!this.state.isOn) {
      return;
    }
    if (this.state.mode === 'effect') {
      if (!changed) {
        // HomeKit resends the last-known brightness right after turning a
        // light on (e.g. as part of the same automation transaction that
        // also just selected an effect via the Effects accessory). Treat a
        // no-op resend as just that, not as a user dragging the brightness
        // slider to explicitly back out of the effect.
        this.log.debug(`[${this.config.name}] setBrightness: no-op resend, staying in effect mode`);
        return;
      }
      this.log.debug(`[${this.config.name}] setBrightness: exiting effect mode (real brightness change)`);
      this.state.mode = 'adaptive';
      this.state.effectIndex = 1;
      this.publish({ state: 'ON', color_temp: this.state.mireds, brightness: this.state.brightness });
    } else {
      this.publish({ state: 'ON', brightness: this.state.brightness });
    }
    this.emit('change', this.getState());
  }

  setColorTemperature(mireds: number, fromAdaptiveLighting = false): void {
    this.log.debug(
      `[${this.config.name}] setColorTemperature(${Math.round(mireds)}) - isOn=${this.state.isOn}, ` +
        `mode=${this.state.mode}, fromAdaptiveLighting=${fromAdaptiveLighting}`,
    );
    this.state.mireds = Math.round(mireds);
    if (!this.state.isOn || this.state.mode === 'effect') {
      return;
    }

    if (fromAdaptiveLighting) {
      // Background nudge, not a deliberate user change: publish deferred
      // (see AL_PUBLISH_DELAY_MS), re-checking the state right before
      // sending so a nudge scheduled while the light looked on gets dropped
      // once a physical "off" report (or an effect/alert activation) lands
      // in the meantime. Also sent without a brightness field - the nudge
      // doesn't change brightness, and including it would make gv2mqtt issue
      // a second, pointless Govee API call every tick.
      if (this.alPublishTimer) {
        clearTimeout(this.alPublishTimer);
      }
      this.alPublishTimer = setTimeout(() => {
        this.alPublishTimer = undefined;
        if (!this.state.isOn || this.state.mode !== 'adaptive') {
          this.log.debug(
            `[${this.config.name}] Dropping deferred Adaptive Lighting nudge - ` +
              `isOn=${this.state.isOn}, mode=${this.state.mode}`,
          );
          return;
        }
        this.markLocalChange();
        this.lastAlCommandAt = Date.now();
        this.publish({ state: 'ON', color_temp: this.state.mireds });
      }, AL_PUBLISH_DELAY_MS);
      this.emit('change', this.getState());
      return;
    }

    this.markLocalChange();
    this.state.mode = 'adaptive';
    this.publish({ state: 'ON', color_temp: this.state.mireds, brightness: this.state.brightness });
    this.emit('change', this.getState());
  }

  setHue(hue: number): void {
    this.log.debug(`[${this.config.name}] setHue(${hue})`);
    this.queueHueSat({ hue });
  }

  setSaturation(saturation: number): void {
    this.log.debug(`[${this.config.name}] setSaturation(${saturation})`);
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
    const name = index <= 1 ? NORMAL_LIGHT : this.nameForIdentifier(index);
    this.log.debug(`[${this.config.name}] setEffectIndex(${index}) -> "${name}"`);
    this.markLocalChange();
    // HomeKit doesn't guarantee whether Active or ActiveIdentifier arrives
    // first when an automation turns the light on with an effect selected.
    // Marking isOn true here (regardless of branch) means that whichever of
    // setOn/setEffectIndex fires second sees the light as already on: if
    // it's setOn(true), its "already on" no-op guard kicks in instead of
    // resetting back to Normal Light.
    this.state.isOn = true;
    if (index <= 1 || !name) {
      this.state.effectIndex = 1;
      this.state.mode = 'adaptive';
      this.publish({ state: 'ON', color_temp: this.state.mireds, brightness: this.state.brightness });
    } else {
      this.state.effectIndex = index;
      this.state.mode = 'effect';
      this.publish({ state: 'ON', effect: name });
      // Govee's own cloud API appears to be able to race an effect/scene
      // command against an unrelated color-temperature command issued
      // several seconds earlier (e.g. Adaptive Lighting's periodic nudge),
      // settling on plain color mode several seconds later even though the
      // effect command was published last - observed settling as late as
      // ~5s after the effect command in practice. Re-assert it once more,
      // if nothing has since changed the selection, to win that race.
      // Single shot and cancelled/replaced on every call (rather than firing
      // at several delays) so paging quickly through effects by hand in Home
      // doesn't pile up a burst of redundant re-sends behind it.
      if (this.effectReassertTimer) {
        clearTimeout(this.effectReassertTimer);
      }
      const reassertIndex = index;
      this.effectReassertTimer = setTimeout(() => {
        this.effectReassertTimer = undefined;
        if (this.state.mode === 'effect' && this.state.effectIndex === reassertIndex) {
          this.log.debug(`[${this.config.name}] Re-asserting effect "${name}" to guard against a server-side race`);
          this.publish({ state: 'ON', effect: name });
        }
      }, 5000);
    }
    this.emit('change', this.getState());
  }

  /**
   * Forces the light to a fixed alert color, first snapshotting whatever it
   * was doing (including an active effect) so restoreSnapshot() can put it
   * back exactly. Meant to be driven by AlertAccessory's Switch - see
   * README's door-sensor example. Always sent as a true RGB color (not run
   * through the white/color-temperature heuristic used for Home's color
   * wheel), since an alert color is a deliberate, explicit choice.
   */
  triggerAlert(hue: number, saturation: number, brightness: number): void {
    this.snapshot = {
      isOn: this.state.isOn,
      mode: this.state.mode,
      mireds: this.state.mireds,
      hue: this.state.hue,
      saturation: this.state.saturation,
      brightness: this.state.brightness,
      effectIndex: this.state.effectIndex,
    };
    this.log.debug(`[${this.config.name}] Captured snapshot before alert: ${JSON.stringify(this.snapshot)}`);

    this.markLocalChange();
    this.state.isOn = true;
    this.state.mode = 'rgb';
    this.state.hue = hue;
    this.state.saturation = saturation;
    this.state.brightness = brightness;
    this.state.alertActive = true;

    const { r, g, b } = hueSatToRgb(hue, saturation, brightness);
    this.publish({ state: 'ON', color: { r, g, b }, brightness });
    this.emit('change', this.getState());
  }

  /** Reverses triggerAlert(), reapplying whatever was captured - including a specific effect. */
  restoreSnapshot(): void {
    const snap = this.snapshot;
    this.snapshot = null;
    this.state.alertActive = false;

    if (!snap) {
      this.log.warn(`[${this.config.name}] restoreSnapshot() called with no prior snapshot; leaving state as-is.`);
      this.emit('change', this.getState());
      return;
    }

    this.markLocalChange();
    this.state.isOn = snap.isOn;
    this.state.mode = snap.mode;
    this.state.mireds = snap.mireds;
    this.state.hue = snap.hue;
    this.state.saturation = snap.saturation;
    this.state.brightness = snap.brightness;
    this.state.effectIndex = snap.effectIndex;

    if (!snap.isOn) {
      this.publish({ state: 'OFF' });
    } else if (snap.mode === 'effect') {
      const name = this.nameForIdentifier(snap.effectIndex) ?? NORMAL_LIGHT;
      this.publish({ state: 'ON', effect: name });
    } else if (snap.mode === 'rgb') {
      const { r, g, b } = hueSatToRgb(snap.hue, snap.saturation, snap.brightness);
      this.publish({ state: 'ON', color: { r, g, b }, brightness: snap.brightness });
    } else {
      this.publish({ state: 'ON', color_temp: snap.mireds, brightness: snap.brightness });
    }

    this.log.debug(`[${this.config.name}] Restored snapshot: ${JSON.stringify(snap)}`);
    this.emit('change', this.getState());
  }
}

export interface GoveeDevice {
  on(event: 'change', listener: (state: GoveeDeviceState) => void): this;
  emit(event: 'change', state: GoveeDeviceState): boolean;
}
