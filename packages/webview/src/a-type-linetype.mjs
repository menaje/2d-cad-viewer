const GPU_LINE_VERTEX_RECORD_SIZE = 36;
const LAYER_INDEX_OFFSET = 12;
const STYLE_OFFSET = 28;
const PATTERN_DISTANCE_OFFSET = 32;
const SOURCE_KIND_SHIFT = 17;
const SOURCE_KIND_MASK = 0xf;
const LINE_SOURCE_KIND = 0;
const MAX_PACKED_LAYER_INDEX = 0xffff;
const MAX_FINITE_EXTENT_CODE = 0xfffe;
const OVERFLOW_EXTENT_CODE = 0xffff;
const MIN_LOG2_EXTENT = -64;
const MAX_LOG2_EXTENT = 64;
const FINITE_EXTENT_STEPS = MAX_FINITE_EXTENT_CODE - 1;
const LOG2_EXTENT_SPAN = MAX_LOG2_EXTENT - MIN_LOG2_EXTENT;

const preservedExtentCodes = new WeakMap();

function decodedPatternDistance(value) {
  return value < 0 ? -value - 1 : value;
}

/**
 * Encodes a conservative upper bound so a quantization error can never turn
 * a segment that fits a complete pattern into a short-segment fallback.
 */
export function encodeATypeLineExtent(extent) {
  if (!Number.isFinite(extent) || extent <= 0) {
    return 0;
  }
  const exponent = Math.log2(extent);
  if (!Number.isFinite(exponent) || exponent > MAX_LOG2_EXTENT) {
    return OVERFLOW_EXTENT_CODE;
  }
  if (exponent <= MIN_LOG2_EXTENT) {
    return 1;
  }
  const bucket = Math.ceil(
    ((exponent - MIN_LOG2_EXTENT) / LOG2_EXTENT_SPAN) *
      FINITE_EXTENT_STEPS,
  );
  return Math.min(MAX_FINITE_EXTENT_CODE, bucket + 1);
}

export function decodeATypeLineExtent(code) {
  if (!Number.isInteger(code) || code <= 0 || code > OVERFLOW_EXTENT_CODE) {
    return 0;
  }
  if (code === OVERFLOW_EXTENT_CODE) {
    return Number.POSITIVE_INFINITY;
  }
  return 2 **
    (MIN_LOG2_EXTENT +
      ((code - 1) / FINITE_EXTENT_STEPS) * LOG2_EXTENT_SPAN);
}

function validateLineBuffer(buffer, recordSize) {
  if (
    !(buffer instanceof ArrayBuffer) ||
    !Number.isSafeInteger(recordSize) ||
    recordSize < GPU_LINE_VERTEX_RECORD_SIZE ||
    buffer.byteLength % recordSize !== 0 ||
    (buffer.byteLength / recordSize) % 2 !== 0
  ) {
    throw new TypeError("A-type linetype vertex payload is inconsistent");
  }
}

/**
 * Captures standalone LINE extents before draw-order composition reuses the
 * diagnostic style bits. The result is associated with the source buffer and
 * does not mutate Scene Cache data.
 */
export function preserveATypeLineExtents(
  buffer,
  { recordSize = GPU_LINE_VERTEX_RECORD_SIZE } = {},
) {
  validateLineBuffer(buffer, recordSize);
  const existing = preservedExtentCodes.get(buffer);
  if (existing && existing.recordSize === recordSize) {
    return existing.codes;
  }

  const view = new DataView(buffer);
  const vertexCount = buffer.byteLength / recordSize;
  const codes = new Uint16Array(vertexCount);
  let hasExtent = false;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (
      view.getUint32(vertex * recordSize + LAYER_INDEX_OFFSET, true) >
      MAX_PACKED_LAYER_INDEX
    ) {
      preservedExtentCodes.set(buffer, { recordSize, codes: null });
      return null;
    }
  }

  for (let vertex = 0; vertex < vertexCount; vertex += 2) {
    const firstOffset = vertex * recordSize;
    const lastOffset = firstOffset + recordSize;
    const firstStyle = view.getUint32(firstOffset + STYLE_OFFSET, true);
    const lastStyle = view.getUint32(lastOffset + STYLE_OFFSET, true);
    const firstSourceKind =
      (firstStyle >>> SOURCE_KIND_SHIFT) & SOURCE_KIND_MASK;
    const lastSourceKind =
      (lastStyle >>> SOURCE_KIND_SHIFT) & SOURCE_KIND_MASK;
    if (
      firstSourceKind !== LINE_SOURCE_KIND ||
      lastSourceKind !== LINE_SOURCE_KIND
    ) {
      continue;
    }
    const firstDistance = decodedPatternDistance(
      view.getFloat32(firstOffset + PATTERN_DISTANCE_OFFSET, true),
    );
    const lastDistance = decodedPatternDistance(
      view.getFloat32(lastOffset + PATTERN_DISTANCE_OFFSET, true),
    );
    const code = encodeATypeLineExtent(
      Math.abs(lastDistance - firstDistance),
    );
    if (code === 0) {
      continue;
    }
    codes[vertex] = code;
    codes[vertex + 1] = code;
    hasExtent = true;
  }

  const result = hasExtent ? codes : null;
  preservedExtentCodes.set(buffer, { recordSize, codes: result });
  return result;
}

/**
 * Packs the optional extent code into otherwise unused high layer-index bits
 * of a transient WebGL upload copy. Source buffers and CPU layer indices stay
 * unchanged; drawings with more than 65,536 layers fail closed to the normal
 * rendering path.
 */
export function packATypeLineExtentsForUpload(
  buffer,
  {
    recordSize = GPU_LINE_VERTEX_RECORD_SIZE,
    enabled = true,
  } = {},
) {
  if (!enabled) {
    return Object.freeze({ buffer, packed: false });
  }
  validateLineBuffer(buffer, recordSize);
  if (buffer.byteLength === 0) {
    return Object.freeze({ buffer, packed: false });
  }
  const codes = preserveATypeLineExtents(buffer, { recordSize });
  if (!codes) {
    return Object.freeze({ buffer, packed: false });
  }
  const upload = buffer.slice(0);
  const view = new DataView(upload);
  for (let vertex = 0; vertex < codes.length; vertex += 1) {
    const code = codes[vertex];
    const offset = vertex * recordSize + LAYER_INDEX_OFFSET;
    const layerIndex = view.getUint32(offset, true);
    view.setUint32(offset, layerIndex | (code << 16), true);
  }
  return Object.freeze({ buffer: upload, packed: true });
}
