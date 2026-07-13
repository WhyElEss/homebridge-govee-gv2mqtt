import { PlatformAccessory, Service } from 'homebridge';
import { GoveeGv2MqttPlatform } from './platform';
import { GoveeDevice } from './govee-device';
import { EFFECT_NAMES } from './effects';

/**
 * Exposes Govee's built-in scene effects as a Television accessory's "Inputs",
 * mirroring the original mqttthing hack: HomeKit's Lightbulb service has no
 * concept of named effects, but Television/InputSource does.
 */
export class EffectsAccessory {
  private readonly service: Service;

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

    EFFECT_NAMES.forEach((name, i) => {
      const identifier = i + 1;
      const subtype = `effect-${identifier}`;
      const input = accessory.getServiceById(Svc.InputSource, subtype) ?? accessory.addService(Svc.InputSource, name, subtype);

      input
        .setCharacteristic(Characteristic.Identifier, identifier)
        .setCharacteristic(Characteristic.ConfiguredName, name)
        .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.APPLICATION)
        .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);

      this.service.addLinkedService(input);
    });

    device.on('change', (state) => {
      this.service.updateCharacteristic(Characteristic.Active, state.isOn ? 1 : 0);
      this.service.updateCharacteristic(Characteristic.ActiveIdentifier, state.effectIndex);
    });
  }
}
