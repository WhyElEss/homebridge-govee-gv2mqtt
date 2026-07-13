import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { GoveeGv2MqttPlatform } from './platform';

export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, GoveeGv2MqttPlatform);
};
