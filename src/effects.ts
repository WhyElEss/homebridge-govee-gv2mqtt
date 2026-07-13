export const NORMAL_LIGHT = 'Normal Light';

/**
 * gv2mqtt reports a couple of effect names with a non-breaking space (U+00A0)
 * between words instead of a normal space. This only matters for
 * FALLBACK_EFFECT_NAMES below: once the real per-device list is discovered
 * (see GoveeDevice), whatever gv2mqtt reports is used verbatim, so this
 * category of mismatch can't happen there.
 */
const FALLBACK_WIRE_OVERRIDES: Record<string, string> = {
  'Spring Wind': 'Spring\u00A0Wind',
  'Milky Way': 'Milky\u00A0Way',
};

/**
 * Static effect list for a Govee Table Lamp 2, used only until the real
 * per-device list is discovered from gv2mqtt's Home Assistant MQTT discovery
 * config for the light entity (see GoveeDevice.effectNames). Keeps the
 * Effects accessory populated during the ~15s gap right after a restart, and
 * is a safety net if discovery never arrives (e.g. an older gv2mqtt version).
 * Other Govee Table Lamp models may report a different real list.
 */
export const FALLBACK_EFFECT_NAMES: string[] = [
  'Night Light', 'Reading', 'White Light', 'Accompany', 'Afternoon',
  'Breathe', 'Dreamland', 'Dreamlike', 'Healing', 'Leisure', 'Morning', 'Refreshing',
  'Soothing', 'Sunrise', 'Sunset', 'Sunset Glow', 'Aurora', 'Cherry blossoms', 'Desert',
  'Falling Petals', 'Feather', 'Fire', 'Firefly', 'Fish Tank', 'Forest', 'Goldfish',
  'Karst Cave', 'Kitchen Aromas', 'Lake', 'Mountain Forest', 'Ocean', 'Rainbow', 'Raining',
  'Sky', 'Snow flake', 'Spring Wind', 'Train', 'Wave', 'Fall', 'Spring', 'Summer', 'Winter',
  'Earth', 'Jupiter', 'Mars', 'Milky Way', 'Mysterious', 'Night', 'Starry Sky', 'Uranus',
  'Venus', 'Flash', 'Gradient', 'Graffiti', 'Heartbeat', 'Interlaced', 'Joyful',
  "Rubik's Cube", 'Smudge', 'Swing', 'Gary', 'Judy', 'Nick', 'ZDP Trio', 'Candy Cane',
  'Christmas', 'Christmas Baubles', 'Christmas Bell', 'Christmas Eve', 'Christmas Gift',
  'Christmas Stocking', 'Christmas Stripe', 'Christmas Tree', 'Christmas Wreath',
  'Gingerbread Man', 'Santa Claus', 'Santa Hat', 'Snow House', 'Ghost', 'Grim Graveyard',
  'Halloween', 'Halloween Witches', 'Lightning Bats', 'Poison', 'Easter Egg',
  "Saint Patrick's Day", 'Thanksgiving', "Valentine's Day", 'Colour Painting', 'Dandelion',
  'Energic', 'Hopping', 'Light Waves', 'Meteor Shower', 'Rhythm', 'Spectrum',
].map((name) => FALLBACK_WIRE_OVERRIDES[name] ?? name);

/**
 * Builds the full Television "Inputs" list for a device: index 0 is always
 * the synthetic "Normal Light" (no effect active - not a real Govee scene),
 * followed by whatever effect names are currently known for that device -
 * either the real per-device list discovered over MQTT, or
 * FALLBACK_EFFECT_NAMES.
 */
export function buildEffectNames(discovered: string[] | null): string[] {
  const effects = discovered && discovered.length > 0 ? discovered : FALLBACK_EFFECT_NAMES;
  return [NORMAL_LIGHT, ...effects];
}

/**
 * Effect indices are 1-based to match the HomeKit television "Input"
 * identifiers (value 1 = "Normal Light", i.e. no effect).
 */
export function effectIndexByName(effectNames: string[], name: string, fallback = 1): number {
  const i = effectNames.indexOf(name);
  return i === -1 ? fallback : i + 1;
}
