import * as fs from 'fs';
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
import {
  DeviceConfig,
  GoveePlatformConfig,
  resolveDeviceConfig,
  ResolvedDeviceConfig,
  resolvePlatformConfig,
  ResolvedPlatformConfig,
} from './config';
import { GoveeDevice } from './govee-device';
import { LightAccessory } from './light-accessory';
import { EffectsAccessory } from './effects-accessory';
import { AlertAccessory } from './alert-accessory';
import { CustomEffectsAccessory } from './custom-effects-accessory';

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
  /** Platform-level config with all defaults applied. */
  private readonly settings: ResolvedPlatformConfig;
  private client?: MqttClient;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.settings = resolvePlatformConfig(config as GoveePlatformConfig);

    this.api.on('didFinishLaunching', () => {
      this.connectAndDiscover();
    });
  }

  /** Called by Homebridge once per cached accessory before didFinishLaunching. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private connectAndDiscover(): void {
    const cfg = this.settings;

    if (!cfg.mqttUrl) {
      this.log.error('"mqttUrl" is not configured; cannot connect to the MQTT broker.');
      return;
    }
    if (cfg.devices.length === 0 && !cfg.autoDiscover) {
      this.log.warn('No devices configured and autoDiscover is off; nothing to expose.');
    }

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
      this.client!.publish(cfg.haStatusTopic, 'online');
    };

    this.client.on('connect', () => {
      this.log.info(`Connected to MQTT broker at ${cfg.mqttUrl}`);
      if (cfg.refreshStateOnConnect) {
        pingHomeAssistantBirth();
      }
    });
    this.client.on('error', (err) => this.log.error(`MQTT error: ${err.message}`));
    this.client.on('reconnect', () => this.log.debug('Reconnecting to MQTT broker...'));

    if (cfg.refreshStateOnConnect && cfg.periodicRefreshIntervalMs > 0) {
      setInterval(() => pingHomeAssistantBirth(), cfg.periodicRefreshIntervalMs);
    }

    // A newly auto-discovered device's own GoveeDevice subscribes to its
    // discovery-config topic *after* this burst of messages already went by,
    // so it starts out on the fallback effect list. Ping again shortly after
    // discovery quiets down so it picks up its real list without waiting for
    // the next reconnect/periodic refresh. Debounced so a whole burst of new
    // devices only triggers one extra ping.
    let rediscoveryPingTimer: NodeJS.Timeout | undefined;
    const scheduleFollowUpPing = () => {
      if (!cfg.refreshStateOnConnect) {
        return;
      }
      if (rediscoveryPingTimer) {
        clearTimeout(rediscoveryPingTimer);
      }
      rediscoveryPingTimer = setTimeout(() => pingHomeAssistantBirth(), 3000);
    };

    for (const deviceCfg of cfg.devices) {
      const resolved = resolveDeviceConfig(deviceCfg, cfg.topicPrefix, cfg.haDiscoveryPrefix);
      this.knownDeviceIds.add(deviceCfg.deviceId);
      if (!resolved.enabled) {
        this.log.info(`"${resolved.name}" (${resolved.deviceId}) is disabled; not exposing it.`);
        continue;
      }
      this.registerDevice(resolved);
    }

    if (cfg.autoDiscover) {
      this.setupAutoDiscovery(scheduleFollowUpPing);
    }

    // With autoDiscover, newly-found devices only show up asynchronously as
    // MQTT discovery messages arrive (typically within ~15s of the birth
    // ping above), so pruning immediately would delete their just-restored
    // cached accessories before we've had a chance to reconfirm them. Delay
    // pruning to give that a chance to happen first; without autoDiscover,
    // the expected device set is fully known synchronously, so prune right
    // away as before.
    const pruneDelayMs = cfg.autoDiscover ? 20000 : 0;
    setTimeout(() => this.pruneStaleAccessories(cfg.devices), pruneDelayMs);
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
   *
   * Newly-found devices are both registered in-memory and persisted into
   * this platform's `devices` array in config.json, so they show up in
   * Config UI X's normal settings form exactly as if added by hand - from
   * then on they're "explicit" and autoDiscover leaves them alone.
   */
  private setupAutoDiscovery(scheduleFollowUpPing: () => void): void {
    const { topicPrefix, haDiscoveryPrefix } = this.settings;
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
      if (segmentSuffix.test(deviceId) || this.knownDeviceIds.has(deviceId)) {
        return;
      }

      let name = deviceId;
      try {
        const parsed = JSON.parse(payload.toString());
        name = parsed?.device?.name || parsed?.name || deviceId;
      } catch {
        // Fall back to the raw device ID as the display name.
      }

      this.log.info(`autoDiscover: found new device "${name}" (${deviceId}), adding it to devices[] in config.json`);
      const resolved = resolveDeviceConfig({ deviceId, name }, topicPrefix, haDiscoveryPrefix);
      this.registerDevice(resolved);
      this.knownDeviceIds.add(deviceId);
      this.persistDiscoveredDevice(deviceId, name);
      scheduleFollowUpPing();
    });
  }

  /**
   * Appends a newly auto-discovered device to this platform's `devices`
   * array directly in config.json, so it appears in Config UI X's normal
   * settings form (name, deviceId, an Enabled checkbox, etc) exactly as if
   * the user had added it by hand. Not an officially supported way for a
   * platform to persist config - Homebridge only guarantees that for a real
   * Custom Plugin UI - so this re-reads and re-writes the whole file
   * defensively (skips if the device is already there) rather than caching
   * any in-memory copy, to minimize the window for clobbering a concurrent
   * edit made through Config UI X. Formatting/comments in the original file
   * are not preserved since the whole file is re-serialized.
   */
  private persistDiscoveredDevice(deviceId: string, name: string): void {
    const configPath = this.api.user.configPath();
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      const platforms: Record<string, unknown>[] = Array.isArray(parsed.platforms) ? parsed.platforms : [];
      const platformEntry = platforms.find(
        (p) => p.platform === PLATFORM_NAME && (this.config.name === undefined || p.name === this.config.name),
      );
      if (!platformEntry) {
        this.log.warn(`autoDiscover: could not find this platform's block in ${configPath} to persist "${name}"`);
        return;
      }

      const entryDevices: DeviceConfig[] = Array.isArray(platformEntry.devices)
        ? (platformEntry.devices as DeviceConfig[])
        : [];
      if (entryDevices.some((d) => d.deviceId === deviceId)) {
        return;
      }
      entryDevices.push({ name, deviceId });
      platformEntry.devices = entryDevices;

      const tmpPath = `${configPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 4));
      fs.renameSync(tmpPath, configPath);
      this.log.info(`autoDiscover: saved "${name}" (${deviceId}) to config.json`);
    } catch (err) {
      this.log.warn(
        `autoDiscover: failed to persist "${name}" (${deviceId}) to config.json: ${(err as Error).message}. ` +
          'It will still work this session, but will need rediscovering next restart.',
      );
    }
  }

  private registerDevice(resolved: ResolvedDeviceConfig): void {
    const device = new GoveeDevice(this.client!, resolved, this.settings.optimisticCacheMs, this.log);

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

    if (resolved.enableAlert) {
      this.addOrRestoreAccessory(
        `${resolved.deviceId}-alert`,
        `${resolved.name} Alert`,
        this.api.hap.Categories.SWITCH,
        (accessory) => new AlertAccessory(this, accessory, device),
      );
    }

    if (resolved.enableCustomEffects) {
      if (resolved.lanIp) {
        this.addOrRestoreAccessory(
          `${resolved.deviceId}-custom-effects`,
          `${resolved.name} Custom Effects`,
          this.api.hap.Categories.SWITCH,
          (accessory) => new CustomEffectsAccessory(this, accessory, device),
        );
      } else {
        this.log.warn(
          `[${resolved.name}] enableCustomEffects is on but lanIp is not set; ` +
            'the Custom Effects accessory needs the lamp\'s local IP address to work, so it is not exposed.',
        );
      }
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
      const cfg = deviceConfigById.get(id);
      if (cfg && cfg.enabled === false) {
        continue;
      }
      expectedUuids.add(this.api.hap.uuid.generate(`${PLUGIN_NAME}:${id}-light`));
      if (cfg?.enableEffects ?? true) {
        expectedUuids.add(this.api.hap.uuid.generate(`${PLUGIN_NAME}:${id}-effects`));
      }
      if (cfg?.enableAlert ?? false) {
        expectedUuids.add(this.api.hap.uuid.generate(`${PLUGIN_NAME}:${id}-alert`));
      }
      if ((cfg?.enableCustomEffects ?? false) && cfg?.lanIp) {
        expectedUuids.add(this.api.hap.uuid.generate(`${PLUGIN_NAME}:${id}-custom-effects`));
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
