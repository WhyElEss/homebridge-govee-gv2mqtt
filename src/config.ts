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
}

export interface GoveePlatformConfig extends PlatformConfig {
  mqttUrl: string;
  mqttUsername?: string;
  mqttPassword?: string;
  topicPrefix?: string;
  debounceRecvMs?: number;
  optimisticCacheMs?: number;
  refreshStateOnConnect?: boolean;
  haStatusTopic?: string;
  haDiscoveryPrefix?: string;
  periodicRefreshIntervalMs?: number;
  autoDiscover?: boolean;
  devices?: DeviceConfig[];
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
