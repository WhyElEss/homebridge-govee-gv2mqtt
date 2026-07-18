import { PlatformAccessory, Service } from 'homebridge';
import { GoveeGv2MqttPlatform } from './platform';
import { GoveeDevice } from './govee-device';

/**
 * Lightbulb accessory: On/Off, Brightness, Hue/Saturation, Color Temperature
 * and (optionally) Adaptive Lighting for a single physical Govee device.
 */
export class LightAccessory {
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
      .setCharacteristic(Characteristic.Model, 'gv2mqtt Light')
      .setCharacteristic(Characteristic.SerialNumber, device.config.deviceId);

    this.service = accessory.getService(Svc.Lightbulb) ?? accessory.addService(Svc.Lightbulb, device.config.name);
    this.service.setCharacteristic(Characteristic.Name, device.config.name);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.device.getState().isOn)
      .onSet((value) => this.device.setOn(value as boolean));

    this.service
      .getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.device.getState().brightness)
      .onSet((value) => this.device.setBrightness(value as number));

    this.service
      .getCharacteristic(Characteristic.Hue)
      .onGet(() => this.device.getState().hue)
      .onSet((value) => this.device.setHue(value as number));

    this.service
      .getCharacteristic(Characteristic.Saturation)
      .onGet(() => this.device.getState().saturation)
      .onSet((value) => this.device.setSaturation(value as number));

    this.service
      .getCharacteristic(Characteristic.ColorTemperature)
      .setProps({ minValue: device.config.minMireds, maxValue: device.config.maxMireds })
      .onGet(() => this.device.getState().mireds)
      // AdaptiveLightingController invokes this SET handler directly (with
      // `{ controller, omitEventUpdate }` as the context argument) for its
      // periodic nudges - and keeps doing so even while the light is off.
      // Writes coming from HomeKit itself (user dragging the temperature
      // slider) arrive without that context, so this is how GoveeDevice
      // tells an automatic background nudge apart from a deliberate change.
      .onSet((value, context) => {
        const fromAdaptiveLighting =
          typeof context === 'object' && context !== null && 'controller' in context;
        this.device.setColorTemperature(value as number, fromAdaptiveLighting);
      });

    if (device.config.adaptiveLighting) {
      // getService()/addService() are typed to return the generic `Service` base
      // class rather than the specific `Lightbulb` subclass that
      // AdaptiveLightingController's constructor expects, hence the cast.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const controller = new this.platform.api.hap.AdaptiveLightingController(this.service as any);
      accessory.configureController(controller);

      // In the controller's AUTOMATIC mode HAP-NodeJS emits no event when
      // iOS (re)writes the transition (the UPDATE event exists only in
      // MANUAL mode), but handleActiveTransitionUpdated always pushes a "1"
      // through ActiveTransitionCount via sendEventNotification - which
      // does emit an observable CHANGE event. That's the only available
      // signal that a scene/automation just deliberately (re)enabled
      // Adaptive Lighting, as opposed to the background color-temperature
      // nudges the controller keeps firing regardless of the lamp's mode.
      // A transition restored from cache at startup sets the value directly
      // without a notification, so this can't fire spuriously on boot.
      this.service
        .getCharacteristic(Characteristic.CharacteristicValueActiveTransitionCount)
        .on('change', (change) => {
          if (change.newValue) {
            this.device.noteAdaptiveLightingConfigured();
          }
        });
    }

    device.on('change', (state) => {
      this.service.updateCharacteristic(Characteristic.On, state.isOn);
      this.service.updateCharacteristic(Characteristic.Brightness, state.brightness);
      this.service.updateCharacteristic(Characteristic.Hue, state.hue);
      this.service.updateCharacteristic(Characteristic.Saturation, state.saturation);
      this.service.updateCharacteristic(Characteristic.ColorTemperature, state.mireds);
    });
  }
}
