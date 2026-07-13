# homebridge-govee-gv2mqtt

A Homebridge dynamic platform plugin for Govee lights exposed through a
[govee2mqtt](https://github.com/wez/govee2mqtt) (`gv2mqtt`) bridge.

It replaces a `mqttthing`-based config that hand-rolled two accessories per
light (a Lightbulb and a Television used only to pick scene effects) sharing
state via a global JS object. This plugin supports **any number of physical
devices**, each configured as one entry in `devices`, and keeps the same
Lightbulb + "Effects" Television pairing per device, but with proper push
updates over MQTT instead of only responding to HomeKit polling.

## Device compatibility

This plugin targets the **Govee Table Lamp** family and is tested against a
**Govee Table Lamp 2**. The list of 97 scene/DIY/music effect names in
[src/effects.ts](src/effects.ts) is hard-coded to what that specific model
reports — it is *not* queried from the device at runtime.

Table Lamp **1** and **Table Lamp Pro** should mostly work (same brightness,
color temperature and RGB handling), but their firmware ships its own,
different effect name list, so the "Effects" accessory's input names may not
line up with what the device actually supports — selecting an input by
position (e.g. "input 12") could apply the wrong effect for that model, or one
it doesn't have at all. If you're on one of those models and hit mismatched
effect names, open an issue with your device's actual effect list (visible in
the Govee app, or in the MQTT `effect` field when you switch effects from the
app) and it can be added as a per-model override.

## What each accessory does

For every entry in `devices` the platform creates:

- **`<name>`** — a Lightbulb accessory: On/Off, Brightness, Hue/Saturation,
  Color Temperature, and (optionally) Adaptive Lighting.
- **`<name> Effects`** — a Television accessory whose "Inputs" are Govee's
  built-in scene effects (Aurora, Fireplace, Rainbow, ...) **and its music
  (audio-reactive) modes** (Rhythm, Energic, Hopping, Light Waves, Meteor
  Shower, Spectrum, ...). Selecting an input switches the light into that
  effect or music mode; input 1 ("Normal Light") returns it to normal
  color/color-temperature mode. Because this is a regular HomeKit input
  selection, music modes can now be triggered manually from the Home app or
  wired into HomeKit automations (e.g. "when media starts playing on the
  living room TV, set Govee Table Lamp Effects input to Rhythm") — something
  the stock Govee HomeKit integration doesn't expose at all. This accessory
  can be disabled per-device with `enableEffects: false`.

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
- **Real state after a restart** (`refreshStateOnConnect`, default `true`):
  gv2mqtt publishes its state topics without the MQTT `retain` flag, so simply
  subscribing after a Homebridge/container/broker restart reveals nothing —
  Home would keep showing stale defaults until the light's next unrelated
  state change. gv2mqtt does republish every device's current state ~15s after
  seeing *any* message on the Home Assistant "birth" topic (it thinks HA just
  restarted), so on every MQTT connect this plugin publishes `"online"` to
  `homeassistant/status` (configurable via `haStatusTopic`) to piggyback on
  that mechanism. This only affects what gets displayed — it has nothing to do
  with `turnOffOnStartup`, which still defaults to `false` (the original
  config always forced the light off 10s after Homebridge started; this
  plugin only does that if you explicitly opt in per-device).
