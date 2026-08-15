import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeATypeLineExtent,
  encodeATypeLineExtent,
  packATypeLineExtentsForUpload,
  preserveATypeLineExtents,
} from "../src/a-type-linetype.mjs";

const RECORD_SIZE = 36;

function lineBuffer({ layerIndex = 7, extent = 0.5 } = {}) {
  const buffer = new ArrayBuffer(RECORD_SIZE * 2);
  const view = new DataView(buffer);
  for (let endpoint = 0; endpoint < 2; endpoint += 1) {
    const offset = endpoint * RECORD_SIZE;
    view.setUint32(offset + 12, layerIndex, true);
    view.setUint32(offset + 28, 3 << 5, true);
    view.setFloat32(offset + 32, endpoint * extent, true);
  }
  return buffer;
}

test("encodes finite A-type LINE extents as conservative upper bounds", () => {
  for (const extent of [2 ** -64, 0.5, 1, 1234.5, 2 ** 64]) {
    const code = encodeATypeLineExtent(extent);
    const decoded = decodeATypeLineExtent(code);
    assert.ok(code > 0);
    assert.ok(decoded >= extent);
    assert.ok(decoded / extent < 1.002);
  }
  assert.equal(encodeATypeLineExtent(0), 0);
  assert.equal(decodeATypeLineExtent(0), 0);
  assert.equal(
    decodeATypeLineExtent(encodeATypeLineExtent(2 ** 65)),
    Number.POSITIVE_INFINITY,
  );
});

test("packs A-type extent metadata into a transient layer-index copy", () => {
  const buffer = lineBuffer();
  const source = new DataView(buffer);
  const packed = packATypeLineExtentsForUpload(buffer);
  const upload = new DataView(packed.buffer);

  assert.equal(packed.packed, true);
  assert.notEqual(packed.buffer, buffer);
  assert.equal(source.getUint32(12, true), 7);
  assert.equal(upload.getUint32(12, true) & 0xffff, 7);
  const code = upload.getUint32(12, true) >>> 16;
  assert.ok(decodeATypeLineExtent(code) >= 0.5);
  assert.equal(upload.getUint32(12 + RECORD_SIZE, true) >>> 16, code);
});

test("retains extents captured before draw-order style bits are replaced", () => {
  const buffer = lineBuffer({ extent: 0.25 });
  preserveATypeLineExtents(buffer);
  const view = new DataView(buffer);
  view.setUint32(28, 0xfffe_0000, true);
  view.setUint32(28 + RECORD_SIZE, 0xfffe_0000, true);

  const packed = packATypeLineExtentsForUpload(buffer);
  assert.equal(packed.packed, true);
  assert.ok(new DataView(packed.buffer).getUint32(12, true) >>> 16);
});

test("fails closed when a source layer index needs the high bits", () => {
  const buffer = lineBuffer({ layerIndex: 65_536 });
  const packed = packATypeLineExtentsForUpload(buffer);

  assert.equal(packed.packed, false);
  assert.equal(packed.buffer, buffer);
});

