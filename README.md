# homebridge-govee-gv2mqtt

A Homebridge dynamic platform plugin for Govee lights exposed through a
[govee2mqtt](https://github.com/wez/govee2mqtt) (`gv2mqtt`) bridge.

It replaces a `mqttthing`-based config that hand-rolled two accessories per
light (a Lightbulb and a Television used only to pick scene effects) sharing
state via a global JS object. This plugin supports **any number of physical
devices**, either listed explicitly in `devices` or auto-discovered (see
below), and keeps the same Lightbulb + "Effects" Television pairing per
device, but with proper push updates over MQTT instead of only responding to
HomeKit polling.

## Device compatibility

This plugin targets the **Govee Table Lamp** family and is tested against a
**Govee Table Lamp 2**. Brightness, color temperature and RGB handling is
generic Govee light control and should work across the family (Table Lamp
**1** and **Table Lamp Pro** included) and likely most other Govee lights
gv2mqtt supports.

The effect list itself is **discovered per device at runtime** (see below),
not hard-coded to one model — so Table Lamp 1/Pro (or any other Govee light)
get *their own* real effect list automatically, not the Table Lamp 2's. The
97-name static list in [src/effects.ts](src/effects.ts) only exists as a
fallback for the first ~15s after a restart, or if discovery is unavailable
for some reason (see "Real effect list per device" below) — that fallback
list *is* specific to a Table Lamp 2 and may show the wrong names for other
models during that gap.

## What each accessory does

For every entry in `devices` the platform creates:

- **`<name>`** — a Lightbulb accessory: On/Off, Brightness, Hue/Saturation,
  Color Temperature, and (optionally) Adaptive Lighting.
- **`<name> Effects`** — a Television accessory whose "Inputs" are that
  specific device's real scene effects (Aurora, Fireplace, Rainbow, ...),
  **music (audio-reactive) modes** (Rhythm, Energic, Hopping, Light Waves,
  Meteor Shower, Spectrum, ...), and any DIY scenes you've created for it -
  discovered live from gv2mqtt (see below). Selecting an input switches the
  light into that effect or music mode; input 1 ("Normal Light") returns it
  to normal color/color-temperature mode. Because this is a regular HomeKit
  input selection, music modes can now be triggered manually from the Home
  app or wired into HomeKit automations (e.g. "when media starts playing on
  the living room TV, set Govee Table Lamp Effects input to Rhythm") —
  something the stock Govee HomeKit integration doesn't expose at all. This
  accessory can be disabled per-device with `enableEffects: false`.

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

### Auto-discovering devices instead of listing them by hand

Set `autoDiscover: true` and `devices` becomes optional:

```json
{
  "platform": "GoveeGv2Mqtt",
  "name": "Govee (gv2mqtt)",
  "mqttUrl": "mqtt://mosquitto:1883",
  "autoDiscover": true,
  "excludedDeviceIds": ["AABBCC1122334455"]
}
```

Every Govee device gv2mqtt reports gets exposed automatically (name pulled
from its Home Assistant discovery config, same source as the effect list),
so you don't need to know/type any `deviceId` up front. Two ways to opt a
specific device out:

- **`excludedDeviceIds`**: a hard block, e.g. a lamp you'd rather keep on a
  different plugin/app, or don't want in HomeKit at all.
- **Explicit `devices[]` entries still work alongside `autoDiscover`** — for
  a `deviceId` that's also in `devices[]`, that entry's settings (name,
  `minMireds`, `enableEffects`, etc.) win instead of the auto-discovered
  defaults; it doesn't get double-registered.

Without `autoDiscover`, `devices[]` is the only source of truth (an allowlist
— nothing shows up in HomeKit unless it's listed), which is the safer default
for a shared/production Home setup where a device silently appearing on its
own isn't desirable. New devices are picked up as gv2mqtt announces them,
which (like the effect list and state refresh) depends on
`refreshStateOnConnect`/`periodicRefreshIntervalMs` below — a device added to
your Govee account won't show up in HomeKit until the next birth-topic ping
after gv2mqtt itself has learned about it.

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
- **Real effect list per device** (needs `refreshStateOnConnect`, default
  `true`): gv2mqtt itself fetches each device's actual supported scenes from
  Govee's official Platform API (per the exact SKU of that model) plus that
  Govee account's DIY scenes for the device, and republishes the combined
  list as the `effect_list` field of its Home Assistant MQTT discovery config
  for the light entity. This plugin subscribes to that discovery config topic
  (`<haDiscoveryPrefix>/light/<deviceId>/gv2mqtt-<deviceId>/config`) and uses
  its `effect_list` to build the Effects accessory's inputs, instead of a
  hard-coded list. **Music modes are part of that same API response** (gv2mqtt
  internally tags them with a `Music: ` prefix before handing them to the
  device) - no manual discovery/sniffing step is needed for them. The only
  thing that still requires a manual step is creating a DIY scene in the
  first place (that's inherent to what a DIY scene is); once created, gv2mqtt
  picks it up on its own next scene-list fetch, same as any stock scene.
  Since gv2mqtt doesn't retain either its state or discovery-config topics, a
  fresh subscribe alone reveals neither - both only arrive after gv2mqtt's own
  startup, or after this plugin pings the Home Assistant "birth" topic (see
  below), which is also why the fallback list exists for the gap in between.
  Set `periodicRefreshIntervalMs` to periodically re-trigger this (e.g. to
  pick up a newly-created DIY scene, or - with `autoDiscover` - a newly-added
  device) without restarting Homebridge.
- **Real state after a restart** (`refreshStateOnConnect`, default `true`):
  gv2mqtt publishes its state topics without the MQTT `retain` flag, so simply
  subscribing after a Homebridge/container/broker restart reveals nothing —
  Home would keep showing stale defaults until the light's next unrelated
  state change. gv2mqtt does republish every device's current state ~15s after
  seeing *any* message on the Home Assistant "birth" topic (it thinks HA just
  restarted), so on every MQTT connect this plugin publishes `"online"` to
  `<haDiscoveryPrefix>/status` (default `homeassistant/status`; override with
  `haStatusTopic` if gv2mqtt's Home Assistant integration listens elsewhere)
  to piggyback on that mechanism - the same ping that also drives the real
  effect list discovery above. This only affects what gets displayed — it has
  nothing to do with `turnOffOnStartup`, which still defaults to `false` (the
  original config always forced the light off 10s after Homebridge started;
  this plugin only does that if you explicitly opt in per-device).
