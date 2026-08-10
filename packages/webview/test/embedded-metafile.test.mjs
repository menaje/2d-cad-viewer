// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { renderEmbeddedEmf } from "../src/embedded-metafile.mjs";

function pngDataUrl(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

test("renders a bounded embedded EMF into validated PNG bytes", async () => {
  let receivedOptions;
  const result = await renderEmbeddedEmf(new Uint8Array(88), {
    convert: async (source, options) => {
      assert.equal(source.byteLength, 88);
      receivedOptions = options;
      return pngDataUrl(1_835, 949);
    },
  });

  assert.deepEqual(receivedOptions, {
    dpiScale: 1,
    maxWidth: 4_096,
    maxHeight: 4_096,
    maxCanvasDimension: 4_096,
    maxRecords: 200_000,
  });
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.width, 1_835);
  assert.equal(result.height, 949);
  assert.equal(result.bytes.byteLength, 24);
});

test("rejects invalid embedded EMF input and renderer output", async () => {
  await assert.rejects(
    renderEmbeddedEmf(new Uint8Array(87), {
      convert: async () => pngDataUrl(16, 16),
    }),
    /byte limits/u,
  );
  await assert.rejects(
    renderEmbeddedEmf(new Uint8Array(88), {
      convert: async () => "data:image/jpeg;base64,AA==",
    }),
    /invalid PNG/u,
  );
  await assert.rejects(
    renderEmbeddedEmf(new Uint8Array(88), {
      convert: async () => pngDataUrl(4_097, 1),
    }),
    /dimensions/u,
  );
});
