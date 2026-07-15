import { PlatformConfig } from 'homebridge';

export interface DeviceConfig {
  name: string;
  deviceId: string;
  /** Default true. Set false to keep a known device out of HomeKit without removing its entry. */
  enabled?: boolean;
  minMireds?: number;
  maxMireds?: number;
  adaptiveLighting?: boolean;
  enableEffects?: boolean;
  colorSaturationThreshold?: number;
  turnOffOnStartup?: boolean;
  turnOffOnStartupDelayMs?: number;
  /**
   * Exposes a "<name> Alert" switch: turning it on captures a snapshot of
   * whatever the light is currently doing (including an active effect) and
   * forces it to alertHue/alertSaturation/alertBrightness; turning it off
   * restores the snapshot exactly. Meant for automations like "flash red
   * while the front door is open, then go back to whatever it was doing" -
   * see README.
   */
  enableAlert?: boolean;
  alertHue?: number;
  alertSaturation?: number;
  alertBrightness?: number;
  /**
   * Exposes a "<name> Custom Effects" accessory with LAN-driven effects
   * (Police Strobo, Гроза в банке). H6022 (Table Lamp 2) only - activation
   * is refused for any other model. Requires the lamp's "LAN Control"
   * toggle enabled in the Govee Home app. The lamp's IP is auto-discovered
   * by a multicast LAN scan (matched by deviceId).
   */
  enableCustomEffects?: boolean;
  /**
   * Optional fallback IP for the lamp, used only when the LAN scan can't
   * run - e.g. UDP port 4002 is held by another Govee LAN controller on the
   * same host. Not needed otherwise; discovery follows DHCP changes.
   */
  lanIp?: string;
}

export interface GoveePlatformConfig extends PlatformConfig {
  mqttUrl: string;
  mqttUsername?: string;
  mqttPassword?: string;
  topicPrefix?: string;
  optimisticCacheMs?: number;
  refreshStateOnConnect?: boolean;
  haStatusTopic?: string;
  haDiscoveryPrefix?: string;
  periodicRefreshIntervalMs?: number;
  autoDiscover?: boolean;
  devices?: DeviceConfig[];
}

/** GoveePlatformConfig with every optional field resolved to its default. */
export interface ResolvedPlatformConfig {
  mqttUrl: string;
  mqttUsername?: string;
  mqttPassword?: string;
  topicPrefix: string;
  optimisticCacheMs: number;
  refreshStateOnConnect: boolean;
  haDiscoveryPrefix: string;
  haStatusTopic: string;
  periodicRefreshIntervalMs: number;
  autoDiscover: boolean;
  devices: DeviceConfig[];
}

export function resolvePlatformConfig(config: GoveePlatformConfig): ResolvedPlatformConfig {
  const haDiscoveryPrefix = config.haDiscoveryPrefix ?? 'homeassistant';
  return {
    mqttUrl: config.mqttUrl,
    mqttUsername: config.mqttUsername,
    mqttPassword: config.mqttPassword,
    topicPrefix: config.topicPrefix ?? 'gv2mqtt/light',
    optimisticCacheMs: config.optimisticCacheMs ?? 10000,
    refreshStateOnConnect: config.refreshStateOnConnect ?? true,
    haDiscoveryPrefix,
    haStatusTopic: config.haStatusTopic ?? `${haDiscoveryPrefix}/status`,
    periodicRefreshIntervalMs: config.periodicRefreshIntervalMs ?? 0,
    autoDiscover: config.autoDiscover ?? false,
    devices: config.devices ?? [],
  };
}

export interface ResolvedDeviceConfig {
  name: string;
  deviceId: string;
  enabled: boolean;
  minMireds: number;
  maxMireds: number;
  adaptiveLighting: boolean;
  enableEffects: boolean;
  colorSaturationThreshold: number;
  turnOffOnStartup: boolean;
  turnOffOnStartupDelayMs: number;
  enableAlert: boolean;
  alertHue: number;
  alertSaturation: number;
  alertBrightness: number;
  enableCustomEffects: boolean;
  lanIp: string;
  stateTopic: string;
  commandTopic: string;
  discoveryConfigTopic: string;
}

export function resolveDeviceConfig(
  device: DeviceConfig,
  topicPrefix: string,
  haDiscoveryPrefix: string,
): ResolvedDeviceConfig {
  return {
    name: device.name,
    deviceId: device.deviceId,
    enabled: device.enabled ?? true,
    minMireds: device.minMireds ?? 111,
    maxMireds: device.maxMireds ?? 500,
    adaptiveLighting: device.adaptiveLighting ?? true,
    enableEffects: device.enableEffects ?? true,
    colorSaturationThreshold: device.colorSaturationThreshold ?? 0.75,
    turnOffOnStartup: device.turnOffOnStartup ?? false,
    turnOffOnStartupDelayMs: device.turnOffOnStartupDelayMs ?? 10000,
    enableAlert: device.enableAlert ?? false,
    alertHue: device.alertHue ?? 0,
    alertSaturation: device.alertSaturation ?? 100,
    alertBrightness: device.alertBrightness ?? 100,
    enableCustomEffects: device.enableCustomEffects ?? false,
    lanIp: device.lanIp ?? '',
    stateTopic: `${topicPrefix}/${device.deviceId}/state`,
    commandTopic: `${topicPrefix}/${device.deviceId}/command`,
    // gv2mqtt's Home Assistant MQTT discovery config topic for this device's
    // light entity; its "effect_list" field is the real per-device scene/
    // music/DIY effect list fetched from Govee's own API. See GoveeDevice.
    // Topic is literally "{disco_prefix}/{integration}/{unique_id}/config"
    // (gv2mqtt's own publish_entity_config), and the light's unique_id is
    // "gv2mqtt-{deviceId}" - three segments before "config", not four.
    discoveryConfigTopic: `${haDiscoveryPrefix}/light/gv2mqtt-${device.deviceId}/config`,
  };
}
