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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class GoveeGv2MqttPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** Cached accessories restored from disk, keyed by UUID, plus any newly registered. */
  private readonly accessories = new Map<string, PlatformAccessory>();
  /** Device IDs registered so far this run, whether from config or auto-discovery. */
  private readonly knownDeviceIds = new Set<string>();
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
    const autoDiscover = cfg.autoDiscover ?? false;
    const excludedDeviceIds = new Set(cfg.excludedDeviceIds ?? []);
    if (devices.length === 0 && !autoDiscover) {
      this.log.warn('No devices configured and autoDiscover is off; nothing to expose.');
    }

    const refreshStateOnConnect = cfg.refreshStateOnConnect ?? true;
    const haDiscoveryPrefix = cfg.haDiscoveryPrefix ?? 'homeassistant';
    const haStatusTopic = cfg.haStatusTopic ?? `${haDiscoveryPrefix}/status`;
    const periodicRefreshIntervalMs = cfg.periodicRefreshIntervalMs ?? 0;
    const topicPrefix = cfg.topicPrefix ?? 'gv2mqtt/light';
    const optimisticCacheMs = cfg.optimisticCacheMs ?? 10000;

    this.client = mqtt.connect(cfg.mqttUrl, {
      username: cfg.mqttUsername,
      password: cfg.mqttPassword,
    });

    const pingHomeAssistantBirth = () => {
      // gv2mqtt doesn't retain its state or discovery-config topics, so a
      // fresh subscribe alone reveals neither a light's actual current state,
      // its real per-device effect list, nor (with autoDiscover) which
      // devices even exist. It does, however, republish full discovery
      // config + state for every device whenever it sees a message on the
      // Home Assistant "birth" topic (thinking HA just restarted) - so we
      // piggyback on that for all three instead of waiting indefinitely.
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

    if (refreshStateOnConnect && periodicRefreshIntervalMs > 0) {
      setInterval(() => pingHomeAssistantBirth(), periodicRefreshIntervalMs);
    }

    // A newly auto-discovered device's own GoveeDevice subscribes to its
    // discovery-config topic *after* this burst of messages already went by,
    // so it starts out on the fallback effect list. Ping again shortly after
    // discovery quiets down so it picks up its real list without waiting for
    // the next reconnect/periodic refresh. Debounced so a whole burst of new
    // devices only triggers one extra ping.
    let rediscoveryPingTimer: NodeJS.Timeout | undefined;
    const scheduleFollowUpPing = () => {
      if (!refreshStateOnConnect) {
        return;
      }
      if (rediscoveryPingTimer) {
        clearTimeout(rediscoveryPingTimer);
      }
      rediscoveryPingTimer = setTimeout(() => pingHomeAssistantBirth(), 3000);
    };

    for (const deviceCfg of devices) {
      if (excludedDeviceIds.has(deviceCfg.deviceId)) {
        this.log.warn(
          `"${deviceCfg.name}" (${deviceCfg.deviceId}) is both listed in devices and in excludedDeviceIds; excluding it.`,
        );
        continue;
      }
      const resolved = resolveDeviceConfig(deviceCfg, topicPrefix, haDiscoveryPrefix);
      this.registerDevice(resolved, optimisticCacheMs);
      this.knownDeviceIds.add(deviceCfg.deviceId);
    }

    if (autoDiscover) {
      this.setupAutoDiscovery(topicPrefix, haDiscoveryPrefix, optimisticCacheMs, excludedDeviceIds, scheduleFollowUpPing);
    }

    // With autoDiscover, newly-found devices only show up asynchronously as
    // MQTT discovery messages arrive (typically within ~15s of the birth
    // ping above), so pruning immediately would delete their just-restored
    // cached accessories before we've had a chance to reconfirm them. Delay
    // pruning to give that a chance to happen first; without autoDiscover,
    // the expected device set is fully known synchronously, so prune right
    // away as before.
    const pruneDelayMs = autoDiscover ? 20000 : 0;
    setTimeout(() => this.pruneStaleAccessories(devices), pruneDelayMs);
  }

  /**
   * Subscribes to the wildcard form of the per-device Home Assistant MQTT
   * discovery config topic (see resolveDeviceConfig's discoveryConfigTopic)
   * to learn which Govee devices exist on this gv2mqtt bridge without the
   * user having to list every deviceId by hand. The regex both extracts the
   * device ID from the topic and filters out unrelated MQTT lights that
   * might share the same broker/discovery prefix but weren't published by
   * gv2mqtt (their unique_id won't match "gv2mqtt-<id>").
   *
   * gv2mqtt also publishes one extra discovery config per addressable LED
   * segment on segmented devices, with a unique_id of "gv2mqtt-<id>-<n>" -
   * these are sub-entities of a device already covered by its main config,
   * not separate physical devices, and are skipped (real device IDs are
   * plain hex with no hyphen, so a trailing "-<digits>" is unambiguous).
   */
  private setupAutoDiscovery(
    topicPrefix: string,
    haDiscoveryPrefix: string,
    optimisticCacheMs: number,
    excludedDeviceIds: Set<string>,
    scheduleFollowUpPing: () => void,
  ): void {
    const topicPattern = new RegExp(`^${escapeRegExp(haDiscoveryPrefix)}/light/gv2mqtt-([^/]+)/config$`);
    const segmentSuffix = /-\d+$/;

    this.client!.subscribe(`${haDiscoveryPrefix}/light/+/config`, (err) => {
      if (err) {
        this.log.warn(`autoDiscover: failed to subscribe for new devices: ${err.message}`);
      }
    });

    this.client!.on('message', (topic, payload) => {
      const match = topicPattern.exec(topic);
      if (!match) {
        return;
      }
      const deviceId = match[1];
      if (segmentSuffix.test(deviceId)) {
        return;
      }
      if (excludedDeviceIds.has(deviceId) || this.knownDeviceIds.has(deviceId)) {
        return;
      }

      let name = deviceId;
      try {
        const parsed = JSON.parse(payload.toString());
        name = parsed?.device?.name || parsed?.name || deviceId;
      } catch {
        // Fall back to the raw device ID as the display name.
      }

      this.log.info(`autoDiscover: found new device "${name}" (${deviceId})`);
      const resolved = resolveDeviceConfig({ deviceId, name }, topicPrefix, haDiscoveryPrefix);
      this.registerDevice(resolved, optimisticCacheMs);
      this.knownDeviceIds.add(deviceId);
      scheduleFollowUpPing();
    });
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
    const deviceConfigById = new Map(devices.map((d) => [d.deviceId, d]));

    const expectedUuids = new Set<string>();
    for (const id of this.knownDeviceIds) {
      expectedUuids.add(this.api.hap.uuid.generate(`${PLUGIN_NAME}:${id}-light`));
      const enableEffects = deviceConfigById.get(id)?.enableEffects ?? true;
      if (enableEffects) {
        expectedUuids.add(this.api.hap.uuid.generate(`${PLUGIN_NAME}:${id}-effects`));
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
      this.log.info(`Removing ${stale.length} stale accessory(ies) no longer present in config or discovery.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
