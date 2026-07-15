import { PlatformAccessory } from 'homebridge';
import { GoveeGv2MqttPlatform } from './platform';
import { GoveeDevice } from './govee-device';

/**
 * A single Switch: turning it on snapshots whatever the light is currently
 * doing (including an active effect) and forces it to a fixed alert color;
 * turning it off restores the snapshot exactly. Meant for automations like
 * "flash red while the front door is open, then go back to whatever it was
 * doing" - deliberately a single on/off toggle (not a multi-step automation)
 * so it stays reliable via a Home Hub even when no phone is present. See
 * README for the door-sensor example this was built for.
 */
export class AlertAccessory {
  constructor(
    private readonly platform: GoveeGv2MqttPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: GoveeDevice,
  ) {
    const { Service: Svc, Characteristic } = this.platform;

    accessory
      .getService(Svc.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Govee')
      .setCharacteristic(Characteristic.Model, 'gv2mqtt Alert')
      .setCharacteristic(Characteristic.SerialNumber, `${device.config.deviceId}-alert`);

    const service = accessory.getService(Svc.Switch) ?? accessory.addService(Svc.Switch, `${device.config.name} Alert`);
    service.setCharacteristic(Characteristic.Name, `${device.config.name} Alert`);

    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.device.getState().alertActive)
      .onSet((value) => {
        if (value) {
          this.device.triggerAlert(device.config.alertHue, device.config.alertSaturation, device.config.alertBrightness);
        } else {
          this.device.restoreSnapshot();
        }
      });

    device.on('change', (state) => {
      service.updateCharacteristic(Characteristic.On, state.alertActive);
    });
  }
}
