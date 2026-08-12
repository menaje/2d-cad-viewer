import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectRasterImage,
  MAX_IMAGE_REFERENCE_PIXELS,
} from "../src/raster-image";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x02,
    0xff,
    0xc0,
    0x00,
    0x07,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
  ]);
}

function bmpHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(54);
  const view = new DataView(bytes.buffer);
  bytes.set([0x42, 0x4d]);
  view.setUint32(2, bytes.byteLength, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  return bytes;
}

function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set(Buffer.from("GIF89a", "ascii"));
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

test("inspects bounded PNG metadata without decoding the image", () => {
  assert.deepEqual(inspectRasterImage(pngHeader(4_096, 2_048)), {
    mimeType: "image/png",
    width: 4_096,
    height: 2_048,
  });
});

test("inspects bounded baseline JPEG metadata", () => {
  assert.deepEqual(inspectRasterImage(jpegHeader(3_024, 2_481)), {
    mimeType: "image/jpeg",
    width: 3_024,
    height: 2_481,
  });
});

test("inspects bounded BMP and GIF metadata without decoding", () => {
  assert.deepEqual(inspectRasterImage(bmpHeader(640, -480)), {
    mimeType: "image/bmp",
    width: 640,
    height: 480,
  });
  assert.deepEqual(inspectRasterImage(gifHeader(320, 200)), {
    mimeType: "image/gif",
    width: 320,
    height: 200,
  });
});

test("rejects unsupported and excessive raster image headers", () => {
  assert.throws(
    () => inspectRasterImage(Uint8Array.from([1, 2, 3, 4])),
    /JPG, PNG, BMP 또는 GIF/u,
  );
  const invalidPng = pngHeader(10, 10);
  invalidPng[12] = 0x42;
  assert.throws(
    () => inspectRasterImage(invalidPng),
    /JPG, PNG, BMP 또는 GIF/u,
  );
  const unsupportedBmp = bmpHeader(10, 10);
  new DataView(unsupportedBmp.buffer).setUint32(14, 16, true);
  assert.throws(
    () => inspectRasterImage(unsupportedBmp),
    /JPG, PNG, BMP 또는 GIF/u,
  );
  const dimension = Math.floor(Math.sqrt(MAX_IMAGE_REFERENCE_PIXELS)) + 1;
  assert.throws(
    () => inspectRasterImage(pngHeader(dimension, dimension)),
    /해상도가 안전 한도를 초과/u,
  );
});
