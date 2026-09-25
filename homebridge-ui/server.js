const fs = require('fs');
const path = require('path');
const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');

/**
 * Serves each configured device's real effect list to the settings page.
 *
 * The list is per-device and only known at runtime - gv2mqtt fetches it from
 * Govee's own API for that exact SKU, plus the account's DIY scenes - so it
 * cannot live in config.schema.json, which is static and shared by every
 * device in the array. Hence a custom UI.
 *
 * The data does not come from MQTT here. The plugin already caches each
 * device's catalog in its accessory context (see EffectsAccessory), and
 * Homebridge persists that with the cached accessories, so this reads the
 * same file the plugin itself restores from at startup: instant, needs no
 * broker credentials, and is exactly what the plugin knows.
 */
class GoveeUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/effects', () => this.readCatalogs());
    this.ready();
  }

  /**
   * Accessories live in one file per bridge. A plugin running in a child
   * bridge - which this one does, and is the recommended setup - gets
   * `cachedAccessories.<username without colons>`, so every candidate file
   * is scanned rather than guessing which bridge is ours; entries are
   * recognised by the context this plugin writes.
   */
  readCatalogs() {
    const dir = path.join(this.homebridgeStoragePath, 'accessories');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith('cachedAccessories'));
    } catch {
      return { devices: [], error: 'Could not read Homebridge’s accessory cache.' };
    }

    const devices = [];
    const seen = new Set();
    // Which kinds of accessory each device has in HomeKit right now.
    const exposed = {};
    for (const file of files) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch {
        continue; // a half-written or backup file; the next one may be ours
      }
      if (!Array.isArray(parsed)) {
        continue;
      }
      for (const accessory of parsed) {
        const context = accessory && accessory.context;
        if (!context || !context.deviceId) {
          continue;
        }
        if (context.kind === 'light' || context.kind === 'humidifier') {
          exposed[context.deviceId] = exposed[context.deviceId] || [];
          if (!exposed[context.deviceId].includes(context.kind)) {
            exposed[context.deviceId].push(context.kind);
          }
          continue;
        }
        if (!Array.isArray(context.effectNames)) {
          continue;
        }
        if (seen.has(context.deviceId)) {
          continue;
        }
        seen.add(context.deviceId);
        devices.push({
          deviceId: context.deviceId,
          // Index 0 is the synthetic "Normal Light", which is how you leave
          // effect mode - never offered as something to hide.
          effects: context.effectNames.slice(1),
        });
      }
    }
    return { devices, exposed };
  }
}

(() => new GoveeUiServer())();
