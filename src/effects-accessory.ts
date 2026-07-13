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

function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\w]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'input'
  );
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
export class EffectsAccessory {
  private readonly service: Service;
  private appliedEffectNames: string[] | null = null;

  constructor(
    private readonly platform: GoveeGv2MqttPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: GoveeDevice,
  ) {
    const { Service: Svc, Characteristic } = this.platform;

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
      .onSet((value) => this.device.setOn(!!value));

    this.service
      .getCharacteristic(Characteristic.ActiveIdentifier)
      .onGet(() => this.device.getState().effectIndex)
      .onSet((value) => this.device.setEffectIndex(value as number));

    this.syncInputs(device.getState().effectNames);

    device.on('change', (state) => {
      this.service.updateCharacteristic(Characteristic.Active, state.isOn ? 1 : 0);
      this.service.updateCharacteristic(Characteristic.ActiveIdentifier, state.effectIndex);
      if (state.effectNames !== this.appliedEffectNames) {
        this.syncInputs(state.effectNames);
      }
    });
  }

  private syncInputs(namesIn: string[]): void {
    const { Service: Svc, Characteristic } = this.platform;

    let names = namesIn;
    if (names.length > MAX_INPUTS) {
      this.platform.log.warn(
        `[${this.device.config.name}] ${names.length} effects discovered, HomeKit only supports ${MAX_INPUTS} inputs; truncating.`,
      );
      names = names.slice(0, MAX_INPUTS);
    }

    const desiredSubtypes = new Set(names.map((name) => `effect-${slugify(name)}`));

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
      const subtype = `effect-${slugify(name)}`;
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
  }
}
