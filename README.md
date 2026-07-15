# homebridge-govee-gv2mqtt

A Homebridge dynamic platform plugin for Govee lights exposed through a
[govee2mqtt](https://github.com/wez/govee2mqtt) (`gv2mqtt`) bridge.

For each configured (or auto-discovered) physical device it creates a pair of
accessories: a Lightbulb for on/off/brightness/color, and a Television-style
accessory whose "Inputs" are that device's real scene/music/DIY effects. The
Television-as-effect-picker is a deliberate hack — HomeKit's Lightbulb
service has no concept of a named effect, but Television/InputSource does.

## Device compatibility

Tested against two real devices: a **Govee Table Lamp 2 (H6022)** and a
**Govee Aura Table Lamp (H6052)**. Both are generic Govee light control
(brightness/color-temp/RGB), so the same code path should work for other
Govee lights `gv2mqtt` supports — the per-device effect list, color
temperature range, and DIY scenes are all discovered live from Govee's API
per the device's actual SKU (see below), not hard-coded to one model.

A static 97-name fallback list in [src/effects.ts](src/effects.ts) — modeled
on the Table Lamp 2's effects — is used only for the first ~15s after a
restart, before that device's real list has been discovered, or if discovery
never arrives for some reason. It's a stopgap, not a source of truth.

## What each accessory does

For every known device the platform creates:

- **`<name>`** — a Lightbulb accessory: On/Off, Brightness, Hue/Saturation,
  Color Temperature, and (optionally) Adaptive Lighting.
- **`<name> Effects`** — a Television accessory whose "Inputs" are that
  specific device's real scene effects (Aurora, Fireplace, Rainbow, ...),
  **music (audio-reactive) modes** (reported by Govee's API with a `Music: `
  prefix, e.g. `Music: Rhythm`, `Music: Spectrum`), and any DIY scenes
  created for it. Selecting an input switches the light into that effect;
  input 1 ("Normal Light") returns it to normal color/color-temperature
  mode. Because this is a regular HomeKit input selection, music modes can
  be triggered manually from the Home app or wired into HomeKit automations
  — something the stock Govee HomeKit integration doesn't expose at all.
  This accessory can be disabled per-device with `enableEffects: false`.
- **`<name> Alert`** — an optional Switch accessory (`enableAlert: true`) for
  "flash this light, then put it back exactly how it was" automations. See
  [Alert switch](#alert-switch-flash-and-restore-for-automations) below.

Both accessories for a device share one `GoveeDevice` instance
([src/govee-device.ts](src/govee-device.ts)) that owns all MQTT
subscription/publish logic and cached state for that physical light.

## Install

This plugin isn't (necessarily) on the public npm registry — the repo is set
up to support publishing there (see `package.json`), but the verified,
working install path is as a **git dependency**, which is also how the
official `homebridge/homebridge` Docker image's built-in plugin manager
works: it reads a `package.json` at the root of the config volume and runs
`npm install` against it on every container start.

1. On the host, edit `<config-volume>/package.json` and add to `dependencies`:
   ```json
   "homebridge-govee-gv2mqtt": "github:WhyElEss/homebridge-govee-gv2mqtt"
   ```
2. Restart the Homebridge container. Its startup script clones the repo,
   and npm's `prepare` script (`npm run build`) compiles the TypeScript
   automatically — no manual build step needed.
3. To pick up a newer commit later, since there's no lockfile pinning a
   specific version: remove the already-installed copy
   (`node_modules/homebridge-govee-gv2mqtt` inside the container) and
   restart, so `npm install` re-clones instead of assuming what's already
   there is current.

If you're not using that Docker image, install like any other Homebridge
plugin from source: `git clone`, `npm install`, `npm run build`, then make
the resulting package visible to Homebridge's `node_modules` (or `npm link`).

## Configuration

Add a `GoveeGv2Mqtt` platform block to Homebridge's `config.json` (or
configure it through Config UI X, which reads `config.schema.json`):

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

Each device only needs `name` and `deviceId` — every other field defaults
sensibly (`enabled: true`, `minMireds: 111`, `maxMireds: 500`,
`adaptiveLighting: true`, `enableEffects: true`,
`colorSaturationThreshold: 0.75`, `turnOffOnStartup: false`).

`deviceId` is whatever identifier your `gv2mqtt` bridge uses in
`<topicPrefix>/<deviceId>/state` and `.../command`.

### Auto-discovering devices instead of listing them by hand

Set `autoDiscover: true` and `devices` becomes optional:

```json
{
  "platform": "GoveeGv2Mqtt",
  "name": "Govee (gv2mqtt)",
  "mqttUrl": "mqtt://mosquitto:1883",
  "autoDiscover": true
}
```

Every Govee device gv2mqtt reports gets exposed automatically (name pulled
from its Home Assistant discovery config, same source as the effect list),
so you don't need to know/type any `deviceId` up front. Each newly-found
device is **also written into this platform's `devices[]` array in
config.json**, exactly as if you'd added it by hand — open Config UI X's
settings form afterwards and it's right there with its name and device ID.

Two ways an already-known device stops getting (re-)exposed:

- **Untick its `enabled` checkbox** on its `devices[]` entry. It stays in
  the list — so auto-discovery won't re-add it as "new" — but no
  accessories get created for it.
- **Explicit `devices[]` entries take precedence over auto-discovery** for
  that `deviceId` — if it's already listed by hand, its settings (name,
  `minMireds`, `enableEffects`, etc.) are used as-is and it's never treated
  as "newly found."

Without `autoDiscover`, `devices[]` is the only source of truth (an
allowlist — nothing shows up in HomeKit unless it's listed), the safer
default for a shared/production Home setup. New devices are picked up as
gv2mqtt announces them, which (like the effect list and state refresh below)
depends on `refreshStateOnConnect`/`periodicRefreshIntervalMs`.

Writing to `devices[]` in config.json from a running platform isn't an
officially supported thing for a regular (non-Custom-UI) Homebridge plugin
to do — it re-reads and re-writes the whole file defensively on each new
discovery, but formatting/comments in the original file aren't preserved,
and there's a small window where an edit made through Config UI X at the
exact same moment could get lost. If the write fails for any reason
(permissions, etc.) the device still works for that session — it'll just
need rediscovering on the next restart.

## Alert switch: flash-and-restore for automations

Set `enableAlert: true` on a device to get an extra `<name> Alert` Switch
accessory, for automations like *"turn the lamp red while the front door is
open, then put it back to whatever it was doing"* — including back into an
active effect, not just its last plain color.

- Turning the switch **on** snapshots the light's full current state (power,
  effect selection, or color/color-temperature + brightness, whichever mode
  it's actually in) and forces it to a fixed alert color.
- Turning the switch **off** restores exactly what was snapshotted — if the
  light was mid-effect, it goes back into that same effect; if it was off,
  it goes back off; if it was on a plain color or color temperature, that's
  reapplied.
- The alert color is configurable per device: `alertHue` (0-360),
  `alertSaturation` (0-100), `alertBrightness` (0-100) — default is full
  red (`0, 100, 100`).

```json
{
  "name": "Govee Table Lamp",
  "deviceId": "18DFD0C806467677",
  "enableAlert": true,
  "alertHue": 0,
  "alertSaturation": 100,
  "alertBrightness": 100
}
```

This is deliberately a single on/off toggle rather than a multi-step "do
this, wait, then do that" automation. HomeKit's own Home app has no native
"snapshot current state and restore it later" primitive, and no explicit
"wait" step between actions in an automation (that exists only via
Shortcuts' "Convert to Shortcut", and Shortcuts' Personal Automations run
tied to a specific phone/Apple ID — unreliable if that phone isn't home or
is asleep). A plain two-trigger Home app automation doesn't have that
problem: any Home Hub (Apple TV, HomePod, or a always-on iPad) can run it
regardless of which phones are present. So the pattern is two ordinary,
single-action Home app automations built on a door/contact sensor:

- **Door opens** → turn on `<name> Alert`.
- **Door closes** → turn off `<name> Alert`.

Each automation only ever does one thing (flip one switch), so there's
nothing to sequence or wait on — the snapshot/restore logic all happens
inside the plugin the moment the switch is toggled.

## Behavior notes

- **Optimistic cache window** (`optimisticCacheMs`, default 10000ms): a
  locally-set value (brightness, color, on/off) is trusted for this long
  before an incoming device report is allowed to overwrite it, so the Home
  app doesn't flicker back to a stale value while the round trip to the
  physical device completes. A device-reported "off" specifically only
  resets the cached effect/mode once this window has passed, so a spurious
  transient "off" report right after turning a light on with an effect
  selected doesn't wipe that selection (see the effect race note below for
  why that can happen).
- **White vs. color heuristic** (`colorSaturationThreshold`, default
  `0.75`): when Home's color wheel is used, the resulting color's
  saturation decides whether it's sent to the device as a
  color-temperature command (low saturation → treated as "white") or a
  true RGB color command.
- **Adaptive Lighting** requires the Home Hub to be on iOS 13+/aligned
  hardware; it's controlled per-device via `adaptiveLighting` in config,
  and is automatically suppressed while an effect is active (a
  color-temperature update received while in effect mode is ignored rather
  than cancelling the effect).
- **Adaptive Lighting vs. the physical power button**: while Adaptive
  Lighting is active, a color-temperature command goes out roughly once a
  minute (HAP-NodeJS's controller keeps firing them on its fixed schedule
  even while the light is off — it never checks the On state), so a press
  of the light's own physical button always competes with recent commands:
  our cached state stays stale-"on" for the few seconds the off report
  needs to travel Govee's cloud → gv2mqtt → us, and Govee's cloud has also
  been observed to settle an *already-delivered* command a few seconds
  late, relighting a lamp that was just switched off. gv2mqtt maps any
  color-temp command onto Govee API calls that wake the lamp, so either
  race used to turn the light right back on. Guards, in order:
  - AL nudges are **deferred ~5s and re-checked** against the latest known
    state before being sent (a deliberate slider drag by the user is still
    sent immediately — only automatic background nudges are deferred), and
    **skipped entirely when the drift since the last sent value is under 5
    mireds** — imperceptible, and every skipped command is one less thing
    in Govee's pipeline for a button press to race.
  - If an "off" report still arrives shortly after a nudge was published,
    the plugin **re-asserts the off** so the button press wins.
  - For ~30s after an out-of-band "off" that arrived during active AL
    nudging, an unsolicited "on" report that no HomeKit action asked for
    is **answered with an OFF command** (up to 3 times) instead of being
    accepted — this is what beats Govee's late server-side settling, which
    needs no further input from the plugin to relight the lamp. Any real
    power-on through HomeKit disarms this watchdog instantly; a genuine
    out-of-band power-on (Govee app, pressing the button back on within
    that half-minute) can be fought at most 3 times and then wins. The
    watchdog only ever arms while the lamp is idle in plain
    color-temperature mode with an AL nudge as the *last command sent* —
    any deliberate HomeKit command (an effect selection, a color change,
    an on/off) resets that bookkeeping, so Govee's known spurious-OFF blip
    after an effect command can't be mistaken for a button press while
    paging through effects.
  Nudges are also sent without a redundant `brightness` field, halving the
  Govee API calls gv2mqtt makes per nudge.
- **Real effect list per device** (needs `refreshStateOnConnect`, default
  `true`): gv2mqtt fetches each device's actual supported scenes from
  Govee's official Platform API (per the exact SKU of that model) plus that
  Govee account's DIY scenes, and republishes the combined list as the
  `effect_list` field of its Home Assistant MQTT discovery config for the
  light entity (topic `<haDiscoveryPrefix>/light/gv2mqtt-<deviceId>/config`).
  This plugin subscribes to that topic and uses `effect_list` to build the
  Effects accessory's inputs instead of the hard-coded fallback. Music
  modes are part of that same response, tagged with a `Music: ` prefix — no
  separate discovery step needed. The only manual step left is creating a
  DIY scene in the first place; once created, gv2mqtt picks it up on its
  own next fetch like any stock scene. Neither this topic nor the state
  topic is retained by gv2mqtt, so a fresh subscribe alone reveals nothing —
  both only arrive after gv2mqtt's own startup or after this plugin pings
  the Home Assistant "birth" topic (next bullet). Set
  `periodicRefreshIntervalMs` to periodically re-trigger this (e.g. to pick
  up a newly-created DIY scene, or — with `autoDiscover` — a newly-added
  device) without restarting Homebridge.
- **Stable effect Identifiers**: HomeKit correlates a Television's "Inputs"
  by a numeric `Identifier`, not by name, and Govee's API doesn't guarantee
  `effect_list` comes back in the same order on every refresh. This plugin
  assigns each effect name a permanent number the first time it's seen and
  never reassigns it by array position on later refreshes — otherwise the
  same number could end up pointing at a different effect between syncs,
  which can desync Home's own Input cache and make entries silently vanish
  from its UI even though the underlying HAP services are all present and
  correct.
- **Real state after a restart** (`refreshStateOnConnect`, default `true`):
  gv2mqtt publishes its state topics without the MQTT `retain` flag, so
  simply subscribing after a restart reveals nothing — Home would keep
  showing stale defaults until the light's next unrelated state change.
  gv2mqtt republishes every device's current state (and discovery config,
  including the effect list) ~15s after seeing *any* message on the Home
  Assistant "birth" topic, so on every MQTT connect this plugin publishes
  `"online"` to `<haDiscoveryPrefix>/status` (default
  `homeassistant/status`; override with `haStatusTopic` if needed) to
  piggyback on that mechanism. This has nothing to do with
  `turnOffOnStartup` (default `false`), which forces the light off shortly
  after Homebridge starts if explicitly enabled per-device.
- **Effect selection vs. a server-side race**: Govee's cloud API has been
  observed to occasionally apply an effect/scene command out of order
  against an unrelated color-temperature command issued a few seconds
  earlier (e.g. Adaptive Lighting's periodic nudge) — settling back on
  plain color mode several seconds later even though the effect command
  was sent last. To guard against this, selecting an effect schedules a
  single re-send of that same command ~5s later, cancelled/replaced if a
  different effect gets selected before then — so paging quickly through
  effects by hand in Home doesn't pile up a burst of redundant commands.
- **Debug logging**: every MQTT publish/receive and every characteristic
  setter call (with the state it saw and what it decided to do) is logged
  at debug level. Enable Homebridge's debug mode to see it when
  troubleshooting unexpected behavior.
