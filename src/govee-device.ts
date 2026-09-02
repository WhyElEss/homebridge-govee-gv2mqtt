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

/**
 * Which aspects of the light's appearance are waiting to be sent. Values are
 * not carried here - they are written straight into `state` so that onGet and
 * HomeKit are correct the instant the write lands; this only records what has
 * to end up in the next command.
 */
interface DesiredPatch {
  brightness?: boolean;
  /** Hue and/or saturation; flush decides color-vs-white from them. */
  colorWheel?: boolean;
  colorTemp?: boolean;
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
 * After a device-reported "off" that nothing we sent can account for -
 * either one that arrived while AL was actively nudging (see
 * AL_NUDGE_RECENT_MS) or, in any mode, one with no command of ours behind it
 * (see isOutOfBandOff) - treat the off as the user's explicit intent, they
 * pressed the lamp's physical button, and defend it: any "on" report
 * arriving within this window without a matching HomeKit-originated power-on
 * gets answered with an OFF command. Bounded by OFF_ENFORCE_MAX_REASSERTS
 * so a genuine out-of-band power-on (Govee app, second button press) can
 * only be fought a few times, then wins.
 */
const OFF_ENFORCE_WINDOW_MS = 30000;
const OFF_ENFORCE_MAX_REASSERTS = 3;

/**
 * How long after a command of ours an incoming "off" report is still
 * attributable to that command rather than to the lamp's physical button.
 * Covers both of the ways we can be the cause: our own OFF echoing back as a
 * report, and the spurious OFF blip Govee's cloud can emit a couple of
 * seconds after an effect/color command (the blip that used to make the
 * watchdog fight manual effect browsing). Past this window nothing we did
 * explains the off, so it was someone at the lamp - see isOutOfBandOff.
 */
const OFF_UNSOLICITED_GRACE_MS = 10000;

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

/**
 * A scene delivers its characteristic writes as one near-simultaneous
 * batch, with no guaranteed ordering. A redundant Lightbulb On=true that
 * lands within this window of an effect/color command we just published is
 * treated as part of the same scene batch (e.g. a color scene whose On
 * write arrived after its Hue/Saturation writes) rather than as a
 * standalone "switch back to normal light" signal - without this, a scene
 * that sets a color or effect would wipe its own result whenever its On
 * write happened to arrive last.
 */
const SCENE_BATCH_GRACE_MS = 2000;

/**
 * The coalescing window for everything about the light's appearance -
 * brightness, the color wheel, a deliberate color temperature. The first
 * write opens the window, every write inside it merges into one pending
 * patch, and one command goes out when it closes.
 *
 * **Fixed, not sliding.** The timer is only armed when none is running, so a
 * continuous drag still reaches the lamp at a bounded rate instead of going
 * silent until the finger stops. This is the mistake v0.7.7 made: it
 * rescheduled the timer on every write, which collapses a burst only while
 * the writes are closer together than the window. Home's slider writes
 * arrive roughly every 250ms, so a 100ms sliding window published every
 * single one - a drag captured on 2026-09-02 11:31 still produced nine
 * commands, four of them repeats of a value already sent. Each becomes its
 * own Govee API call, and the lamp visibly steps through the queue.
 *
 * Longer than the 80ms the same design uses in homebridge-yeelight-wifi,
 * which talks to a lamp on the LAN that answers in ~90ms; here every command
 * is a cloud round trip of about a second.
 */
const COALESCE_MS = 350;

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
  private pendingHueSat: { hue?: number; saturation?: number } | null = null;
  private flushTimer?: NodeJS.Timeout;
  /**
   * What the user has touched but we have not sent yet. Merged, not queued:
   * a second write to the same aspect inside the window replaces the first
   * rather than adding a command. Null when nothing is pending.
   */
  private desired: DesiredPatch | null = null;
  /**
   * The last value we asked the device for, per property, stamped when the
   * command went out. Used to recognise that device's report as our own
   * command coming back - see accepts().
   */
  private readonly commanded = new Map<string, { at: number }>();
  /**
   * The brightness this device had when the current burst of slider writes
   * started, or null when no burst is pending. What "the user really changed
   * the brightness" is measured against at flush time - an individual write
   * mid-drag says nothing, and a drag that ends where it began (Home resends
   * the same value freely) must not count as a change and cancel a running
   * effect.
   */
  private brightnessBeforeBurst: number | null = null;
  private effectReassertTimer?: NodeJS.Timeout;
  private alPublishTimer?: NodeJS.Timeout;
  private lastAlCommandAt = 0;
  private lastAlConfiguredAt = 0;
  private lastColorCommandAt = 0;
  private lastPublishAt = 0;
  private lastCommandedOn = false;
  /**
   * A color chosen on a light that was ALREADY off - a deliberate "next time
   * this comes on, come on like this", which is what the user is doing when
   * they switch the lamp off, pick a color, and only then reach for the
   * power or brightness control. That intent has no natural deadline (they
   * look at the tile, then act), so unlike lastColorCommandAt it is a flag
   * rather than a timestamp. The color of a lamp that was switched off while
   * lit is deliberately NOT remembered this way: turning that one back on
   * still returns it to normal light, which is what the Adaptive-Lighting
   * scene handling relies on. Cleared by resetToNormalLight(), i.e. by
   * anything that deliberately puts the lamp back to normal light.
   */
  private colorChosenWhileOff = false;
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

  /**
   * Whether a device-reported value for one property should be believed, or
   * dropped as our own command coming back at us. Two reasons to drop it:
   *
   *  - something newer for that property is still sitting in `desired`,
   *    waiting to go out. Whatever the device is telling us is by definition
   *    older than what the user has already asked for.
   *  - we commanded that property within `optimisticCacheMs`. gv2mqtt's
   *    reports run several seconds behind and arrive out of order - one drag
   *    on 2026-09-02 was answered with 94, 53, 22, 31, 21 in that order,
   *    long after we had settled on 20 - so anything inside the window is
   *    untrustworthy whether or not it matches what we asked for.
   *
   * That last point is where this deliberately differs from the same gate in
   * homebridge-yeelight-wifi, which lets a *differing* value through as a
   * genuine out-of-band change. A Yeelight answers on the LAN in about 90ms,
   * so a differing value really is news; here it is far more often a stale
   * report still working its way out of Govee's cloud, and believing it
   * snaps the slider back to a position the finger already left.
   *
   * Scoping it per property is the improvement over the blanket window this
   * replaces: a brightness drag no longer blinds us to a color change made
   * in the Govee app at the same moment.
   */
  private accepts(prop: 'on' | 'brightness' | 'color_temp' | 'color' | 'effect'): boolean {
    if (this.desired) {
      if (prop === 'brightness' && this.desired.brightness) {
        return false;
      }
      if ((prop === 'color' || prop === 'color_temp') && (this.desired.colorWheel || this.desired.colorTemp)) {
        return false;
      }
    }
    const commanded = this.commanded.get(prop);
    if (!commanded) {
      return true;
    }
    return Date.now() - commanded.at >= this.optimisticCacheMs;
  }

  private publish(payload: Record<string, unknown>): void {
    if (typeof payload.color_temp === 'number') {
      // Remember the last color temperature actually sent to the device, so
      // deferred AL nudges can skip re-sending an imperceptible change.
      this.lastSentMireds = payload.color_temp;
    }
    // Recorded here, as the command goes out, rather than when the device
    // confirms it: gv2mqtt's report of a state change can reach us in the
    // same socket read as the confirmation of the command that caused it,
    // so anything stamped on confirmation is stamped too late to recognise
    // the report as an echo. See isEchoOfOurOwnOn.
    this.lastCommandedOn = payload.state === 'ON';
    this.lastPublishAt = Date.now();
    // Stamped as the command goes out, for the same reason lastCommandedOn is
    // (see above): a report of the change can reach us in the same socket
    // read as the confirmation of the command that caused it.
    const at = Date.now();
    this.commanded.set('on', { at });
    for (const prop of ['brightness', 'color_temp', 'color', 'effect']) {
      if (payload[prop] !== undefined) {
        this.commanded.set(prop, { at });
      }
    }
    this.log.debug(`[${this.config.name}] Publishing MQTT: ${this.config.commandTopic} = ${JSON.stringify(payload)}`);
    this.client.publish(this.config.commandTopic, JSON.stringify(payload));
  }

  private markLocalChange(): void {
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
    this.lastColorCommandAt = Date.now();
    this.publish({ state: 'ON', color, brightness });
  }

  private publishEffect(name: string): void {
    this.lastColorCommandAt = Date.now();
    this.publish({ state: 'ON', effect: name });
  }

  /**
   * Merges one aspect of the light's appearance into the pending patch and
   * arms the coalescing window if it isn't already running. See
   * COALESCE_MS for why the timer is fixed rather than rescheduled.
   */
  private queueAppearance(patch: DesiredPatch): void {
    this.desired = { ...(this.desired ?? {}), ...patch };
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushAppearance(), COALESCE_MS);
    }
  }

  /**
   * Drops whatever appearance change is pending. Used by the paths that
   * publish a complete command of their own (power, effects, alerts) and so
   * already carry, or deliberately override, everything the patch held.
   */
  private discardPendingAppearance(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.desired = null;
    this.brightnessBeforeBurst = null;
  }

  /**
   * Turns the pending patch into exactly one command. Everything the user
   * touched inside the window rides along: a gesture that changed the color
   * and the brightness is one command, not two.
   */
  private flushAppearance(): void {
    this.flushTimer = undefined;
    const patch = this.desired;
    const before = this.brightnessBeforeBurst;
    this.desired = null;
    this.brightnessBeforeBurst = null;
    if (!patch) {
      return;
    }

    if (!this.state.isOn) {
      // Switched off (physical button, HomeKit, an alert) while the window
      // was open. Every command shape carries state:"ON", so sending one
      // now would light the lamp back up. A color picked on a lamp that was
      // already off is remembered instead - see colorChosenWhileOff.
      this.log.debug(`[${this.config.name}] Dropping deferred appearance change - the light is off`);
      return;
    }

    const payload: Record<string, unknown> = { state: 'ON' };

    if (patch.colorWheel) {
      if (this.state.mode === 'rgb') {
        payload.color = this.currentRgb();
      } else {
        payload.color_temp = this.state.mireds;
      }
    } else if (patch.colorTemp) {
      payload.color_temp = this.state.mireds;
    } else if (patch.brightness && this.state.mode === 'effect') {
      if (before === this.state.brightness) {
        // HomeKit resends the last-known brightness right after turning a
        // light on (e.g. as part of the same automation transaction that
        // also just selected an effect via the Effects accessory), and a
        // drag can end back where it started. Treat either as the no-op it
        // is, not as the user explicitly backing out of the effect.
        this.log.debug(`[${this.config.name}] flushAppearance: no-op brightness resend, staying in effect mode`);
        return;
      }
      this.log.debug(`[${this.config.name}] flushAppearance: exiting effect mode (real brightness change)`);
      this.resetToNormalLight();
      payload.color_temp = this.state.mireds;
    }

    if (patch.brightness || payload.color !== undefined || payload.color_temp !== undefined) {
      // gv2mqtt maps each field onto its own Govee API call, so brightness
      // only rides along when it was actually touched - or when the command
      // sets a color/temperature anyway, where Govee needs it to scale the
      // result.
      payload.brightness = this.state.brightness;
    }

    this.publish(payload);
    this.emit('change', this.getState());
  }

  /**
   * The device-facing RGB for the currently cached hue and saturation, at
   * **full value**. Brightness is a separate field in every command shape
   * (and a separate Govee API call behind gv2mqtt): the device stores hue
   * and level independently, which is visible on the wire - through a
   * brightness drag on 2026-09-02 the reports kept `color:{r:128,g:0,b:255}`
   * unchanged while `brightness` walked 94 -> 53 -> 31 -> 22 -> 21. Scaling
   * the RGB by brightness as well, which is what this plugin used to do,
   * bakes the level into the color channel and then dims it a second time -
   * a color picked at 17% went out as `{"color":{"r":22,"g":0,"b":43"},
   * "brightness":17}`. Same conclusion as homebridge-yeelight-wifi, which
   * sends hue/saturation and ignores rgb entirely.
   */
  private currentRgb(): RGB {
    return hueSatToRgb(this.state.hue, this.state.saturation, 100);
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
    this.colorChosenWhileOff = false;
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
    if (!reportedOn && this.isEchoOfOurOwnOn()) {
      this.log.debug(
        `[${this.config.name}] Ignoring an OFF report that contradicts the ON we just commanded ` +
          '(Govee\'s spurious post-command blip); the light stays on',
      );
      return; // our own "on" coming back at us; nothing in the report is trustworthy
    }
    this.applyReportedState(msg, reportedOn);
    this.emit('change', this.getState());
  }

  /**
   * Guards a physical (out-of-band) power-off against being undone - either
   * by Adaptive Lighting traffic still in flight, or by Govee's cloud
   * settling a stale command of its own accord, whatever mode the lamp was
   * in. Returns true when an unsolicited "on" report was suppressed and must
   * not be applied to state at all.
   */
  private defendPhysicalOff(reportedOn: boolean): boolean {
    if (!reportedOn) {
      // Two independent reasons to read a device-reported "off" as the
      // user's own doing, and so worth defending. Both hazards below were
      // observed with Govee's cloud.
      //
      // (a) The last command we sent was a background AL nudge (every
      //     deliberate HomeKit command resets lastAlCommandAt via
      //     markLocalChange), so the lamp was sitting idle in plain adaptive
      //     mode when it went off. A nudge published moments ago may still
      //     be in flight and wake it back up - gv2mqtt maps color-temp
      //     commands onto Govee API calls that power the lamp on - so this
      //     case additionally re-asserts the off.
      // (b) Nothing we published can account for the off at all (see
      //     isOutOfBandOff), whatever mode the lamp was in. This is the
      //     plain "someone pressed the button" case, and until 0.7.2 it was
      //     defended only in adaptive mode: an off while an effect or a
      //     color was running armed nothing, because lastAlCommandAt is
      //     zeroed by the very command that set that effect/color.
      const sinceNudge = Date.now() - this.lastAlCommandAt;
      const duringAdaptiveLighting =
        this.lastAlCommandAt > 0 && sinceNudge < AL_NUDGE_RECENT_MS && this.state.mode === 'adaptive';
      const unsolicited = this.state.isOn && this.isOutOfBandOff();

      if (duringAdaptiveLighting || unsolicited) {
        // Govee's cloud can settle an older, already-delivered command AFTER
        // the physical off, relighting the lamp on its own with no further
        // input from us. That arrives here as an unsolicited "on" report -
        // arm a short watchdog window in which such an "on" (one no HomeKit
        // action asked for) is answered with an OFF command; see the
        // reportedOn branch below.
        if (Date.now() >= this.offEnforceUntil) {
          // Only arm a fresh window if one isn't already running - our own
          // corrective OFFs echo back as more "off" reports, and letting
          // those re-arm the window/attempt budget would make the watchdog
          // self-perpetuating.
          this.offEnforceUntil = Date.now() + OFF_ENFORCE_WINDOW_MS;
          this.offEnforceAttempts = 0;
          this.log.debug(
            `[${this.config.name}] Out-of-band OFF (${duringAdaptiveLighting ? 'during active Adaptive Lighting' : `mode=${this.state.mode}`}); ` +
              `defending it for ${OFF_ENFORCE_WINDOW_MS / 1000}s`,
          );
        }
        if (duringAdaptiveLighting && sinceNudge < AL_OFF_REASSERT_WINDOW_MS) {
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

  /**
   * True when no command of ours can explain an incoming "off" report, i.e.
   * the lamp was switched off at the lamp. Anything we published within
   * OFF_UNSOLICITED_GRACE_MS accounts for the report by itself and must not
   * arm the watchdog: our own OFF echoes back as an "off" report, and an
   * effect/color command is followed a couple of seconds later by Govee's
   * spurious OFF blip - reading that blip as a button press is what used to
   * make the watchdog kill each newly selected effect while browsing them by
   * hand.
   */
  private isOutOfBandOff(): boolean {
    return Date.now() - this.lastPublishAt >= OFF_UNSOLICITED_GRACE_MS;
  }

  /**
   * True when an incoming "off" report is our own ON command coming back at
   * us rather than the lamp actually being off - Govee's known spurious OFF
   * blip a couple of seconds after an effect/color command (the same blip
   * OFF_UNSOLICITED_GRACE_MS already stops the watchdog mistaking for a
   * button press). Three things have to hold: HomeKit currently shows the
   * light on, so there is something to protect; the last command we
   * published asked for ON (recorded in publish(), as it goes out) and is
   * recent enough to account for this report; and defendPhysicalOff - which
   * runs first - did not just read this same report as the user's own
   * doing, since an off it decided to defend has to reach `isOn` or its
   * "unsolicited ON" branch, which requires a cached off, can never fire.
   *
   * Suppressing the blip is what keeps the Home tile (and the Effects
   * accessory's Active) from going dark for the few seconds until the real
   * "on" report lands. Reflecting it was worse than a flicker: with `isOn`
   * cached false, a tap on the seemingly-off tile reached setOn with
   * wasOn=false, which takes the full power-on path and resets the effect
   * the user had just selected, and the 5s effect re-assertion dropped
   * itself for a light it believed was off.
   *
   * This costs nothing in physical-off defence: inside the same grace
   * window defendPhysicalOff already refuses to read an "off" as a button
   * press, so before this guard the off reached `isOn` but armed no
   * watchdog - a bogus "on" behind it was accepted either way.
   */
  private isEchoOfOurOwnOn(): boolean {
    return (
      this.state.isOn && this.lastCommandedOn && !this.isOutOfBandOff() && Date.now() >= this.offEnforceUntil
    );
  }

  private applyReportedState(msg: IncomingMessage, reportedOn: boolean): void {
    this.state.isOn = reportedOn;
    if (!this.state.isOn && this.accepts('effect')) {
      // Only trust an "off" report enough to reset mode/effect bookkeeping
      // once we're past the optimistic window. gv2mqtt/Govee's cloud can
      // report a spurious/transient "off" a moment after we've just
      // published an "on with effect" command (seemingly an eventual-
      // consistency race server-side, not anything this plugin published) -
      // still reflect isOn honestly either way, but don't let a blip like
      // that wipe out an effect selection that was just made.
      this.resetToNormalLight();
    }

    if (!this.state.isOn) {
      return;
    }

    // Each property is judged on its own now (see accepts): a report that
    // is only echoing the brightness we just sent can still tell us about a
    // color someone changed in the Govee app at the same moment.
    if (this.accepts('effect') && this.accepts('color') && this.accepts('color_temp')) {
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
    }
    if (typeof msg.brightness === 'number' && this.accepts('brightness')) {
      this.state.brightness = msg.brightness;
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

  setOn(on: boolean, source: 'lightbulb' | 'tv' = 'lightbulb'): void {
    const wasOn = this.state.isOn;
    this.log.debug(`[${this.config.name}] setOn(${on}) from ${source} - wasOn=${wasOn}, mode=${this.state.mode}`);

    if (on && wasOn) {
      if (
        source === 'lightbulb' &&
        this.state.mode !== 'adaptive' &&
        !this.state.alertActive &&
        Date.now() - this.lastColorCommandAt > SCENE_BATCH_GRACE_MS
      ) {
        // A redundant ON written to the Lightbulb itself while an effect or
        // color is active: this is how the original mqttthing config let a
        // scene pull the lamp back to normal light/Adaptive Lighting - a
        // scene that includes this lamp always writes On=true, and it's the
        // only write from an "Adaptive Lighting" scene that's guaranteed to
        // arrive (iOS skips rewriting the AL transition often enough that
        // relying on it alone proved flaky). Effect automations are
        // unaffected: they drive the Effects TV accessory, whose redundant
        // Active goes through the 'tv' no-op below, and a color/effect
        // command published within the last couple of seconds exempts this
        // ON as part of that same scene batch (see SCENE_BATCH_GRACE_MS).
        // An active alert also wins - its restore handles cleanup.
        this.log.debug(
          `[${this.config.name}] setOn: redundant Lightbulb ON while in ${this.state.mode} mode - returning to normal light`,
        );
        this.markLocalChange();
        this.discardPendingAppearance();
        this.resetToNormalLight();
        this.publishColorTemp(this.state.mireds, this.state.brightness);
        this.emit('change', this.getState());
        return;
      }
      // Redundant "on" with nothing to exit (already in plain adaptive
      // mode), from the Effects TV (HomeKit doesn't guarantee whether
      // Active or ActiveIdentifier arrives first, so a TV "on" must never
      // reset a just-selected effect), or while an alert is active.
      this.log.debug(`[${this.config.name}] setOn: no-op (already on)`);
      return;
    }

    if (on) {
      this.disarmOffWatchdog();
    }
    this.markLocalChange();
    this.state.isOn = on;

    if (on && this.state.mode === 'rgb' && this.colorChosenWhileOff) {
      // Coming on in a color that was picked while this lamp was off.
      // resolveHueSat can only record such a choice - publishing it there
      // would wake a lamp the user left off - so without this the usual
      // resetToNormalLight()/publishColorTemp() below would overwrite the
      // color with white before it was ever sent. That is what the user
      // saw: red at 100% on an off lamp came up as plain Adaptive Lighting,
      // with no color command on the wire at all.
      //
      // No deadline on the intent: picking a color and then reaching for
      // the power or brightness control is one action to the user, however
      // long they take over it. It survives only until the light next comes
      // on, or until something deliberately returns the lamp to normal
      // light (see resetToNormalLight).
      this.discardPendingAppearance();
      this.colorChosenWhileOff = false;
      this.publishRgb(this.currentRgb(), this.state.brightness);
      this.emit('change', this.getState());
      return;
    }

    this.discardPendingAppearance();
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
    this.log.debug(
      `[${this.config.name}] setBrightness(${rounded}) - was=${this.state.brightness}, ` +
        `isOn=${this.state.isOn}, mode=${this.state.mode}`,
    );
    this.markLocalChange();
    if (this.brightnessBeforeBurst === null) {
      this.brightnessBeforeBurst = this.state.brightness;
    }
    // The cache moves immediately even though the command is deferred, so
    // onGet and anything else reading state see the slider's real position
    // at once; only what goes on the wire is coalesced.
    this.state.brightness = rounded;

    if (!this.state.isOn) {
      // Nothing to send - the value is just remembered for the next power-on.
      this.brightnessBeforeBurst = null;
      return;
    }

    this.queueAppearance({ brightness: true });
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
      this.queueAppearance({ colorTemp: true });
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

  /**
   * Home sends Hue and Saturation as two separate writes, and streams both
   * while the color wheel is being dragged. The values are resolved into
   * `state` at once (so onGet is right) and the command rides the shared
   * coalescing window with any brightness change from the same gesture.
   */
  private queueHueSat(partial: { hue?: number; saturation?: number }): void {
    this.pendingHueSat = { ...this.pendingHueSat, ...partial };
    this.resolveHueSat();
    this.queueAppearance({ colorWheel: true });
  }

  /**
   * Folds a pending hue/saturation pair into `state` and decides what the
   * light is now in - a true color, or a "white" the color wheel expresses
   * as a low-saturation color. Publishes nothing; flushAppearance does that.
   */
  private resolveHueSat(): void {
    if (!this.pendingHueSat) {
      return;
    }
    const hue = this.pendingHueSat.hue ?? this.state.hue;
    const saturation = this.pendingHueSat.saturation ?? this.state.saturation;
    this.pendingHueSat = null;

    this.markLocalChange();
    this.state.hue = hue;
    this.state.saturation = saturation;

    // Taken straight from the characteristic rather than round-tripped
    // through RGB: the old `(max - min) / max` was the same number, but
    // computed from 0-255 values that had been scaled by brightness, so at
    // a low brightness rounding could shift it across the threshold and
    // flip the white/color decision for the same color.
    if (saturation / 100 < this.config.colorSaturationThreshold) {
      // Home's color wheel was used to pick a "white", so it goes to the
      // device as a color temperature instead of RGB.
      const { r, g, b } = hueSatToRgb(hue, saturation, 100);
      void g;
      const ratio = r > 0 ? b / r : 0.5;
      const mireds = Math.round(
        Math.max(this.config.minMireds, Math.min(this.config.maxMireds, 500 - ratio * 390)),
      );
      this.state.mireds = mireds;
      // A color-wheel write is always deliberate (user or a scene with a
      // stored color) - it exits an active effect, same as a deliberate
      // color-temperature write. Done whether or not the light is on, so
      // that picking a white on an off lamp also cancels a color picked on
      // it a moment earlier (resetToNormalLight clears colorChosenWhileOff).
      this.resetToNormalLight();
    } else {
      // The mode is recorded whether or not the light is on: picking a color
      // on a light that's off is still a color choice, and Home sends
      // Hue/Saturation *before* the On write, so setOn has to be able to see
      // that a color was just asked for. Only the command is withheld -
      // touching the color wheel must not wake a lamp the user left off.
      this.state.mode = 'rgb';
      this.state.effectIndex = 1;
      this.lastColorCommandAt = Date.now();
      if (!this.state.isOn) {
        this.colorChosenWhileOff = true;
      }
    }
    this.emit('change', this.getState());
  }

  setEffectIndex(index: number): void {
    const name = index <= 1 ? NORMAL_LIGHT : this.nameForIdentifier(index);
    this.log.debug(`[${this.config.name}] setEffectIndex(${index}) -> "${name}"`);
    this.disarmOffWatchdog();
    this.markLocalChange();
    this.discardPendingAppearance();
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
        if (!this.state.isOn) {
          // The lamp was switched off (physical button, HomeKit, an alert
          // restore) during the re-assertion delay. publishEffect sends
          // {state:"ON", effect}, so firing now would light it back up -
          // and `mode` can't catch that on its own: setEffectIndex has just
          // opened the optimistic window, which is longer than this delay
          // and makes applyReportedState skip resetToNormalLight, leaving
          // mode stuck at 'effect' even after the "off" report lands.
          this.log.debug(`[${this.config.name}] Dropping effect re-assertion - the light is off`);
          return;
        }
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
    this.discardPendingAppearance();
    this.state.isOn = true;
    this.state.mode = 'rgb';
    this.state.hue = hue;
    this.state.saturation = saturation;
    this.state.brightness = brightness;
    this.state.alertActive = true;

    this.publishRgb(hueSatToRgb(hue, saturation, 100), brightness);
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
    this.discardPendingAppearance();
    Object.assign(this.state, snap);

    if (!snap.isOn) {
      this.publishPowerOff();
    } else if (snap.mode === 'effect') {
      this.publishEffect(this.nameForIdentifier(snap.effectIndex) ?? NORMAL_LIGHT);
    } else if (snap.mode === 'rgb') {
      this.publishRgb(hueSatToRgb(snap.hue, snap.saturation, 100), snap.brightness);
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
