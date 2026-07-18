import { EventEmitter } from 'events';
import { Logger } from 'homebridge';
import { MqttClient } from 'mqtt';
import { ResolvedDeviceConfig } from './config';
import { buildEffectNames, NORMAL_LIGHT } from './effects';
import { hueSatToRgb, RGB, rgbToHueSat } from './color';

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

/**
 * "An AL nudge was commanding this lamp recently" - i.e. within one nudge
 * interval (HAP-NodeJS sends them every updateInterval, 60s by default).
 * Used to decide whether a device-reported "off" happened while Adaptive
 * Lighting was actively driving the lamp, which is the only situation in
 * which Govee's cloud has been observed to settle an earlier command AFTER
 * a physical power-off and relight the lamp on its own.
 */
const AL_NUDGE_RECENT_MS = 60000;

/**
 * After a device-reported "off" that arrived while AL was actively nudging
 * (see AL_NUDGE_RECENT_MS), treat the off as the user's explicit intent -
 * they pressed the lamp's physical button - and defend it: any "on" report
 * arriving within this window without a matching HomeKit-originated power-on
 * gets answered with an OFF command. Bounded by OFF_ENFORCE_MAX_REASSERTS
 * so a genuine out-of-band power-on (Govee app, second button press) can
 * only be fought a few times, then wins.
 */
const OFF_ENFORCE_WINDOW_MS = 30000;
const OFF_ENFORCE_MAX_REASSERTS = 3;

/**
 * Minimum change in mireds since the last color_temp we actually sent for
 * an AL nudge to be worth publishing at all. AL drifts a few mireds a
 * minute; a sub-5-mired step is imperceptible, and every skipped command is
 * one less thing sitting in Govee's cloud pipeline for a physical button
 * press to race against.
 */
const AL_MIN_NUDGE_DELTA_MIREDS = 5;

/**
 * A controller-context color-temperature write arriving within this window
 * after an Adaptive Lighting transition was (re)written by iOS (see
 * noteAdaptiveLightingConfigured) is the immediate, synchronous follow-up
 * of that (re)configuration - i.e. a scene/automation deliberately
 * switching the lamp (back) to Adaptive Lighting - not one of the
 * background minute-ticks the controller keeps firing regardless of mode.
 */
const AL_ACTIVATION_WINDOW_MS = 5000;

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
  private lastAlConfiguredAt = 0;
  private lastSentMireds = -1;
  private offEnforceUntil = 0;
  private offEnforceAttempts = 0;
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
      setTimeout(() => this.publishPowerOff(), config.turnOffOnStartupDelayMs);
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

  /**
   * Called by LightAccessory whenever iOS (re)writes the Adaptive Lighting
   * transition (observed via the ActiveTransitionCount characteristic's
   * change event) - the only signal, in the controller's AUTOMATIC mode,
   * that a scene/automation just deliberately turned Adaptive Lighting on
   * for this lamp. The controller synchronously follows the (re)write with
   * a color-temperature SET; setColorTemperature uses this timestamp to
   * tell that deliberate activation apart from a background nudge and exit
   * an active effect/color mode for it.
   */
  noteAdaptiveLightingConfigured(): void {
    this.lastAlConfiguredAt = Date.now();
    this.log.debug(`[${this.config.name}] Adaptive Lighting transition (re)configured by a controller`);
  }

  private withinOptimisticWindow(): boolean {
    return Date.now() - this.lastLocalSetAt < this.optimisticCacheMs;
  }

  private publish(payload: Record<string, unknown>): void {
    if (typeof payload.color_temp === 'number') {
      // Remember the last color temperature actually sent to the device, so
      // deferred AL nudges can skip re-sending an imperceptible change.
      this.lastSentMireds = payload.color_temp;
    }
    this.log.debug(`[${this.config.name}] Publishing MQTT: ${this.config.commandTopic} = ${JSON.stringify(payload)}`);
    this.client.publish(this.config.commandTopic, JSON.stringify(payload));
  }

  private markLocalChange(): void {
    this.lastLocalSetAt = Date.now();
    // Every deliberate local command also supersedes the AL-nudge
    // bookkeeping: lastAlCommandAt must mean "the LAST command we sent was a
    // background AL nudge", because that's the only context in which the
    // physical-off watchdog may interpret an "off" report as a button
    // press. Without this reset, the known spurious OFF blip that Govee's
    // cloud can emit a few seconds after an effect command was mistaken for
    // a button press (a stale nudge timestamp from up to a minute earlier
    // made it look like "off during active AL"), and the watchdog then
    // fought the user's own effect browsing - killing each newly selected
    // effect with an OFF and making paging through effects crawl. The AL
    // publish path re-stamps lastAlCommandAt right after calling this, so
    // nudges themselves are unaffected.
    this.lastAlCommandAt = 0;
  }

  // The four gv2mqtt command shapes this plugin ever sends. gv2mqtt only
  // issues an explicit power-on for a bare {state:"ON"}; color_temp/color/
  // brightness fields each map onto their own Govee API call instead (which
  // still wakes a sleeping lamp - see the physical-power-off guards).
  private publishPowerOff(): void {
    this.publish({ state: 'OFF' });
  }

  private publishColorTemp(mireds: number, brightness?: number): void {
    if (brightness === undefined) {
      this.publish({ state: 'ON', color_temp: mireds });
    } else {
      this.publish({ state: 'ON', color_temp: mireds, brightness });
    }
  }

  private publishRgb(color: RGB, brightness: number): void {
    this.publish({ state: 'ON', color, brightness });
  }

  private publishEffect(name: string): void {
    this.publish({ state: 'ON', effect: name });
  }

  /**
   * Any HomeKit-originated power-on means an "on" is now expected - stop
   * defending a physical power-off (see handleMessage's watchdog).
   */
  private disarmOffWatchdog(): void {
    this.offEnforceUntil = 0;
  }

  /** Back to plain (non-effect) light mode; what "on" means unless an effect is chosen. */
  private resetToNormalLight(): void {
    this.state.mode = 'adaptive';
    this.state.effectIndex = 1;
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

    const reportedOn = msg.state === 'ON';
    if (this.defendPhysicalOff(reportedOn)) {
      return; // suppressed a bogus "on"; nothing else in the report is trustworthy
    }
    this.applyReportedState(msg, reportedOn);
    this.emit('change', this.getState());
  }

  /**
   * Guards a physical (out-of-band) power-off against being undone by
   * Adaptive Lighting traffic. Returns true when an unsolicited "on" report
   * was suppressed and must not be applied to state at all.
   */
  private defendPhysicalOff(reportedOn: boolean): boolean {
    if (!reportedOn) {
      const sinceNudge = Date.now() - this.lastAlCommandAt;
      if (this.lastAlCommandAt > 0 && sinceNudge < AL_NUDGE_RECENT_MS && this.state.mode === 'adaptive') {
        // The device reports "off" while the lamp is sitting idle in plain
        // adaptive mode and the last command we sent was a background AL
        // nudge (every deliberate HomeKit command resets lastAlCommandAt via
        // markLocalChange) - i.e. the light was just powered off
        // out-of-band, by its physical button. Two hazards follow, both
        // observed with Govee's cloud:
        //
        // 1. A nudge we published moments ago may still be in flight and
        //    wake the lamp back up (gv2mqtt maps color-temp commands onto
        //    Govee API calls that power it on). Re-assert the off.
        // 2. Govee's cloud can also settle an older, already-delivered
        //    command AFTER the physical off, relighting the lamp on its
        //    own with no further input from us. That arrives here as an
        //    unsolicited "on" report - arm a short watchdog window in which
        //    such an "on" (one no HomeKit action asked for) is answered
        //    with an OFF command; see the reportedOn branch below.
        if (Date.now() >= this.offEnforceUntil) {
          // Only arm a fresh window if one isn't already running - our own
          // corrective OFFs echo back as more "off" reports, and letting
          // those re-arm the window/attempt budget would make the watchdog
          // self-perpetuating.
          this.offEnforceUntil = Date.now() + OFF_ENFORCE_WINDOW_MS;
          this.offEnforceAttempts = 0;
          this.log.debug(
            `[${this.config.name}] Out-of-band OFF during active Adaptive Lighting; ` +
              `defending it for ${OFF_ENFORCE_WINDOW_MS / 1000}s`,
          );
        }
        if (sinceNudge < AL_OFF_REASSERT_WINDOW_MS) {
          this.lastAlCommandAt = 0;
          this.log.debug(
            `[${this.config.name}] Device reported OFF right after an Adaptive Lighting nudge; ` +
              're-asserting OFF in case the nudge woke it back up',
          );
          this.publishPowerOff();
        }
      }
      return false;
    }

    if (
      !this.state.isOn &&
      Date.now() < this.offEnforceUntil &&
      this.offEnforceAttempts < OFF_ENFORCE_MAX_REASSERTS
    ) {
      // Unsolicited "on" while defending a physical power-off: nothing in
      // HomeKit asked for this (every local power-on path - setOn,
      // setEffectIndex, triggerAlert, restoreSnapshot - disarms the
      // watchdog first), so it's Govee's cloud settling a stale command.
      // Push it back off and don't reflect the bogus "on" into HomeKit.
      this.offEnforceAttempts += 1;
      this.log.debug(
        `[${this.config.name}] Unsolicited ON while defending a physical power-off; ` +
          `pushing it back off (attempt ${this.offEnforceAttempts}/${OFF_ENFORCE_MAX_REASSERTS})`,
      );
      this.publishPowerOff();
      return true;
    }
    return false;
  }

  private applyReportedState(msg: IncomingMessage, reportedOn: boolean): void {
    this.state.isOn = reportedOn;
    if (!this.state.isOn && !this.withinOptimisticWindow()) {
      // Only trust an "off" report enough to reset mode/effect bookkeeping
      // once we're past the optimistic window. gv2mqtt/Govee's cloud can
      // report a spurious/transient "off" a moment after we've just
      // published an "on with effect" command (seemingly an eventual-
      // consistency race server-side, not anything this plugin published) -
      // still reflect isOn honestly either way, but don't let a blip like
      // that wipe out an effect selection that was just made.
      this.resetToNormalLight();
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

    if (on) {
      this.disarmOffWatchdog();
    }
    this.markLocalChange();
    this.state.isOn = on;
    this.resetToNormalLight();
    if (on) {
      this.publishColorTemp(this.state.mireds, this.state.brightness);
    } else {
      this.publishPowerOff();
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
      this.resetToNormalLight();
      this.publishColorTemp(this.state.mireds, this.state.brightness);
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
    if (!this.state.isOn) {
      return;
    }

    if (!fromAdaptiveLighting) {
      // A deliberate write - Home's temperature slider, a scene with a
      // stored color temperature, Siri. Applies unconditionally, pulling
      // the lamp out of an active effect if one is running; only Adaptive
      // Lighting's automatic background writes get the mode checks below.
      this.markLocalChange();
      this.resetToNormalLight();
      this.publishColorTemp(this.state.mireds, this.state.brightness);
      this.emit('change', this.getState());
      return;
    }

    if (this.state.mode !== 'adaptive') {
      if (Date.now() - this.lastAlConfiguredAt < AL_ACTIVATION_WINDOW_MS) {
        // This controller write is the synchronous follow-up of an Adaptive
        // Lighting transition just (re)written by iOS (see
        // noteAdaptiveLightingConfigured): a scene/automation deliberately
        // switched this lamp back to Adaptive Lighting. Exit the effect or
        // color mode for it instead of suppressing the write like a
        // background nudge.
        this.log.debug(
          `[${this.config.name}] Adaptive Lighting freshly (re)configured - leaving ${this.state.mode} mode for it`,
        );
        this.markLocalChange();
        this.resetToNormalLight();
        this.publishColorTemp(this.state.mireds, this.state.brightness);
        this.emit('change', this.getState());
      } else {
        this.log.debug(
          `[${this.config.name}] Ignoring background Adaptive Lighting write while in ${this.state.mode} mode`,
        );
      }
      return;
    }

    // Background nudge while already in plain adaptive mode: publish
    // deferred (see AL_PUBLISH_DELAY_MS), re-checking the state right
    // before sending so a nudge scheduled while the light looked on gets
    // dropped once a physical "off" report (or an effect/alert activation)
    // lands in the meantime. Also sent without a brightness field - the
    // nudge doesn't change brightness, and including it would make gv2mqtt
    // issue a second, pointless Govee API call every tick.
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
      if (
        this.lastSentMireds >= 0 &&
        Math.abs(this.state.mireds - this.lastSentMireds) < AL_MIN_NUDGE_DELTA_MIREDS
      ) {
        // Imperceptible drift since the last color_temp we actually sent;
        // skip the command entirely. The fewer commands sit in Govee's
        // cloud pipeline, the fewer chances a physical button press has
        // to race one of them.
        this.log.debug(
          `[${this.config.name}] Skipping Adaptive Lighting nudge - ` +
            `${this.state.mireds} mireds is within ${AL_MIN_NUDGE_DELTA_MIREDS} of last-sent ${this.lastSentMireds}`,
        );
        return;
      }
      this.markLocalChange();
      this.lastAlCommandAt = Date.now();
      this.publishColorTemp(this.state.mireds);
    }, AL_PUBLISH_DELAY_MS);
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
      if (this.state.isOn) {
        // A color-wheel write is always deliberate (user or a scene with a
        // stored color) - it exits an active effect, same as a deliberate
        // color-temperature write.
        this.resetToNormalLight();
        this.publishColorTemp(mireds, bri);
      }
    } else {
      if (this.state.isOn) {
        this.state.mode = 'rgb';
        this.state.effectIndex = 1;
        this.publishRgb({ r, g, b }, bri);
      }
    }
    this.emit('change', this.getState());
  }

  setEffectIndex(index: number): void {
    const name = index <= 1 ? NORMAL_LIGHT : this.nameForIdentifier(index);
    this.log.debug(`[${this.config.name}] setEffectIndex(${index}) -> "${name}"`);
    this.disarmOffWatchdog();
    this.markLocalChange();
    // HomeKit doesn't guarantee whether Active or ActiveIdentifier arrives
    // first when an automation turns the light on with an effect selected.
    // Marking isOn true here (regardless of branch) means that whichever of
    // setOn/setEffectIndex fires second sees the light as already on: if
    // it's setOn(true), its "already on" no-op guard kicks in instead of
    // resetting back to Normal Light.
    this.state.isOn = true;
    if (index <= 1 || !name) {
      this.resetToNormalLight();
      this.publishColorTemp(this.state.mireds, this.state.brightness);
    } else {
      this.state.effectIndex = index;
      this.state.mode = 'effect';
      this.publishEffect(name);
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
          this.publishEffect(name);
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
    this.snapshot = this.captureSnapshot();
    this.log.debug(`[${this.config.name}] Captured snapshot before alert: ${JSON.stringify(this.snapshot)}`);

    this.disarmOffWatchdog();
    this.markLocalChange();
    this.state.isOn = true;
    this.state.mode = 'rgb';
    this.state.hue = hue;
    this.state.saturation = saturation;
    this.state.brightness = brightness;
    this.state.alertActive = true;

    this.publishRgb(hueSatToRgb(hue, saturation, brightness), brightness);
    this.emit('change', this.getState());
  }

  private captureSnapshot(): StateSnapshot {
    const { isOn, mode, mireds, hue, saturation, brightness, effectIndex } = this.state;
    return { isOn, mode, mireds, hue, saturation, brightness, effectIndex };
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

    if (snap.isOn) {
      this.disarmOffWatchdog();
    }
    this.markLocalChange();
    Object.assign(this.state, snap);

    if (!snap.isOn) {
      this.publishPowerOff();
    } else if (snap.mode === 'effect') {
      this.publishEffect(this.nameForIdentifier(snap.effectIndex) ?? NORMAL_LIGHT);
    } else if (snap.mode === 'rgb') {
      this.publishRgb(hueSatToRgb(snap.hue, snap.saturation, snap.brightness), snap.brightness);
    } else {
      this.publishColorTemp(snap.mireds, snap.brightness);
    }

    this.log.debug(`[${this.config.name}] Restored snapshot: ${JSON.stringify(snap)}`);
    this.emit('change', this.getState());
  }
}

export interface GoveeDevice {
  on(event: 'change', listener: (state: GoveeDeviceState) => void): this;
  emit(event: 'change', state: GoveeDeviceState): boolean;
}
