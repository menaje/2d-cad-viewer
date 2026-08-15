import { DEFAULT_ACI_PALETTE } from "./cad-color.mjs";

const STYLE_COUNT = 255;
const SHOW_PLOT_STYLES_FLAG = 2;

function validStyle(style) {
  return (
    style &&
    Number.isInteger(style.aci) &&
    style.aci >= 1 &&
    style.aci <= STYLE_COUNT
  );
}

function rgbFromStyle(style, palette) {
  const offset = style.aci * 4;
  if (
    Number.isInteger(style.color) &&
    style.color >= 0 &&
    style.color <= 0xffffff
  ) {
    return [
      (style.color >>> 16) & 255,
      (style.color >>> 8) & 255,
      style.color & 255,
    ];
  }
  return [palette[offset], palette[offset + 1], palette[offset + 2]];
}

export function makePlotStylePalette(
  table,
  basePalette = DEFAULT_ACI_PALETTE,
) {
  if (
    !(basePalette instanceof Uint8Array) ||
    basePalette.length !== 256 * 4 ||
    !Array.isArray(table?.styles)
  ) {
    throw new TypeError("plot style palette input is invalid");
  }
  const palette = new Uint8Array(basePalette);
  for (const style of table.styles) {
    if (!validStyle(style)) {
      continue;
    }
    let [red, green, blue] = rgbFromStyle(style, palette);
    if (style.grayscale) {
      const gray = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
      red = gray;
      green = gray;
      blue = gray;
    }
    const screen = Number.isFinite(style.screen)
      ? Math.max(0, Math.min(100, style.screen)) / 100
      : 1;
    red = Math.round(255 - (255 - red) * screen);
    green = Math.round(255 - (255 - green) * screen);
    blue = Math.round(255 - (255 - blue) * screen);
    palette.set([red, green, blue, 255], style.aci * 4);
  }
  return palette;
}

export function plotStyleShownInLayout(layout) {
  return Boolean(
    Number.isInteger(layout?.plotFlags) &&
      (layout.plotFlags & SHOW_PLOT_STYLES_FLAG),
  );
}

export function resolveScreenPlotStyleEnabled(preference, layout) {
  return preference === undefined
    ? plotStyleShownInLayout(layout)
    : preference === true;
}

export function makePlotStyleLineWeights(table) {
  if (!Array.isArray(table?.styles)) {
    throw new TypeError("plot style lineweight input is invalid");
  }
  const lineWeights = new Int16Array(256);
  lineWeights.fill(-1);
  for (const style of table.styles) {
    if (
      validStyle(style) &&
      Number.isInteger(style.lineWeight) &&
      style.lineWeight >= 0 &&
      style.lineWeight <= 211
    ) {
      lineWeights[style.aci] = style.lineWeight;
    }
  }
  return lineWeights;
}

export function plotStyleDiagnostics(table) {
  const styles = Array.isArray(table?.styles)
    ? table.styles.filter(validStyle)
    : [];
  return Object.freeze({
    styles: styles.length,
    colorOverrides: styles.filter((style) =>
      Number.isInteger(style.color),
    ).length,
    grayscaleStyles: styles.filter((style) => style.grayscale).length,
    screenedStyles: styles.filter(
      (style) => Number.isFinite(style.screen) && style.screen < 100,
    ).length,
    lineWeightOverrides: styles.filter((style) =>
      Number.isInteger(style.lineWeight),
    ).length,
  });
}
