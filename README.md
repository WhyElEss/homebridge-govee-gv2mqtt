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

- **Optimistic cache window** (`optimisticCacheMs`, default 10000ms):
  applied **per property**. A device report for a property is ignored while
  either something newer for it is still waiting in the pending patch, or
  we commanded that property within this window. gv2mqtt's reports run
  several seconds behind and arrive out of order — one drag on 2026-09-02
  was answered with 94, 53, 22, 31, 21 in that order, long after the finger
  had settled on 20 — so anything inside the window is untrustworthy
  whether or not it matches what was asked for. (This is where the same
  gate in homebridge-yeelight-wifi deliberately differs: a Yeelight answers
  on the LAN in ~90ms, so a *differing* value there really is news. Here it
  is far more often a stale report still working its way out of Govee's
  cloud, and believing it snaps the slider back to a position the finger
  already left.) Scoping it per property is what keeps a brightness drag
  from blinding the plugin to a colour changed in the Govee app at the same
  moment. A device-reported "off" also only resets the cached effect/mode
  once the window has passed, so a spurious transient "off" right after
  turning a light on with an effect selected doesn't wipe that selection.
- **Whose change is it** (on/off): power state can't simply be held for the
  window above — a press of the lamp's own button has to get through
  promptly. It's decided by intent instead: the plugin records *what it
  asked for* as each command goes out (not when the device confirms it —
  gv2mqtt's report of a change can arrive in the same socket read as the
  confirmation of the command that caused it, which is too late), and an
  "off" report that contradicts an ON command published within the last 10s
  is treated as that command echoing back, not as the lamp going off. It
  changes neither the cache nor HomeKit. Everything else still gets
  through: an "off" nobody asked for, one arriving while Adaptive Lighting
  was the last thing driving the lamp, and one the plugin itself commanded
  are all applied as before, and an off that the power-off watchdog decides
  to defend is always applied (the watchdog needs the cached "off" to
  recognise a later bogus relight). This is what stops Govee's spurious OFF
  blip a couple of seconds after an effect/color command from blanking the
  Home tile and the Effects accessory for the few seconds until the real
  "on" report lands — and, worse than the flicker, from leaving `isOn`
  cached false, where a tap on the seemingly-off tile took the full
  power-on path and cancelled the effect just selected.
- **Coalesced writes** (`COALESCE_MS`, 350ms): Home streams the slider or
  colour-wheel position as a burst of characteristic writes while a finger
  is moving. Everything about the light's appearance — brightness, the
  colour wheel, a deliberate colour temperature — merges into one pending
  patch and leaves as **one** command. The cached value moves with every
  write, so the Home app and `onGet` are correct immediately; only the wire
  is coalesced. A gesture that changes colour *and* brightness is one
  command, not two.

  The window is **fixed, not sliding**: the timer is armed only when none is
  running, so a continuous drag still reaches the lamp at a bounded rate
  instead of going silent until the finger stops. v0.7.7 got this wrong by
  rescheduling the timer on every write, which collapses a burst only while
  the writes are closer together than the window — Home's are about 250ms
  apart, so a 100ms sliding window published every single one. A drag
  captured on 2026-09-02 still produced nine commands, four of them repeats
  of a value already sent, and the lamp visibly stepped through the queue
  for seconds afterwards. (The same design in
  [homebridge-yeelight-wifi](https://github.com/WhyElEss/homebridge-yeelight-wifi)
  uses 80ms, talking to a lamp on the LAN that answers in ~90ms; every
  command here is a cloud round trip of about a second.)

  Whether a brightness change is real enough to back out of a running
  effect is judged against the value from *before* the burst, so a drag
  that ends where it started — or Home resending the same value — doesn't
  cancel an effect.
- **Colour goes out at full value**: the device stores hue and level
  independently — through a brightness drag the reports keep
  `color:{r:128,g:0,b:255}` unchanged while `brightness` walks 94 → 21 — so
  the RGB in a command carries hue and saturation only and the level
  travels in its own `brightness` field. Before v0.8.0 the RGB was also
  scaled by the current brightness, which baked the level into the colour
  channel and then dimmed it a second time: a colour picked at 17% went out
  as `{"color":{"r":22,"g":0,"b":43},"brightness":17}`. The white/colour
  decision now reads the Saturation characteristic directly instead of
  round-tripping through those scaled RGB values, where rounding at a low
  brightness could flip it for the same colour.
- **White vs. color heuristic** (`colorSaturationThreshold`, default
  `0.75`): when Home's color wheel is used, the resulting color's
  saturation decides whether it's sent to the device as a
  color-temperature command (low saturation → treated as "white") or a
  true RGB color command.
- **Picking a color on a light that's off** ("come on like this next
  time"): the color command itself is withheld while the light is off —
  touching the color wheel must not wake a lamp you left off — but the
  choice is remembered, and the next power-on sends that color instead of
  the usual "back to normal light" color temperature. There is no time
  limit: picking a color and then reaching for the power or brightness
  control is one action however long you take over it. The intent lasts
  until the light next comes on, or until something deliberately returns
  the lamp to normal light (a color temperature or white from the wheel, a
  scene, selecting "Normal Light"). Adaptive Lighting's background nudges
  don't disturb it — they return early while the light is off.
  Deliberately asymmetric: a lamp that was switched off **while lit** does
  *not* come back in its old color, it returns to normal light as before,
  which is what the Adaptive-Lighting scene handling relies on. Before
  v0.7.5 the choice was dropped entirely and the power-on overwrote it
  with white — red at 100% on an off lamp came up as plain Adaptive
  Lighting, with no color command on the wire at all; v0.7.5 honoured it
  only within ~2s, which covered Home's own Hue/Saturation-then-On batch
  but not a person picking a color and then turning the lamp on.
- **Adaptive Lighting** requires the Home Hub to be on iOS 13+/aligned
  hardware; it's controlled per-device via `adaptiveLighting` in config.
  While an effect is active, only AL's **background** color-temperature
  writes are suppressed (so the periodic nudges don't silently cancel a
  running effect). Every **deliberate** way of leaving an effect works:
  - a scene/automation that sets the **Lightbulb** while an effect/color is
    active — its (redundant) `On=true` write pulls the lamp back to normal
    light, mirroring the original mqttthing config's semantics. This is
    what makes "switch back to Adaptive Lighting" scenes reliable: their
    power write always arrives, whereas iOS rewrites the AL transition on
    scene recall only intermittently. Two exemptions keep this from
    misfiring: the Effects accessory's own redundant `Active` write never
    does this (HomeKit doesn't guarantee Active/ActiveIdentifier ordering,
    so a TV "on" must never reset a just-selected effect), and an `On`
    arriving within ~2s of a color/effect command we just published is
    treated as part of the same scene batch (a color scene must not wipe
    its own result when its writes arrive in the "wrong" order);
  - the same AL-scene recall is *additionally* detected when iOS does
    rewrite the AL transition (observed via the `ActiveTransitionCount`
    characteristic — this also covers manually tapping the Adaptive
    Lighting tile in the lamp's color picker, which writes no `On`; the
    caveat is that a Home-Hub background refresh of the AL curve is
    indistinguishable and would also drop a then-running effect);
  - a scene or slider with a **fixed color temperature or white**;
  - a **saturated color** from the color wheel or a scene;
  - a real **brightness change**;
  - selecting the **"Normal Light"** input on the Effects accessory.
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
  - For ~30s after an out-of-band "off", an unsolicited "on" report that
    no HomeKit action asked for is **answered with an OFF command** (up to
    3 times) instead of being accepted — this is what beats Govee's late
    server-side settling, which needs no further input from the plugin to
    relight the lamp. Any real power-on through HomeKit disarms this
    watchdog instantly; a genuine out-of-band power-on (Govee app, pressing
    the button back on within that half-minute) can be fought at most 3
    times and then wins. An "off" counts as out-of-band when either an AL
    nudge was the *last command sent* (the lamp was idle in plain
    color-temperature mode), or nothing the plugin published in the last
    10s can account for it at all — the latter is what extends the defence
    to a button press while an **effect or a color** is running, which
    before v0.7.2 armed nothing. That 10s grace is also what keeps Govee's
    known spurious-OFF blip a couple of seconds after an effect command
    from being mistaken for a button press while paging through effects.
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
  The re-send is **dropped if the light is off** by the time it fires: an
  effect command carries `state: "ON"`, so re-sending it after the lamp was
  switched off during those 5s would light it back up. Before v0.7.2 that
  is exactly what happened — the guard checked only the tracked mode, which
  the optimistic cache window (longer than the 5s delay) held at `effect`
  even after the "off" report had landed.
- **Choosing which effects appear** (plugin settings page): Govee adds
  scenes over time and a lamp can report far more than HomeKit will hold —
  the Table Lamp here reports 107 against a limit of 98 inputs. The
  plugin's own settings page lists every effect gv2mqtt has discovered
  **for that specific lamp** and lets you tick the ones you want; anything
  unticked simply isn't built as an input. Ticking none means "show them
  all", which is the default and what every install had before this
  existed.

  The list has to be per-device and is only known at runtime, which
  `config.schema.json` cannot express — it is static and shared by every
  entry in the `devices` array — so this is a
  [custom UI](https://github.com/homebridge/plugin-ui-utils). It reads the
  catalog the plugin already caches in the accessory context (below), so
  it needs no broker credentials and answers instantly; a lamp only appears
  once the plugin has run and discovered its effects.

  The cap is **97**, not 98: one input slot always goes to the synthetic
  "Normal Light", which is how you leave effect mode and so can never be
  hidden. The page stops you selecting more, and the plugin truncates
  independently, so a hand-edited `config.json` can't overrun the limit
  either. Hiding an effect does **not** renumber anything — identifiers
  stay assigned across the full catalog, so re-enabling one later gives it
  back the same input identifier and Home's own cache stays in step.
  Changing the selection does rebuild the accessory's inputs once, which is
  a genuine configuration change; it happens when you edit the list, not on
  every restart.
- **Cached effect catalog**: gv2mqtt doesn't retain its discovery topic, so
  a device's real effect list only arrives ~17s into a run. Building the
  Effects accessory from the fallback list and rebuilding it when the real
  one lands is a change to the bridge's *configuration*, and HomeKit answers
  a changed configuration by re-reading every service the bridge has — with
  ~200 services across two lamps that is what makes the Home app sluggish
  for a while after every restart. Measured on 2026-09-02: the child bridge
  incremented its HomeKit configuration number exactly **three times per
  restart** (once at publish, once per lamp as its real list landed),
  reaching 351 while no other bridge in the same Homebridge was past 27.

  The effect list and its name→identifier map are therefore cached in
  `accessory.context`, which Homebridge persists, and restored before any
  service is built — so the accessory is published in its final shape and
  the discovery message that follows is a no-op. Both halves are needed:
  identifiers are handed out in first-seen order, so restoring the list
  without the map would renumber the effects and desynchronise Home's own
  input cache (see the stable-identifier note). On the first run after
  upgrading there is nothing cached, so the catalog saved is whatever that
  run ended up with — the numbering Home already knows — which is what keeps
  identifiers from shifting even once.
- **Debug logging**: every MQTT publish/receive and every characteristic
  setter call (with the state it saw and what it decided to do) is logged
  at debug level. Enable Homebridge's debug mode to see it when
  troubleshooting unexpected behavior.

## Tests

`npm test` builds the plugin and runs the suite with Node's built-in test
runner — no test dependencies to install.

The mock bridge in `test/` deliberately **answers**: every command it
receives is followed by a state report, the way gv2mqtt does, including
Govee's spurious OFF blip after an effect/color command. A silent mock —
one that accepts commands and never reports anything back — hides the
entire "whose change is it" class of bug described above, because that bug
lives only in what the plugin does with a device's unsolicited reports.
