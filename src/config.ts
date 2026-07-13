import { PlatformConfig } from 'homebridge';

export interface DeviceConfig {
  name: string;
  deviceId: string;
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
  devices: DeviceConfig[];
}

export interface ResolvedDeviceConfig {
  name: string;
  deviceId: string;
  minMireds: number;
  maxMireds: number;
  adaptiveLighting: boolean;
  enableEffects: boolean;
  colorSaturationThreshold: number;
  turnOffOnStartup: boolean;
  turnOffOnStartupDelayMs: number;
  stateTopic: string;
  commandTopic: string;
}

export function resolveDeviceConfig(
  device: DeviceConfig,
  topicPrefix: string,
): ResolvedDeviceConfig {
  return {
    name: device.name,
    deviceId: device.deviceId,
    minMireds: device.minMireds ?? 111,
    maxMireds: device.maxMireds ?? 500,
    adaptiveLighting: device.adaptiveLighting ?? true,
    enableEffects: device.enableEffects ?? true,
    colorSaturationThreshold: device.colorSaturationThreshold ?? 0.75,
    turnOffOnStartup: device.turnOffOnStartup ?? false,
    turnOffOnStartupDelayMs: device.turnOffOnStartupDelayMs ?? 10000,
    stateTopic: `${topicPrefix}/${device.deviceId}/state`,
    commandTopic: `${topicPrefix}/${device.deviceId}/command`,
  };
}
