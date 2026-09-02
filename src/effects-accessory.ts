import { PlatformAccessory, Service } from 'homebridge';
import { GoveeGv2MqttPlatform } from './platform';
import { GoveeDevice } from './govee-device';
import { encodeDisplayOrder } from './tlv';

/**
 * HAP-NodeJS hard-caps an accessory at 100 services total. This accessory
 * always carries AccessoryInformation + Television, leaving this many slots
 * for InputSource children.
 */
const MAX_INPUTS = 98;

/**
 * How many real Govee effects the user may pick. One of the MAX_INPUTS
 * slots always goes to the synthetic "Normal Light" input, which is how you
 * leave effect mode and so can never be hidden.
 */
export const MAX_SELECTABLE_EFFECTS = MAX_INPUTS - 1;

function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\w]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'input'
  );
}

/** HAP service subtype for an effect's InputSource; stable across restarts because it's name-derived. */
function subtypeForEffect(name: string): string {
  return `effect-${slugify(name)}`;
}

/**
 * Exposes Govee's scene/music/DIY effects as a Television accessory's
 * "Inputs", mirroring the original mqttthing hack: HomeKit's Lightbulb
 * service has no concept of named effects, but Television/InputSource does.
 *
 * The effect list is per-device and can change at runtime (gv2mqtt
 * discovers it from Govee's API - see GoveeDevice), so InputSource services
 * are reconciled reactively instead of being built once at startup.
 */
/**
 * What survives a restart in `accessory.context`, which Homebridge persists
 * with the cached accessory and hands back through configureAccessory.
 */
interface EffectsContext {
  /** Carried so the settings UI can tell whose catalog this is. */
  deviceId?: string;
  effectNames?: string[];
  identifiers?: Record<string, number>;
}

export class EffectsAccessory {
  private readonly service: Service;
  private appliedEffectNames: string[] | null = null;
  /** Identifiers that currently have an InputSource; see clampIdentifier. */
  private visibleIdentifiers = new Set<number>([1]);

  constructor(
    private readonly platform: GoveeGv2MqttPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: GoveeDevice,
  ) {
    const { Service: Svc, Characteristic } = this.platform;

    // Before anything is built from it. gv2mqtt doesn't retain its discovery
    // topic, so the real effect list only arrives ~17s into a run; without
    // this the accessory is published with the fallback list and rebuilt
    // when the real one lands. Rebuilding services changes the bridge's
    // configuration, and HomeKit answers that by re-reading every service
    // it has - measured at three configuration-number increments per
    // restart on this bridge (349, 350, 351 on 2026-09-02) while no other
    // bridge in the same Homebridge moved at all.
    const cached = accessory.context as EffectsContext;
    if (cached?.effectNames && cached.identifiers) {
      device.restoreEffectCatalog(cached.effectNames, cached.identifiers);
    }

    accessory
      .getService(Svc.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Govee')
      .setCharacteristic(Characteristic.Model, 'gv2mqtt Effects')
      .setCharacteristic(Characteristic.SerialNumber, `${device.config.deviceId}-effects`);

    this.service =
      accessory.getService(Svc.Television) ?? accessory.addService(Svc.Television, `${device.config.name} Effects`);
    // Accessories hosted inside a bridge (as ours are) get their Home app tile
    // icon from whichever service is marked primary, not from the accessory's
    // `category` - without this, Home falls back to a generic "house" icon
    // instead of the TV icon.
    this.service.setPrimaryService(true);
    this.service.setCharacteristic(Characteristic.ConfiguredName, `${device.config.name} Effects`);
    this.service.setCharacteristic(
      Characteristic.SleepDiscoveryMode,
      Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
    );

    this.service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => (this.device.getState().isOn ? 1 : 0))
      .onSet((value) => this.device.setOn(!!value, 'tv'));

    this.service
      .getCharacteristic(Characteristic.ActiveIdentifier)
      .onGet(() => this.device.getState().effectIndex)
      .onSet((value) => this.device.setEffectIndex(value as number));

    this.syncInputs(device.getState().effectNames);

    device.on('change', (state) => {
      this.service.updateCharacteristic(Characteristic.Active, state.isOn ? 1 : 0);
      this.service.updateCharacteristic(Characteristic.ActiveIdentifier, this.clampIdentifier(state.effectIndex));
      if (state.effectNames !== this.appliedEffectNames) {
        this.syncInputs(state.effectNames);
      }
    });
  }

  private syncInputs(namesIn: string[]): void {
    const { Service: Svc, Characteristic } = this.platform;

    let names = this.selectVisible(namesIn);
    if (names.length > MAX_INPUTS) {
      this.platform.log.warn(
        `[${this.device.config.name}] ${names.length} effects selected, HomeKit only supports ${MAX_INPUTS} inputs; truncating. ` +
          'Pick at most ' + MAX_SELECTABLE_EFFECTS + ' in the plugin settings to choose which ones.',
      );
      names = names.slice(0, MAX_INPUTS);
    }
    this.visibleIdentifiers = new Set(names.map((n) => this.device.identifierForName(n)));

    const desiredSubtypes = new Set(names.map(subtypeForEffect));

    // Remove stale InputSource services *before* adding new ones. Matters
    // both when the list shrinks and, critically, when migrating from an
    // older version of this plugin that used positional subtypes
    // ("effect-1") instead of name-based ones ("effect-normal-light"): the
    // old and new services don't match by getServiceById, so adding all the
    // new ones before clearing the old ones would transiently exceed HAP's
    // 100-services-per-accessory cap.
    for (const svc of [...this.accessory.services]) {
      if (svc.UUID === Svc.InputSource.UUID && (!svc.subtype || !desiredSubtypes.has(svc.subtype))) {
        this.service.removeLinkedService(svc);
        this.accessory.removeService(svc);
      }
    }

    names.forEach((name) => {
      const identifier = this.device.identifierForName(name);
      const subtype = subtypeForEffect(name);
      const input =
        this.accessory.getServiceById(Svc.InputSource, subtype) ?? this.accessory.addService(Svc.InputSource, name, subtype);

      input
        .setCharacteristic(Characteristic.Identifier, identifier)
        .setCharacteristic(Characteristic.ConfiguredName, name)
        .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.APPLICATION)
        .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);

      this.service.addLinkedService(input);
    });

    // Home (and other HomeKit controllers) don't reliably fall back to service
    // creation order for the Inputs list; without an explicit DisplayOrder they
    // can show inputs in an arbitrary order even though Identifier->name mapping
    // stays correct. This is purely a *display* order and can freely differ
    // from the (stable) Identifier values themselves.
    const order = names.map((name) => this.device.identifierForName(name));
    this.service.updateCharacteristic(Characteristic.DisplayOrder, encodeDisplayOrder(order));

    this.appliedEffectNames = namesIn;
    this.persistCatalog();
  }

  /**
   * Applies the user's per-device selection. An empty selection means "all
   * of them" - the default, and what every install had before this existed.
   * "Normal Light" is index 0 and always survives: it is not a Govee effect
   * but the way out of effect mode.
   *
   * Note this filters the *services*, never the catalog. Identifiers stay
   * assigned across the full list, so hiding an effect and showing it again
   * later gives it back the same number and Home's own input cache stays in
   * step (see GoveeDevice.identifierForName).
   */
  private selectVisible(all: string[]): string[] {
    const wanted = this.device.config.visibleEffects;
    if (!wanted || wanted.length === 0) {
      return all;
    }
    const keep = new Set(wanted);
    return all.filter((name, index) => index === 0 || keep.has(name));
  }

  /**
   * HomeKit's ActiveIdentifier has to name an input that exists. The device
   * can report an effect the user chose to hide - set from the Govee app, or
   * by a scene - so what gets pushed falls back to "Normal Light" when the
   * running effect has no InputSource. Only the push is clamped: the cached
   * state keeps the real effect, so the plugin's own bookkeeping (the
   * re-assertion, backing out on a brightness change) is unaffected.
   */
  private clampIdentifier(identifier: number): number {
    return this.visibleIdentifiers.has(identifier) ? identifier : 1;
  }

  /**
   * Saves the effect list and its numbering so the next run can publish the
   * accessory in its final shape immediately. Only ever called with a real
   * list - persisting the fallback would defeat the point, and on the very
   * first run after upgrading there is nothing cached, so the catalog saved
   * is the one this run ended up with: the numbering Home already knows.
   * That is what keeps identifiers from shifting even once.
   */
  private persistCatalog(): void {
    if (!this.device.effectsDiscovered) {
      return;
    }
    const catalog = { deviceId: this.device.config.deviceId, ...this.device.effectCatalog() };
    const cached = this.accessory.context as EffectsContext;
    if (
      cached.effectNames?.length === catalog.effectNames.length &&
      cached.effectNames.every((n, i) => n === catalog.effectNames[i])
    ) {
      return;
    }
    this.accessory.context = catalog;
    this.platform.api.updatePlatformAccessories([this.accessory]);
    this.platform.log.debug(
      `[${this.device.config.name}] Cached ${catalog.effectNames.length - 1} effect(s) for the next restart`,
    );
  }
}
