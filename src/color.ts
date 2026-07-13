export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface HueSaturation {
  hue: number;
  saturation: number;
}

/** Standard RGB -> HSV, discarding value (brightness is tracked separately). */
export function rgbToHueSat(r: number, g: number, b: number): HueSaturation {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === rf) {
      hue = ((gf - bf) / delta) % 6;
    } else if (max === gf) {
      hue = (bf - rf) / delta + 2;
    } else {
      hue = (rf - gf) / delta + 4;
    }
    hue *= 60;
    if (hue < 0) {
      hue += 360;
    }
  }

  const saturation = max === 0 ? 0 : delta / max;
  return { hue: Math.round(hue), saturation: Math.round(saturation * 100) };
}

/** Standard HSV -> RGB. `value` (0-100) should be the currently known Brightness. */
export function hueSatToRgb(hue: number, saturation: number, value: number): RGB {
  const h = (hue % 360) / 60;
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const v = Math.max(0, Math.min(100, value)) / 100;

  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 1) {
    [r1, g1, b1] = [c, x, 0];
  } else if (h < 2) {
    [r1, g1, b1] = [x, c, 0];
  } else if (h < 3) {
    [r1, g1, b1] = [0, c, x];
  } else if (h < 4) {
    [r1, g1, b1] = [0, x, c];
  } else if (h < 5) {
    [r1, g1, b1] = [x, 0, c];
  } else {
    [r1, g1, b1] = [c, 0, x];
  }

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}
