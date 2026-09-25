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
import { GoveeHumidifier } from './humidifier';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The gv2mqtt entity kinds this plugin turns into accessories. */
type EntityKind = 'light' | 'humidifier';

/**
 * How long gv2mqtt may go without announcing a device we expose before its
 * accessories are taken out of HomeKit. Only counted while gv2mqtt is
 * demonstrably announcing other devices (see pruneUnannounced), so an outage
 * of gv2mqtt, the broker or Govee's API never removes anything.
 */
const REMOVE_UNANNOUNCED_AFTER_MS = 60 * 60 * 1000;
const PRUNE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Kept in the context of the accessories this plugin creates, so the settings
 * page (homebridge-ui/server.js) can tell which configured devices have any.
 */
interface DeviceContext {
  deviceId?: string;
  kind?: EntityKind;
}

/** One configured (or discovered) physical device and whatever runs for it. */
interface DeviceRuntime {
  resolved: ResolvedDeviceConfig;
  /**
   * Created at most once per run and kept even if the device's accessories are
   * pruned: they hold MQTT listeners, so a device that disappears and comes
   * back gets new accessories around the same instance.
   */
  light?: GoveeDevice;
  humidifier?: GoveeHumidifier;
  /** Which kinds currently have accessories in HomeKit. */
  exposed: Set<EntityKind>;
}

interface DiscoveryPayload {
  device?: { name?: unknown };
}

export class GoveeGv2MqttPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** Cached accessories restored from disk, keyed by UUID, plus any newly registered. */
  private readonly accessories = new Map<string, PlatformAccessory>();
  /** UUIDs of accessories set up this run; everything else in `accessories` is stale. */
  private readonly builtUuids = new Set<string>();
  /** Device IDs listed in config.json's devices[], enabled or not, plus any persisted this run. */
  private readonly knownDeviceIds = new Set<string>();
  private readonly runtimes = new Map<string, DeviceRuntime>();
  /** When gv2mqtt last announced each entity, keyed "<deviceId>:<kind>". */
  private readonly lastAnnounced = new Map<string, number>();
  /** When gv2mqtt last announced anything at all. */
  private lastAnyAnnouncement = 0;
  private readonly startedAt = Date.now();
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
      // fresh subscribe alone reveals neither a device's actual current
      // state, a light's real effect list, nor which devices even exist. It
      // does, however, republish full discovery config + state for every
      // device whenever it sees a message on the Home Assistant "birth" topic
      // (thinking HA just restarted) - so we piggyback on that for all three.
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

    // gv2mqtt re-reads the device list from Govee every 10 minutes, but a
    // device it learns about that way is announced to nobody: it publishes
    // discovery configs only at its own startup, on the birth topic, and on
    // purge-caches (wez/govee2mqtt src/commands/serve.rs, service/hass.rs).
    // Asking periodically is what lets a device added in the Govee app reach
    // HomeKit without restarting anything - and the steady stream of
    // announcements is also what lets pruneUnannounced notice one that's gone.
    if (cfg.refreshStateOnConnect && cfg.periodicRefreshIntervalMs > 0) {
      setInterval(() => pingHomeAssistantBirth(), cfg.periodicRefreshIntervalMs);
    }

    // A newly discovered device subscribes to its own topics *after* the burst
    // that revealed it has gone by. Ping again once the burst quiets down so it
    // gets its real state and effect list straight away. Debounced so a burst
    // of several new devices only triggers one extra ping.
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
      this.restoreDevice(this.createRuntime(resolved));
    }

    this.setupDiscovery(scheduleFollowUpPing);

    // With autoDiscover, newly-found devices only show up asynchronously as
    // MQTT discovery messages arrive (typically within ~15s of the birth
    // ping above), so pruning immediately would delete their just-restored
    // cached accessories before we've had a chance to reconfirm them.
    const pruneDelayMs = cfg.autoDiscover ? 20000 : 0;
    setTimeout(() => this.pruneUnbuilt(), pruneDelayMs);

    setInterval(() => this.pruneUnannounced(), PRUNE_CHECK_INTERVAL_MS);
  }

  private createRuntime(resolved: ResolvedDeviceConfig): DeviceRuntime {
    const runtime: DeviceRuntime = { resolved, exposed: new Set() };
    this.runtimes.set(resolved.deviceId, runtime);
    return runtime;
  }

  private uuidFor(key: string): string {
    return this.api.hap.uuid.generate(`${PLUGIN_NAME}:${key}`);
  }

  /**
   * Sets up at startup whatever this device had in HomeKit last run, before
   * gv2mqtt has said anything - the discovery burst is ~17s away and HomeKit
   * should not see accessories vanish and come back in the meantime. A device
   * with nothing cached (added by hand) starts as a light, as it always has.
   */
  private restoreDevice(runtime: DeviceRuntime): void {
    const id = runtime.resolved.deviceId;
    if (this.accessories.has(this.uuidFor(`${id}-humidifier`))) {
      this.exposeHumidifier(runtime);
    } else {
      this.exposeLight(runtime);
    }
  }

  /**
   * Watches gv2mqtt's Home Assistant discovery configs for light and
   * humidifier entities. The topic is literally
   * "{prefix}/{integration}/{unique_id}/config" (gv2mqtt's
   * publish_entity_config); a light's unique_id is "gv2mqtt-<id>", a
   * humidifier's "gv2mqtt-<id>-humidifier". Anything else sharing the broker
   * and prefix doesn't match and is ignored.
   *
   * gv2mqtt also publishes one extra light config per addressable LED segment
   * on segmented devices, "gv2mqtt-<id>-<n>" - sub-entities of a device
   * already covered by its main config, skipped (real device IDs are plain hex
   * with no hyphen, so a trailing "-<digits>" is unambiguous).
   *
   * Every announcement is recorded for pruneUnannounced. With autoDiscover, a
   * device seen for the first time is also exposed and persisted into this
   * platform's devices[] in config.json, so it shows up in the settings page
   * exactly as if added by hand - from then on it's "explicit".
   */
  private setupDiscovery(scheduleFollowUpPing: () => void): void {
    const prefix = escapeRegExp(this.settings.haDiscoveryPrefix);
    const lightTopic = new RegExp(`^${prefix}/light/gv2mqtt-([^/]+)/config$`);
    const humidifierTopic = new RegExp(`^${prefix}/humidifier/gv2mqtt-([^/-]+)-humidifier/config$`);
    const segmentSuffix = /-\d+$/;

    for (const kind of ['light', 'humidifier']) {
      this.client!.subscribe(`${this.settings.haDiscoveryPrefix}/${kind}/+/config`, (err) => {
        if (err) {
          this.log.warn(`discovery: failed to subscribe to ${kind} configs: ${err.message}`);
        }
      });
    }

    this.client!.on('message', (topic, payload) => {
      let kind: EntityKind;
      let match = lightTopic.exec(topic);
      if (match) {
        if (segmentSuffix.test(match[1])) {
          return;
        }
        kind = 'light';
      } else {
        match = humidifierTopic.exec(topic);
        if (!match) {
          return;
        }
        kind = 'humidifier';
      }
      let parsed: DiscoveryPayload = {};
      try {
        parsed = JSON.parse(payload.toString()) ?? {};
      } catch {
        // Still an announcement; the name falls back below.
      }
      this.onAnnouncement(kind, match[1], parsed, scheduleFollowUpPing);
    });
  }

  private onAnnouncement(
    kind: EntityKind,
    deviceId: string,
    parsed: DiscoveryPayload,
    scheduleFollowUpPing: () => void,
  ): void {
    const now = Date.now();
    this.lastAnyAnnouncement = now;
    this.lastAnnounced.set(`${deviceId}:${kind}`, now);

    let runtime = this.runtimes.get(deviceId);
    if (!runtime) {
      if (this.knownDeviceIds.has(deviceId) || !this.settings.autoDiscover) {
        return; // disabled in config, or not on the allowlist
      }
      const name = typeof parsed.device?.name === 'string' && parsed.device.name ? parsed.device.name : deviceId;
      this.log.info(`autoDiscover: found new device "${name}" (${deviceId}), adding it to devices[] in config.json`);
      this.knownDeviceIds.add(deviceId);
      this.persistDiscoveredDevice(deviceId, name);
      const { topicPrefix, haDiscoveryPrefix } = this.settings;
      runtime = this.createRuntime(resolveDeviceConfig({ name, deviceId }, topicPrefix, haDiscoveryPrefix));
      scheduleFollowUpPing();
    }

    // gv2mqtt announces a humidifier's night light as a light entity too; that
    // light is a service of the humidifier's own accessory instead.
    const isHumidifier = runtime.exposed.has('humidifier') || this.lastAnnounced.has(`${deviceId}:humidifier`);
    if ((kind === 'light' && isHumidifier) || runtime.exposed.has(kind)) {
      return;
    }
    if (runtime.light || runtime.humidifier) {
      this.log.info(`"${runtime.resolved.name}" (${deviceId}): gv2mqtt announces its ${kind}, adding it to HomeKit`);
    }
    if (kind === 'light') {
      this.exposeLight(runtime);
    } else {
      this.exposeHumidifier(runtime);
    }
  }

  private exposeLight(runtime: DeviceRuntime): void {
    const resolved = runtime.resolved;
    const id = resolved.deviceId;
    if (!runtime.light) {
      runtime.light = new GoveeDevice(this.client!, resolved, this.settings.optimisticCacheMs, this.log);
    }
    const device = runtime.light;

    const light = this.addOrRestoreAccessory(
      `${id}-light`,
      resolved.name,
      this.api.hap.Categories.LIGHTBULB,
      (accessory) => new LightAccessory(this, accessory, device),
    );
    this.writeContext(light, { deviceId: id, kind: 'light' });

    if (resolved.enableEffects) {
      this.addOrRestoreAccessory(
        `${id}-effects`,
        `${resolved.name} Effects`,
        this.api.hap.Categories.TELEVISION,
        (accessory) => new EffectsAccessory(this, accessory, device),
      );
    }

    if (resolved.enableAlert) {
      this.addOrRestoreAccessory(
        `${id}-alert`,
        `${resolved.name} Alert`,
        this.api.hap.Categories.SWITCH,
        (accessory) => new AlertAccessory(this, accessory, device),
      );
    }
    runtime.exposed.add('light');
  }

  private exposeHumidifier(runtime: DeviceRuntime): void {
    const id = runtime.resolved.deviceId;
    if (!runtime.humidifier) {
      runtime.humidifier = new GoveeHumidifier(this, this.client!, runtime.resolved, this.settings.optimisticCacheMs, this.log);
    }
    const humidifier = runtime.humidifier;
    const accessory = this.addOrRestoreAccessory(
      `${id}-humidifier`,
      runtime.resolved.name,
      this.api.hap.Categories.AIR_HUMIDIFIER,
      (acc) => humidifier.attach(acc),
    );
    this.writeContext(accessory, { deviceId: id, kind: 'humidifier' });
    runtime.exposed.add('humidifier');

    // A light set up before gv2mqtt revealed this is a humidifier (a device
    // added by hand, or its light config coming first in the burst) goes: the
    // night light is part of this accessory.
    if (runtime.exposed.has('light')) {
      this.unregister([`${id}-light`, `${id}-effects`, `${id}-alert`].map((k) => this.uuidFor(k)));
      runtime.exposed.delete('light');
    }
  }

  /** Persists a context only when it actually changed, so a restart writes nothing. */
  private writeContext(accessory: PlatformAccessory, context: DeviceContext): void {
    const merged = { ...accessory.context, ...context };
    if (JSON.stringify(accessory.context) === JSON.stringify(merged)) {
      return;
    }
    accessory.context = merged;
    this.api.updatePlatformAccessories([accessory]);
  }

  /**
   * Appends a newly auto-discovered device to this platform's `devices`
   * array directly in config.json, so it appears in the settings page (name,
   * deviceId, an Enabled checkbox, etc) exactly as if the user had added it
   * by hand. Re-reads and re-writes the whole file defensively (skips if the
   * device is already there) rather than caching any in-memory copy, to
   * minimize the window for clobbering a concurrent edit made through the
   * UI. Formatting/comments in the original file are not preserved since the
   * whole file is re-serialized.
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

  private addOrRestoreAccessory(
    key: string,
    displayName: string,
    category: number,
    build: (accessory: PlatformAccessory) => unknown,
  ): PlatformAccessory {
    const uuid = this.uuidFor(key);
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
    this.builtUuids.add(uuid);
    build(accessory);
    return accessory;
  }

  /** Cached accessories nothing claimed this run: devices removed from config, disabled, or features turned off. */
  private pruneUnbuilt(): void {
    const stale = [...this.accessories.keys()].filter((uuid) => !this.builtUuids.has(uuid));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessory(ies) no longer present in config or discovery.`);
      this.unregister(stale);
    }
  }

  /**
   * Takes out of HomeKit whatever gv2mqtt has stopped announcing - a device
   * removed from the Govee account. gv2mqtt keeps every device it has seen
   * until it restarts, so this happens after its next restart, not the moment
   * the device is removed.
   *
   * Only judged while announcements are demonstrably flowing: periodic
   * refresh must be on, and gv2mqtt must have announced *something* within
   * the last two refresh intervals. Otherwise silence says nothing about any
   * one device. The devices[] entry stays, so its settings come back if the
   * device is ever added again.
   */
  private pruneUnannounced(): void {
    const { refreshStateOnConnect, periodicRefreshIntervalMs } = this.settings;
    const now = Date.now();
    if (!refreshStateOnConnect || periodicRefreshIntervalMs <= 0) {
      return;
    }
    if (now - this.lastAnyAnnouncement > 2 * periodicRefreshIntervalMs + 60000) {
      return;
    }
    for (const runtime of this.runtimes.values()) {
      for (const kind of [...runtime.exposed]) {
        const id = runtime.resolved.deviceId;
        const last = this.lastAnnounced.get(`${id}:${kind}`) ?? this.startedAt;
        if (now - last < REMOVE_UNANNOUNCED_AFTER_MS) {
          continue;
        }
        this.log.info(
          `"${runtime.resolved.name}" (${id}): gv2mqtt hasn't announced its ${kind} for ` +
            `${Math.round((now - last) / 60000)} min while announcing other devices; removing it from HomeKit.`,
        );
        const keys = kind === 'light' ? [`${id}-light`, `${id}-effects`, `${id}-alert`] : [`${id}-humidifier`];
        this.unregister(keys.map((k) => this.uuidFor(k)));
        runtime.exposed.delete(kind);
      }
    }
  }

  private unregister(uuids: string[]): void {
    const gone = uuids.map((uuid) => this.accessories.get(uuid)).filter((a): a is PlatformAccessory => !!a);
    for (const uuid of uuids) {
      this.accessories.delete(uuid);
      this.builtUuids.delete(uuid);
    }
    if (gone.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, gone);
    }
  }
}
