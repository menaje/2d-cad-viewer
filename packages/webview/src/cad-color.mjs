const ACI_HUES = Object.freeze([
  [255, 0, 0],
  [255, 63, 0],
  [255, 127, 0],
  [255, 191, 0],
  [255, 255, 0],
  [191, 255, 0],
  [127, 255, 0],
  [63, 255, 0],
  [0, 255, 0],
  [0, 255, 63],
  [0, 255, 127],
  [0, 255, 191],
  [0, 255, 255],
  [0, 191, 255],
  [0, 127, 255],
  [0, 63, 255],
  [0, 0, 255],
  [63, 0, 255],
  [127, 0, 255],
  [191, 0, 255],
  [255, 0, 255],
  [255, 0, 191],
  [255, 0, 127],
  [255, 0, 63],
]);
const ACI_LEVELS = Object.freeze([255, 165, 127, 76, 38]);
const DEFAULT_ENTITY_COLOR = Object.freeze([255, 255, 255]);
const TRANSPARENCY_SHIFT = 24;
const TRANSPARENCY_MASK = 0x3f;
const TRANSPARENCY_EXPLICIT_BASE = 3;
const TRANSPARENCY_EXPLICIT_STEPS =
  TRANSPARENCY_MASK - TRANSPARENCY_EXPLICIT_BASE;

function buildDefaultAciPalette() {
  const palette = new Uint8Array(256 * 4);
  const set = (index, red, green, blue) => {
    palette.set([red, green, blue, 255], index * 4);
  };
  set(0, 0, 0, 0);
  set(1, 255, 0, 0);
  set(2, 255, 255, 0);
  set(3, 0, 255, 0);
  set(4, 0, 255, 255);
  set(5, 0, 0, 255);
  set(6, 255, 0, 255);
  set(7, 255, 255, 255);
  set(8, 128, 128, 128);
  set(9, 192, 192, 192);
  for (let index = 10; index < 250; index += 1) {
    const offset = index - 10;
    const hue = ACI_HUES[Math.floor(offset / 10)];
    const shade = offset % 10;
    const level = ACI_LEVELS[Math.floor(shade / 2)];
    const saturated = hue.map((value) =>
      Math.round((value / 255) * level),
    );
    const color =
      shade % 2 === 0
        ? saturated
        : saturated.map((value) => Math.floor((value + level) / 2));
    set(index, color[0], color[1], color[2]);
  }
  for (const [index, level] of [
    [250, 51],
    [251, 80],
    [252, 105],
    [253, 130],
    [254, 190],
    [255, 255],
  ]) {
    set(index, level, level, level);
  }
  return palette;
}

export const DEFAULT_ACI_PALETTE = buildDefaultAciPalette();

function cssColorChannels(background) {
  if (Array.isArray(background) && background.length >= 3) {
    const channels = background.slice(0, 3).map(Number);
    return channels.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 255,
    )
      ? channels
      : null;
  }
  if (typeof background !== "string") {
    return null;
  }
  const value = background.trim();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu);
  if (hex) {
    const digits = hex[1].length === 3
      ? [...hex[1]].map((digit) => `${digit}${digit}`).join("")
      : hex[1];
    return [0, 2, 4].map((offset) =>
      Number.parseInt(digits.slice(offset, offset + 2), 16),
    );
  }
  const functional = value.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/iu,
  );
  if (!functional) {
    return null;
  }
  const channels = functional.slice(1, 4).map(Number);
  return channels.every(
    (channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255,
  )
    ? channels
    : null;
}

function relativeLuminance(channels) {
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

/**
 * AutoCAD treats ACI 7 as a foreground color: white on a dark canvas and
 * black on a light canvas. Other ACI entries and explicit TrueColor values
 * remain unchanged.
 */
export function makeBackgroundAwareAciPalette(
  background,
  basePalette = DEFAULT_ACI_PALETTE,
) {
  if (!(basePalette instanceof Uint8Array) || basePalette.length !== 256 * 4) {
    throw new TypeError("ACI palette payload is invalid");
  }
  const channels = cssColorChannels(background);
  if (!channels) {
    throw new TypeError("display background color is invalid");
  }
  const palette = new Uint8Array(basePalette);
  const foreground = relativeLuminance(channels) >= 0.5 ? 0 : 255;
  palette.set([foreground, foreground, foreground, 255], 7 * 4);
  return palette;
}

export function aciRgb(index, palette = DEFAULT_ACI_PALETTE) {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index > 255 ||
    !(palette instanceof Uint8Array) ||
    palette.length !== 256 * 4
  ) {
    return [...DEFAULT_ENTITY_COLOR];
  }
  const offset = index * 4;
  return [palette[offset], palette[offset + 1], palette[offset + 2]];
}

export function cadColorAci(encoded) {
  const unsigned = encoded >>> 0;
  return unsigned >>> 30 === 2 ? unsigned & 255 : 0;
}

export function decodeCadColor(
  encoded,
  {
    layer = null,
    byBlock = null,
    palette = DEFAULT_ACI_PALETTE,
  } = {},
) {
  const unsigned = encoded >>> 0;
  const kind = unsigned >>> 30;
  if (kind === 0 && layer) {
    return decodeCadColor(layer.color, {
      byBlock,
      palette,
    });
  }
  if (kind === 1) {
    return byBlock ? [...byBlock] : [...DEFAULT_ENTITY_COLOR];
  }
  if (kind === 2) {
    return aciRgb(unsigned & 255, palette);
  }
  if (kind === 3) {
    return [
      (unsigned >>> 16) & 255,
      (unsigned >>> 8) & 255,
      unsigned & 255,
    ];
  }
  return [...DEFAULT_ENTITY_COLOR];
}

export function cadOpacityCode(encoded) {
  return (encoded >>> TRANSPARENCY_SHIFT) & TRANSPARENCY_MASK;
}

export function decodeCadOpacity(
  encoded,
  {
    layer = 1,
    byBlock = 1,
  } = {},
) {
  const code = cadOpacityCode(encoded);
  if (code === 0) {
    return 1;
  }
  if (code === 1) {
    return Number.isFinite(layer)
      ? Math.max(0, Math.min(1, layer))
      : 1;
  }
  if (code === 2) {
    return Number.isFinite(byBlock)
      ? Math.max(0, Math.min(1, byBlock))
      : 1;
  }
  return Math.max(
    0,
    Math.min(
      1,
      (code - TRANSPARENCY_EXPLICIT_BASE) /
        TRANSPARENCY_EXPLICIT_STEPS,
    ),
  );
}

export function copyAciPalette(
  palette = DEFAULT_ACI_PALETTE,
  alpha = 255,
) {
  if (
    !(palette instanceof Uint8Array) ||
    palette.length !== 256 * 4 ||
    !Number.isInteger(alpha) ||
    alpha < 0 ||
    alpha > 255
  ) {
    throw new TypeError("ACI palette payload is invalid");
  }
  const copy = new Uint8Array(palette);
  for (let index = 0; index < 256; index += 1) {
    copy[index * 4 + 3] = alpha;
  }
  return copy;
}
