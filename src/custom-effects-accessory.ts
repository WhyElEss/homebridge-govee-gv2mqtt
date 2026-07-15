import { PlatformAccessory, Service } from 'homebridge';
import { GoveeGv2MqttPlatform } from './platform';
import { GoveeDevice } from './govee-device';
import { H6022Lan } from './h6022-effects';

export const EFFECT_POLICE_STROBO = 'Police Strobo';
export const EFFECT_STORM = 'Гроза в банке';

/**
 * Two Switches for LAN-driven custom effects that Govee's cloud API cannot
 * express, sent straight to the lamp over UDP (see H6022Lan). Both are DIY
 * matrix scenes the lamp's own firmware animates after a one-shot upload:
 *
 *   - "Police Strobo": blue/red halves swapping around a white divider
 *     (a two-frame carousel);
 *   - "Гроза в банке": a storm cloud with falling rain and lightning.
 *
 * H6022-only: the matrix-scene byte format and the strobe assumptions are
 * specific to the Table Lamp 2, so activation is refused until gv2mqtt's
 * discovery config confirms the device model is H6022. Turning a switch on
 * snapshots the lamp's state exactly like the Alert switch does; turning it
 * off restores that snapshot (over MQTT/gv2mqtt as usual). The switches are
 * mutually exclusive - starting one stops the other.
 */
export class CustomEffectsAccessory {
  private readonly lan: H6022Lan;
  private readonly stroboService: Service;
  private readonly stormService: Service;

  constructor(
    private readonly platform: GoveeGv2MqttPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: GoveeDevice,
  ) {
    const { Service: Svc, Characteristic } = this.platform;

    this.lan = new H6022Lan(device.config.deviceId, device.config.lanIp, device.config.name, platform.log);

    accessory
      .getService(Svc.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Govee')
      .setCharacteristic(Characteristic.Model, 'gv2mqtt Custom Effects')
      .setCharacteristic(Characteristic.SerialNumber, `${device.config.deviceId}-custom-effects`);

    this.stroboService = this.addSwitch(EFFECT_POLICE_STROBO, 'police-strobo', () => this.lan.startPoliceStrobo());
    this.stormService = this.addSwitch(EFFECT_STORM, 'storm-jar', () => this.lan.startStorm());

    device.on('change', (state) => {
      this.stroboService.updateCharacteristic(Characteristic.On, state.customEffect === EFFECT_POLICE_STROBO);
      this.stormService.updateCharacteristic(Characteristic.On, state.customEffect === EFFECT_STORM);
    });
  }

  private addSwitch(effectName: string, subtype: string, start: () => void): Service {
    const { Service: Svc, Characteristic } = this.platform;
    const service =
      this.accessory.getServiceById(Svc.Switch, subtype) ?? this.accessory.addService(Svc.Switch, effectName, subtype);
    service.setCharacteristic(Characteristic.Name, effectName);
    // ConfiguredName lets the Home app show per-switch names inside the
    // combined accessory tile; it's not part of HAP's Switch definition, so
    // declare it as optional first to avoid a HAP-NodeJS warning at startup.
    service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    service.setCharacteristic(Characteristic.ConfiguredName, effectName);

    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.device.getState().customEffect === effectName)
      .onSet(async (value) => {
        if (value) {
          await this.activate(effectName, service, start);
        } else if (this.device.getState().customEffect === effectName) {
          this.device.stopCustomEffect();
        }
      });
    return service;
  }

  private async activate(effectName: string, service: Service, start: () => void): Promise<void> {
    const { sku } = this.device.getState();
    if (sku !== 'H6022') {
      this.platform.log.warn(
        `[${this.device.config.name}] "${effectName}" is only available for the H6022 Table Lamp 2 ` +
          (sku
            ? `but gv2mqtt reports this device as ${sku}; not activating.`
            : 'and the device model has not been confirmed by gv2mqtt discovery yet; try again in a few seconds.'),
      );
      this.revertSwitch(service);
      return;
    }

    // Usually instant (the IP is discovered at startup and cached); only
    // blocks on a fresh LAN scan when nothing is known yet.
    const ip = await this.lan.ensureTarget();
    if (!ip) {
      this.platform.log.warn(
        `[${this.device.config.name}] "${effectName}" not activated: the lamp's IP is unknown ` +
          '(LAN scan found nothing and no lanIp fallback is configured).',
      );
      this.revertSwitch(service);
      return;
    }

    this.device.startCustomEffect(effectName);
    start();
  }

  /**
   * HomeKit assumes a write succeeded the moment onSet returns; when
   * activation is refused, push the real (off) state back shortly after so
   * the switch doesn't stay stuck on.
   */
  private revertSwitch(service: Service): void {
    setTimeout(() => service.updateCharacteristic(this.platform.Characteristic.On, false), 100);
  }
}
