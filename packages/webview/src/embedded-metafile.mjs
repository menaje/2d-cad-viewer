// SPDX-License-Identifier: MPL-2.0

const MAXIMUM_EMF_BYTES = 64 * 1024 * 1024;
const MAXIMUM_PNG_BYTES = 64 * 1024 * 1024;
const MAXIMUM_CANVAS_DIMENSION = 4_096;
const MAXIMUM_EMF_RECORDS = 200_000;
const MAXIMUM_IMAGE_PIXELS = 100_000_000;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Object.freeze([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
let emfConverterModulePromise;

async function defaultConvertEmf(source, options) {
  emfConverterModulePromise ??= import(
    new URL(
      "./emf-converter-runtime.mjs?v=1.25.0",
      import.meta.url,
    ).href
  );
  const module = await emfConverterModulePromise;
  return module.convertEmfToDataUrl(source, options);
}

function normalizedBytes(value) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("embedded EMF payload must be binary data");
}

function decodePngDataUrl(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith(PNG_DATA_URL_PREFIX) ||
    value.length > Math.ceil((MAXIMUM_PNG_BYTES * 4) / 3) + 128
  ) {
    throw new Error("embedded EMF renderer returned an invalid PNG");
  }
  let binary;
  try {
    binary = globalThis.atob(value.slice(PNG_DATA_URL_PREFIX.length));
  } catch {
    throw new Error("embedded EMF renderer returned invalid PNG encoding");
  }
  if (binary.length === 0 || binary.length > MAXIMUM_PNG_BYTES) {
    throw new Error("embedded EMF PNG exceeds its byte limit");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function pngDimensions(bytes) {
  if (
    bytes.length < 24 ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value) ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    throw new Error("embedded EMF renderer returned a malformed PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const pixels = width * height;
  if (
    width === 0 ||
    height === 0 ||
    width > MAXIMUM_CANVAS_DIMENSION ||
    height > MAXIMUM_CANVAS_DIMENSION ||
    !Number.isSafeInteger(pixels) ||
    pixels > MAXIMUM_IMAGE_PIXELS
  ) {
    throw new Error("embedded EMF PNG dimensions exceed their limits");
  }
  return Object.freeze({ width, height });
}

export async function renderEmbeddedEmf(
  payload,
  { convert = defaultConvertEmf } = {},
) {
  const source = normalizedBytes(payload);
  if (source.byteLength < 88 || source.byteLength > MAXIMUM_EMF_BYTES) {
    throw new Error("embedded EMF payload exceeds its byte limits");
  }
  const ownedSource = source.buffer.slice(
    source.byteOffset,
    source.byteOffset + source.byteLength,
  );
  const dataUrl = await convert(ownedSource, {
    dpiScale: 1,
    maxWidth: MAXIMUM_CANVAS_DIMENSION,
    maxHeight: MAXIMUM_CANVAS_DIMENSION,
    maxCanvasDimension: MAXIMUM_CANVAS_DIMENSION,
    maxRecords: MAXIMUM_EMF_RECORDS,
  });
  const bytes = decodePngDataUrl(dataUrl);
  const { width, height } = pngDimensions(bytes);
  return Object.freeze({
    bytes,
    mimeType: "image/png",
    width,
    height,
  });
}
