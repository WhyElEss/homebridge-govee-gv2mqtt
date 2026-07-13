# homebridge-govee-gv2mqtt

A Homebridge dynamic platform plugin for Govee lights exposed through a
[govee2mqtt](https://github.com/wez/govee2mqtt) (`gv2mqtt`) bridge.

It replaces a `mqttthing`-based config that hand-rolled two accessories per
light (a Lightbulb and a Television used only to pick scene effects) sharing
state via a global JS object. This plugin supports **any number of physical
devices**, each configured as one entry in `devices`, and keeps the same
Lightbulb + "Effects" Television pairing per device, but with proper push
updates over MQTT instead of only responding to HomeKit polling.

## What each accessory does

For every entry in `devices` the platform creates:

- **`<name>`** — a Lightbulb accessory: On/Off, Brightness, Hue/Saturation,
  Color Temperature, and (optionally) Adaptive Lighting.
- **`<name> Effects`** — a Television accessory whose "Inputs" are Govee's
  built-in scene effects (Aurora, Fireplace, Rainbow, ...). Selecting an input
  switches the light into that effect; input 1 ("Normal Light") returns it to
  normal color/color-temperature mode. This can be disabled per-device with
  `enableEffects: false`.

Both accessories for a device share one `GoveeDevice` instance
([src/govee-device.ts](src/govee-device.ts)) that owns the MQTT
subscription/publish logic — the direct replacement for the old
`global.govee` object.

## Install

Build the plugin, then make it available inside your Homebridge Docker
container (which already has Node.js):

```bash
npm install
npm run build
```

- **If Homebridge runs via `oznu/homebridge` or the official image** with a
  mounted config volume, drop this project under that volume's plugin path,
  or `npm pack` it and `npm install /path/to/homebridge-govee-gv2mqtt-0.1.0.tgz`
  inside the container.
- **Via Homebridge Config UI X**, use "Install Plugin" → "From npm tarball/git
  URL" once this is pushed to a git repo or private npm registry.

## Configuration

Add a `GoveeGv2Mqtt` platform block to Homebridge's `config.json` (or configure
it through Config UI X, which reads `config.schema.json`):

```json
{
  "platform": "GoveeGv2Mqtt",
  "name": "Govee (gv2mqtt)",
  "mqttUrl": "mqtt://mosquitto:1883",
  "topicPrefix": "gv2mqtt/light",
  "devices": [
    {
      "name": "Govee Table Lamp",
      "deviceId": "18DFD0C806467677",
      "minMireds": 111,
      "maxMireds": 500,
      "adaptiveLighting": true,
      "enableEffects": true
    },
    {
      "name": "Govee Floor Lamp",
      "deviceId": "AABBCC1122334455"
    }
  ]
}
```

Each device only needs `name` and `deviceId` — every other field has the same
default as the original config (`minMireds: 111`, `maxMireds: 500`,
`adaptiveLighting: true`, `enableEffects: true`,
`colorSaturationThreshold: 0.75`).

`deviceId` is whatever identifier your `gv2mqtt` bridge uses in
`<topicPrefix>/<deviceId>/state` and `.../command` — the same value that was
previously hard-coded into every topic string in the old `mqttthing` config.

### Migrating from the old config

Remove the two `mqttthing` accessory blocks and the `platforms` entry for this
plugin's predecessor (there wasn't one — it was two loose accessories), then
add one platform block as above with one `devices[]` entry per physical light
you had. The device ID `18DFD0C806467677` in the sample config above is taken
directly from the original topics.

## Behavior notes / intentional differences from the original config

- **Effect detection from the device side is no longer "sticky."** The
  original `getActiveInput` only updated its cached effect index when the
  accessory was *already* in effect mode locally, so an effect switched from
  the Govee app (not through HomeKit) could go unnoticed. This plugin always
  trusts the device's reported `effect`/`color_mode` fields (outside the
  optimistic-cache window described below), so external changes now show up
  correctly in HomeKit.
- **Optimistic cache window** (`optimisticCacheMs`, default 10000ms): a
  locally-set value (brightness, color, etc.) is trusted for this long before
  falling back to whatever the device last reported, so the Home app doesn't
  flicker back to a stale value while the round trip to the physical device
  completes.
- **White vs. color heuristic** (`colorSaturationThreshold`, default `0.75`):
  when Home's color wheel is used, the resulting color's saturation decides
  whether it's sent to the device as a color-temperature command (low
  saturation → treated as "white") or a true RGB color command, exactly like
  the original `setRGB` logic.
- **Adaptive Lighting** requires the Home Hub to be on iOS 13+/aligned
  hardware, same as any other lightbulb accessory; it's controlled per-device
  via `adaptiveLighting` in config.
