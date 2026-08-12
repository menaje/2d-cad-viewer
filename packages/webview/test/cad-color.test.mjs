import assert from "node:assert/strict";
import test from "node:test";

import {
  aciRgb,
  cadOpacityCode,
  copyAciPalette,
  decodeCadColor,
  decodeCadOpacity,
  DEFAULT_ACI_PALETTE,
  makeBackgroundAwareAciPalette,
} from "../src/cad-color.mjs";

test("builds the full canonical ACI palette", () => {
  assert.equal(DEFAULT_ACI_PALETTE.length, 256 * 4);
  assert.deepEqual(aciRgb(1), [255, 0, 0]);
  assert.deepEqual(aciRgb(7), [255, 255, 255]);
  assert.deepEqual(aciRgb(8), [128, 128, 128]);
  assert.deepEqual(aciRgb(10), [255, 0, 0]);
  assert.deepEqual(aciRgb(11), [255, 127, 127]);
  assert.deepEqual(aciRgb(12), [165, 0, 0]);
  assert.deepEqual(aciRgb(21), [255, 159, 127]);
  assert.deepEqual(aciRgb(250), [51, 51, 51]);
  assert.deepEqual(aciRgb(255), [255, 255, 255]);
});

test("resolves TrueColor, ByLayer and ByBlock through one color path", () => {
  const aci = (2 << 30) | 140;
  const trueColor = (3 << 30) | 0x123456;
  assert.deepEqual(decodeCadColor(trueColor), [0x12, 0x34, 0x56]);
  assert.deepEqual(
    decodeCadColor(0, {
      layer: { color: aci },
    }),
    aciRgb(140),
  );
  assert.deepEqual(
    decodeCadColor(1 << 30, {
      byBlock: [12, 34, 56],
    }),
    [12, 34, 56],
  );
});

test("copies a mutable palette without sharing its backing bytes", () => {
  const copy = copyAciPalette();
  copy[4] = 7;
  assert.equal(DEFAULT_ACI_PALETTE[4], 255);
  assert.equal(copy[7], 255);
});

test("switches only ACI 7 between dark and light display backgrounds", () => {
  const dark = makeBackgroundAwareAciPalette("rgb(14 16 19)");
  const light = makeBackgroundAwareAciPalette("#fff");
  assert.deepEqual([...dark.slice(7 * 4, 7 * 4 + 4)], [255, 255, 255, 255]);
  assert.deepEqual([...light.slice(7 * 4, 7 * 4 + 4)], [0, 0, 0, 255]);
  assert.deepEqual([...light.slice(6 * 4, 6 * 4 + 4)], [255, 0, 255, 255]);
  assert.deepEqual(
    [...DEFAULT_ACI_PALETTE.slice(7 * 4, 7 * 4 + 4)],
    [255, 255, 255, 255],
  );
});

test("rejects an unresolved display background", () => {
  assert.throws(
    () => makeBackgroundAwareAciPalette("transparent"),
    /background color is invalid/u,
  );
});

test("decodes legacy, ByLayer, ByBlock and explicit CAD opacity", () => {
  assert.equal(cadOpacityCode((2 << 30) | 7), 0);
  assert.equal(decodeCadOpacity((2 << 30) | 7), 1);
  assert.equal(
    decodeCadOpacity(((1 << 24) | (2 << 30) | 7) >>> 0, {
      layer: 0.4,
    }),
    0.4,
  );
  assert.equal(
    decodeCadOpacity(((2 << 24) | (2 << 30) | 7) >>> 0, {
      byBlock: 0.65,
    }),
    0.65,
  );
  assert.equal(
    decodeCadOpacity(((33 << 24) | (2 << 30) | 7) >>> 0),
    0.5,
  );
});
