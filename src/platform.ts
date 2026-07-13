import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import mqtt, { MqttClient } from 'mqtt';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { DeviceConfig, GoveePlatformConfig, resolveDeviceConfig, ResolvedDeviceConfig } from './config';
import { GoveeDevice } from './govee-device';
import { LightAccessory } from './light-accessory';
import { EffectsAccessory } from './effects-accessory';

export class GoveeGv2MqttPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** Cached accessories restored from disk, keyed by UUID, plus any newly registered. */
  private readonly accessories = new Map<string, PlatformAccessory>();
  private client?: MqttClient;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.api.on('didFinishLaunching', () => {
      this.connectAndDiscover();
    });
  }

  /** Called by Homebridge once per cached accessory before didFinishLaunching. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private connectAndDiscover(): void {
    const cfg = this.config as GoveePlatformConfig;

    if (!cfg.mqttUrl) {
      this.log.error('"mqttUrl" is not configured; cannot connect to the MQTT broker.');
      return;
    }
    const devices = cfg.devices ?? [];
    if (devices.length === 0) {
      this.log.warn('No devices configured for this platform.');
    }

    const refreshStateOnConnect = cfg.refreshStateOnConnect ?? true;
    const haDiscoveryPrefix = cfg.haDiscoveryPrefix ?? 'homeassistant';
    const haStatusTopic = cfg.haStatusTopic ?? `${haDiscoveryPrefix}/status`;
    const effectRefreshIntervalMs = cfg.effectRefreshIntervalMs ?? 0;

    this.client = mqtt.connect(cfg.mqttUrl, {
      username: cfg.mqttUsername,
      password: cfg.mqttPassword,
    });

    const pingHomeAssistantBirth = () => {
      // gv2mqtt doesn't retain its state or discovery-config topics, so a
      // fresh subscribe alone reveals neither the light's actual current
      // state nor its real per-device effect list after a restart. It does,
      // however, republish both for every device whenever it sees a message
      // on the Home Assistant "birth" topic (thinking HA just restarted) -
      // so we piggyback on that instead of showing stale/fallback data until
      // the light's next unrelated state change.
      this.client!.publish(haStatusTopic, 'online');
    };

    this.client.on('connect', () => {
      this.log.info(`Connected to MQTT broker at ${cfg.mqttUrl}`);
      if (refreshStateOnConnect) {
        pingHomeAssistantBirth();
      }
    });
    this.client.on('error', (err) => this.log.error(`MQTT error: ${err.message}`));
    this.client.on('reconnect', () => this.log.debug('Reconnecting to MQTT broker...'));

    if (refreshStateOnConnect && effectRefreshIntervalMs > 0) {
      setInterval(() => pingHomeAssistantBirth(), effectRefreshIntervalMs);
    }

    const topicPrefix = cfg.topicPrefix ?? 'gv2mqtt/light';
    const optimisticCacheMs = cfg.optimisticCacheMs ?? 10000;

    for (const deviceCfg of devices) {
      const resolved = resolveDeviceConfig(deviceCfg, topicPrefix, haDiscoveryPrefix);
      this.registerDevice(resolved, optimisticCacheMs);
    }

    this.pruneStaleAccessories(devices);
  }

  private registerDevice(resolved: ResolvedDeviceConfig, optimisticCacheMs: number): void {
    const device = new GoveeDevice(this.client!, resolved, optimisticCacheMs, this.log);

    this.addOrRestoreAccessory(
      `${resolved.deviceId}-light`,
      resolved.name,
      this.api.hap.Categories.LIGHTBULB,
      (accessory) => new LightAccessory(this, accessory, device),
    );

    if (resolved.enableEffects) {
      this.addOrRestoreAccessory(
        `${resolved.deviceId}-effects`,
        `${resolved.name} Effects`,
        this.api.hap.Categories.TELEVISION,
        (accessory) => new EffectsAccessory(this, accessory, device),
      );
    }
  }

  private addOrRestoreAccessory(
    key: string,
    displayName: string,
    category: number,
    build: (accessory: PlatformAccessory) => unknown,
  ): void {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${key}`);
    let accessory = this.accessories.get(uuid);

    if (accessory) {
      this.log.info(`Restoring cached accessory: ${displayName}`);
    } else {
      this.log.info(`Registering new accessory: ${displayName}`);
      accessory = new this.api.platformAccessory(displayName, uuid);
      accessory.category = category;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.accessories.set(uuid, accessory);
    build(accessory);
  }

  private pruneStaleAccessories(devices: DeviceConfig[]): void {
    const expectedUuids = new Set<string>();
    for (const d of devices) {
      expectedUuids.add(this.api.hap.uuid.generate(`${PLUGIN_NAME}:${d.deviceId}-light`));
      if (d.enableEffects ?? true) {
        expectedUuids.add(this.api.hap.uuid.generate(`${PLUGIN_NAME}:${d.deviceId}-effects`));
      }
    }

    const stale: PlatformAccessory[] = [];
    for (const [uuid, accessory] of this.accessories) {
      if (!expectedUuids.has(uuid)) {
        stale.push(accessory);
        this.accessories.delete(uuid);
      }
    }

    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessory(ies) no longer present in config.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
