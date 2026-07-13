/**
 * Govee scene effect names, in the same order used by the original mqttthing
 * "Govee Table Effects" television accessory. Index 0 is reserved for
 * "Normal Light" (i.e. no effect / plain color-temp-or-color mode).
 */
export const EFFECT_NAMES: string[] = [
  'Normal Light', 'Night Light', 'Reading', 'White Light', 'Accompany', 'Afternoon',
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
];

/**
 * Effect indices are 1-based to match the HomeKit television "Input" identifiers
 * used by the original config (value 1 = "Normal Light", i.e. no effect).
 */
export function effectIndexByName(name: string, fallback = 1): number {
  const i = EFFECT_NAMES.indexOf(name);
  return i === -1 ? fallback : i + 1;
}
