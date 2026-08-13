// Canonical Scene Cache reader shared by DwgSceneCacheSource and legacy Webview imports.
export const CACHE_MAGIC = new Uint8Array([68, 87, 71, 83, 67, 78, 49, 0]);
export const CACHE_VERSION_MAJOR = 1;
export const CACHE_VERSION_MINOR = 26;
export const MINIMUM_CACHE_VERSION_MINOR = 21;
export const HEADER_SIZE = 64;
export const DIRECTORY_ENTRY_SIZE = 40;
export const CACHE_HEADER_FLAG_PREVIEW = 1;
export const LINE_RECORD_SIZE = 80;
export const GPU_LINE_BATCH_RECORD_SIZE = 128;
export const GPU_LINE_VERTEX_RECORD_SIZE = 36;
export const TEXT_STYLE_RECORD_SIZE = 96;
export const TEXT_ENTITY_RECORD_SIZE = 336;
export const TEXT_COLUMN_HEIGHT_RECORD_SIZE = 8;
export const ARC_RECORD_SIZE = 112;
export const CIRCLE_RECORD_SIZE = 96;
export const POLYLINE_HEADER_RECORD_SIZE = 112;
export const POLYLINE_VERTEX_RECORD_SIZE = 64;
export const ELLIPSE_RECORD_SIZE = 128;
export const SPLINE_HEADER_RECORD_SIZE = 208;
export const SPLINE_SCALAR_RECORD_SIZE = 8;
export const SPLINE_POINT_RECORD_SIZE = 24;
export const HATCH_ENTITY_RECORD_SIZE = 192;
export const HATCH_LOOP_RECORD_SIZE = 48;
export const HATCH_VERTEX_RECORD_SIZE = 24;
export const HATCH_GRADIENT_COLOR_RECORD_SIZE = 16;
export const HATCH_SEED_POINT_RECORD_SIZE = 16;
export const HATCH_PATTERN_LINE_RECORD_SIZE = 72;
export const HATCH_PATTERN_DASH_RECORD_SIZE = 8;
export const POINT_ENTITY_RECORD_SIZE = 112;
export const SOLID_ENTITY_RECORD_SIZE = 168;
export const FACE_ENTITY_RECORD_SIZE = 136;
export const WIPEOUT_ENTITY_RECORD_SIZE = 168;
export const WIPEOUT_CLIP_VERTEX_RECORD_SIZE = 16;
export const DRAW_ORDER_TABLE_RECORD_SIZE = 40;
export const DRAW_ORDER_ENTRY_RECORD_SIZE = 16;
export const INSERT_CLIP_RECORD_SIZE = 32;
export const INSERT_CLIP_VERTEX_RECORD_SIZE = 16;
export const LINETYPE_RECORD_SIZE = 64;
export const LINETYPE_DASH_RECORD_SIZE = 72;
export const LAYOUT_RECORD_SIZE = 256;
export const VIEWPORT_RECORD_SIZE = 272;
export const VIEWPORT_FROZEN_LAYER_RECORD_SIZE = 8;
export const VIEWPORT_CLIP_VERTEX_RECORD_SIZE = 16;
export const IMAGE_ENTITY_RECORD_SIZE = 176;
export const IMAGE_CLIP_VERTEX_RECORD_SIZE = 16;
export const TEXT_ANNOTATION_CONTEXT_RECORD_SIZE = 160;
export const TEXT_ANNOTATION_COLUMN_HEIGHT_RECORD_SIZE = 8;
export const VIEWPORT_LAYER_OVERRIDE_RECORD_SIZE = 24;
export const EMBEDDED_IMAGE_RECORD_SIZE = 40;
export const EMBEDDED_IMAGE_BYTE_RECORD_SIZE = 1;
export const CURVE_LINETYPE_SCALE_RECORD_SIZE = 16;
export const CONSTRUCTION_LINE_RECORD_SIZE = 80;
export const DEFAULT_MAX_DISPLAY_ORDER_IDENTITY_RECORDS = 10_000;
export const DEFAULT_MAX_DISPLAY_ORDER_IDENTITY_BYTES = 8 * 1024 * 1024;

export const SectionKind = Object.freeze({
  Drawing: 1,
  Layers: 2,
  Blocks: 3,
  TextStyles: 4,
  Lines: 10,
  Arcs: 11,
  Circles: 12,
  Inserts: 13,
  PolylineHeaders: 14,
  PolylineVertices: 15,
  Ellipses: 16,
  SplineHeaders: 17,
  SplineKnots: 18,
  SplineWeights: 19,
  SplineControlPoints: 20,
  SplineFitPoints: 21,
  TextEntities: 22,
  TextColumnHeights: 23,
  GpuLineBatches: 30,
  GpuLineVertices: 31,
  HatchEntities: 32,
  HatchLoops: 33,
  HatchVertices: 34,
  HatchGradientColors: 35,
  HatchSeedPoints: 36,
  HatchPatternLines: 37,
  HatchPatternDashes: 38,
  PointEntities: 39,
  SolidEntities: 40,
  FaceEntities: 41,
  WipeoutEntities: 42,
  WipeoutClipVertices: 43,
  DrawOrderTables: 44,
  DrawOrderEntries: 45,
  InsertClips: 46,
  InsertClipVertices: 47,
  Linetypes: 48,
  LinetypeDashes: 49,
  Layouts: 50,
  Viewports: 51,
  ViewportFrozenLayers: 52,
  ViewportClipVertices: 53,
  ImageEntities: 54,
  ImageClipVertices: 55,
  TextAnnotationContexts: 56,
  TextAnnotationColumnHeights: 57,
  ViewportLayerOverrides: 58,
  EmbeddedImageRecords: 59,
  EmbeddedImageBytes: 60,
  CurveLinetypeScales: 61,
  ConstructionLines: 62,
});
const CURRENT_SECTION_KINDS = Object.freeze(Object.values(SectionKind));
const LEGACY_SECTION_KINDS = Object.freeze(
  CURRENT_SECTION_KINDS.filter(
    (kind) =>
      kind !== SectionKind.CurveLinetypeScales &&
      kind !== SectionKind.ConstructionLines,
  ),
);

export const GpuLineBatchKind = Object.freeze({
  ModelOverview: 0,
  ModelDetail: 1,
  BlockDefinition: 2,
});

const FIXED_RECORD_SIZES = new Map([
  [SectionKind.Lines, LINE_RECORD_SIZE],
  [SectionKind.Arcs, ARC_RECORD_SIZE],
  [SectionKind.Circles, CIRCLE_RECORD_SIZE],
  [SectionKind.PolylineHeaders, POLYLINE_HEADER_RECORD_SIZE],
  [SectionKind.PolylineVertices, POLYLINE_VERTEX_RECORD_SIZE],
  [SectionKind.Ellipses, ELLIPSE_RECORD_SIZE],
  [SectionKind.SplineHeaders, SPLINE_HEADER_RECORD_SIZE],
  [SectionKind.SplineKnots, SPLINE_SCALAR_RECORD_SIZE],
  [SectionKind.SplineWeights, SPLINE_SCALAR_RECORD_SIZE],
  [SectionKind.SplineControlPoints, SPLINE_POINT_RECORD_SIZE],
  [SectionKind.SplineFitPoints, SPLINE_POINT_RECORD_SIZE],
  [SectionKind.Inserts, 136],
  [SectionKind.TextColumnHeights, TEXT_COLUMN_HEIGHT_RECORD_SIZE],
  [SectionKind.GpuLineBatches, GPU_LINE_BATCH_RECORD_SIZE],
  [SectionKind.HatchLoops, HATCH_LOOP_RECORD_SIZE],
  [SectionKind.HatchVertices, HATCH_VERTEX_RECORD_SIZE],
  [SectionKind.HatchGradientColors, HATCH_GRADIENT_COLOR_RECORD_SIZE],
  [SectionKind.HatchSeedPoints, HATCH_SEED_POINT_RECORD_SIZE],
  [SectionKind.HatchPatternLines, HATCH_PATTERN_LINE_RECORD_SIZE],
  [SectionKind.HatchPatternDashes, HATCH_PATTERN_DASH_RECORD_SIZE],
  [SectionKind.PointEntities, POINT_ENTITY_RECORD_SIZE],
  [SectionKind.SolidEntities, SOLID_ENTITY_RECORD_SIZE],
  [SectionKind.FaceEntities, FACE_ENTITY_RECORD_SIZE],
  [SectionKind.WipeoutEntities, WIPEOUT_ENTITY_RECORD_SIZE],
  [SectionKind.WipeoutClipVertices, WIPEOUT_CLIP_VERTEX_RECORD_SIZE],
  [SectionKind.DrawOrderTables, DRAW_ORDER_TABLE_RECORD_SIZE],
  [SectionKind.DrawOrderEntries, DRAW_ORDER_ENTRY_RECORD_SIZE],
  [SectionKind.InsertClips, INSERT_CLIP_RECORD_SIZE],
  [SectionKind.InsertClipVertices, INSERT_CLIP_VERTEX_RECORD_SIZE],
  [
    SectionKind.ViewportFrozenLayers,
    VIEWPORT_FROZEN_LAYER_RECORD_SIZE,
  ],
  [
    SectionKind.ViewportClipVertices,
    VIEWPORT_CLIP_VERTEX_RECORD_SIZE,
  ],
  [SectionKind.ImageClipVertices, IMAGE_CLIP_VERTEX_RECORD_SIZE],
  [
    SectionKind.TextAnnotationContexts,
    TEXT_ANNOTATION_CONTEXT_RECORD_SIZE,
  ],
  [
    SectionKind.TextAnnotationColumnHeights,
    TEXT_ANNOTATION_COLUMN_HEIGHT_RECORD_SIZE,
  ],
  [
    SectionKind.ViewportLayerOverrides,
    VIEWPORT_LAYER_OVERRIDE_RECORD_SIZE,
  ],
  [SectionKind.EmbeddedImageRecords, EMBEDDED_IMAGE_RECORD_SIZE],
  [SectionKind.EmbeddedImageBytes, EMBEDDED_IMAGE_BYTE_RECORD_SIZE],
  [SectionKind.CurveLinetypeScales, CURVE_LINETYPE_SCALE_RECORD_SIZE],
  [SectionKind.ConstructionLines, CONSTRUCTION_LINE_RECORD_SIZE],
]);
const MAX_METADATA_SECTION_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_STRING_BYTES = 1024 * 1024;
const MAX_OVERVIEW_BYTES = 8 * 1024 * 1024;
const MAX_DETAIL_BATCH_BYTES = 512 * 1024;
const MAX_REVIEW_CURVE_BYTES = 8 * 1024 * 1024;
const MAX_CURVE_SOURCE_RANGE_BYTES = 512 * 1024;
const MAX_CURVE_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_HATCH_SOURCE_RECORDS = 1_048_576;
const MAX_HATCH_PATTERN_LINES = 262_144;
const MAX_HATCH_PATTERN_LINES_PER_ENTITY = 4_096;
const MAX_HATCH_PATTERN_DASHES_PER_ENTITY = 65_536;
const MAX_POINT_SOURCE_RECORDS = 262_144;
const MAX_SOLID_SOURCE_RECORDS = 131_072;
const MAX_FACE_SOURCE_RECORDS = 131_072;
const MAX_WIPEOUT_SOURCE_RECORDS = 65_536;
const MAX_WIPEOUT_CLIP_VERTICES = 1_048_576;
const MAX_DRAW_ORDER_TABLES = 65_536;
const MAX_DRAW_ORDER_ENTRIES = 1_048_576;
const MAX_INSERT_CLIPS = 65_536;
const MAX_INSERT_CLIP_VERTICES = 1_048_576;
const MAX_INSERT_CLIP_VERTICES_PER_BOUNDARY = 256;
const MAX_LINETYPES = 2_045;
const MAX_LINETYPE_DASHES = 131_072;
const MAX_LAYOUTS = 1_024;
const MAX_VIEWPORTS = 65_536;
const MAX_VIEWPORT_FROZEN_LAYERS = 1_048_576;
const MAX_VIEWPORT_CLIP_VERTICES = 1_048_576;
const MAX_VIEWPORT_CLIP_VERTICES_PER_BOUNDARY = 4_096;
const MAX_VIEWPORT_LAYER_OVERRIDES = 1_048_576;
const MAX_IMAGE_SOURCE_RECORDS = 65_536;
const MAX_IMAGE_CLIP_VERTICES = 1_048_576;
const MAX_EMBEDDED_IMAGE_BYTES = 512 * 1024 * 1024;
const MAX_EMBEDDED_IMAGE_BYTES_PER_RECORD = 64 * 1024 * 1024;
const MAX_EMBEDDED_IMAGE_PIXELS = 100_000_000;
const MAX_TEXT_ANNOTATION_CONTEXTS = 262_144;
const MAX_TEXT_ANNOTATION_COLUMN_HEIGHTS = 1_048_576;
const MAX_TEXT_ANNOTATION_COLUMN_HEIGHTS_PER_CONTEXT = 64;
const STRING_TABLE_HEADER_SIZE = 16;
const STRING_TABLE_FLAG = 1;
const EMPTY_ARRAY = Object.freeze([]);

export const TextEntityKind = Object.freeze({
  Text: 0,
  MText: 1,
  AttributeDefinition: 2,
  Attribute: 3,
});

export const InsertClipFlags = Object.freeze({
  Rectangular: 1,
  Inverted: 1 << 1,
});

export const ViewportLayerOverrideProperty = Object.freeze({
  Color: 1,
  Transparency: 2,
  Linetype: 3,
  LineWeight: 4,
});

export const ViewportLayerOverrideFlags = Object.freeze({
  Color: 1,
  Transparency: 1 << 1,
  Linetype: 1 << 2,
  LineWeight: 1 << 3,
});

export const HatchFlags = Object.freeze({
  Solid: 1,
  Associative: 1 << 1,
  Double: 1 << 2,
  Gradient: 1 << 3,
  SingleColorGradient: 1 << 4,
  Truncated: 1 << 5,
  BackgroundColor: 1 << 6,
});

export const HatchStyle = Object.freeze({
  Normal: 0,
  Outer: 1,
  Ignore: 2,
});

function requireArrayBuffer(buffer, expectedLength, label) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new TypeError(`${label} reader did not return an ArrayBuffer`);
  }
  if (buffer.byteLength !== expectedLength) {
    throw new Error(
      `${label} is truncated: expected ${expectedLength} bytes, received ${buffer.byteLength}`,
    );
  }
  return buffer;
}

function readSafeU64(view, offset, label) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds JavaScript's safe integer limit`);
  }
  return Number(value);
}

function checkedMultiply(left, right, label) {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds JavaScript's safe integer limit`);
  }
  return value;
}

function checkedAdd(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds JavaScript's safe integer limit`);
  }
  return value;
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function readVec3F64(view, offset) {
  return [
    view.getFloat64(offset, true),
    view.getFloat64(offset + 8, true),
    view.getFloat64(offset + 16, true),
  ];
}

function ensureFiniteVector(vector, label) {
  if (!vector.every(Number.isFinite)) {
    throw new Error(`${label} contains a non-finite coordinate`);
  }
  return vector;
}

function validateRecordSection(entry, expectedRecordSize) {
  if (entry.recordSize !== expectedRecordSize) {
    throw new Error(
      `section ${entry.kind} record size is ${entry.recordSize}, expected ${expectedRecordSize}`,
    );
  }
  const expectedBytes = checkedMultiply(
    entry.recordCount,
    entry.recordSize,
    `section ${entry.kind} byte length`,
  );
  if (entry.byteLength !== expectedBytes) {
    throw new Error(`section ${entry.kind} byte length does not match its records`);
  }
  if (entry.flags !== 0) {
    throw new Error(`section ${entry.kind} has unsupported flags`);
  }
}

function validateStringTableDirectoryEntry(entry, expectedRecordSize) {
  if (
    entry.recordSize !== expectedRecordSize ||
    entry.flags !== STRING_TABLE_FLAG ||
    entry.byteLength < STRING_TABLE_HEADER_SIZE
  ) {
    throw new Error(`section ${entry.kind} has invalid string-table metadata`);
  }
  const minimumBytes = checkedAdd(
    STRING_TABLE_HEADER_SIZE,
    checkedMultiply(
      entry.recordCount,
      entry.recordSize,
      `section ${entry.kind} record bytes`,
    ),
    `section ${entry.kind} minimum bytes`,
  );
  if (entry.byteLength < minimumBytes) {
    throw new Error(`section ${entry.kind} is shorter than its records`);
  }
}

export class TextEntityTable {
  constructor(
    buffer,
    stringOffset,
    recordCount,
    styles,
    columnHeights,
    annotationContextsByHandle,
  ) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.stringOffset = stringOffset;
    this.recordCount = recordCount;
    this.styles = styles;
    this.columnHeights = columnHeights;
    this.annotationContextsByHandle = annotationContextsByHandle;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
  }

  get length() {
    return this.recordCount;
  }

  #recordOffset(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.recordCount) {
      throw new RangeError(`text entity index is out of range: ${index}`);
    }
    return STRING_TABLE_HEADER_SIZE + index * TEXT_ENTITY_RECORD_SIZE;
  }

  readValue(index) {
    return this.#readString(this.#recordOffset(index) + 40);
  }

  readDisplayRecord(index, target) {
    if (!target || typeof target !== "object") {
      throw new TypeError("text display record target must be an object");
    }
    const offset = this.#recordOffset(index);
    const styleIndex = this.view.getUint32(offset + 36, true);
    target.index = index;
    target.handle = this.view.getBigUint64(offset, true);
    target.ownerHandle = this.view.getBigUint64(offset + 8, true);
    target.layerIndex = this.view.getUint32(offset + 16, true);
    target.color = this.view.getUint32(offset + 20, true);
    target.lineWeight = this.view.getInt16(offset + 24, true);
    target.commonFlags = this.view.getUint16(offset + 26, true);
    target.linetypeCode = this.view.getUint32(offset + 28, true);
    target.kind = this.view.getUint16(offset + 32, true);
    target.flags = this.view.getUint16(offset + 34, true);
    target.styleIndex = styleIndex === 0xffffffff ? null : styleIndex;
    target.style =
      styleIndex === 0xffffffff ? null : this.styles[styleIndex];
    target.valueByteLength = this.view.getUint32(offset + 44, true);
    target.insertionPoint ??= [0, 0, 0];
    target.alignmentPoint ??= [0, 0, 0];
    target.normal ??= [0, 0, 1];
    target.xAxisDirection ??= [1, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      target.insertionPoint[axis] = this.view.getFloat64(
        offset + 72 + axis * 8,
        true,
      );
      target.alignmentPoint[axis] = this.view.getFloat64(
        offset + 96 + axis * 8,
        true,
      );
      target.normal[axis] = this.view.getFloat64(
        offset + 120 + axis * 8,
        true,
      );
      target.xAxisDirection[axis] = this.view.getFloat64(
        offset + 144 + axis * 8,
        true,
      );
    }
    target.height = this.view.getFloat64(offset + 168, true);
    target.widthFactor = this.view.getFloat64(offset + 176, true);
    target.rotation = this.view.getFloat64(offset + 184, true);
    target.obliqueAngle = this.view.getFloat64(offset + 192, true);
    target.rectangleWidth = this.view.getFloat64(offset + 208, true);
    target.rectangleHeight = this.view.getFloat64(offset + 216, true);
    target.extentsWidth = this.view.getFloat64(offset + 224, true);
    target.extentsHeight = this.view.getFloat64(offset + 232, true);
    target.lineSpacingFactor = this.view.getFloat64(offset + 240, true);
    target.backgroundScale = this.view.getFloat64(offset + 248, true);
    target.backgroundColor = this.view.getUint32(offset + 256, true);
    target.backgroundTransparency = this.view.getInt32(offset + 260, true);
    target.backgroundFlags = this.view.getInt32(offset + 264, true);
    target.sourceFlags = this.view.getInt32(offset + 268, true);
    target.horizontalAlignment = this.view.getInt16(offset + 272, true);
    target.verticalAlignment = this.view.getInt16(offset + 274, true);
    target.attachment = this.view.getInt16(offset + 276, true);
    target.flowDirection = this.view.getInt16(offset + 278, true);
    target.lineSpacingStyle = this.view.getInt16(offset + 280, true);
    target.generationFlags = this.view.getInt16(offset + 282, true);
    target.mtextType = this.view.getInt16(offset + 286, true);
    target.columnType = this.view.getInt32(offset + 292, true);
    target.columnCount = this.view.getInt32(offset + 296, true);
    target.columnFlags = this.view.getUint32(offset + 300, true);
    target.columnWidth = this.view.getFloat64(offset + 304, true);
    target.columnGutter = this.view.getFloat64(offset + 312, true);
    target.firstColumnHeight = readSafeU64(
      this.view,
      offset + 320,
      "text display column-height offset",
    );
    target.columnHeightCount = readSafeU64(
      this.view,
      offset + 328,
      "text display column-height count",
    );
    target.columnHeightPool = this.columnHeights;
    target.columnHeights = null;
    target.annotationContexts =
      this.annotationContextsByHandle.get(target.handle) ?? EMPTY_ARRAY;
    return target;
  }

  get(index) {
    const offset = this.#recordOffset(index);
    const styleIndex = this.view.getUint32(offset + 36, true);
    const firstColumnHeight = readSafeU64(
      this.view,
      offset + 320,
      "text column-height offset",
    );
    const columnHeightCount = readSafeU64(
      this.view,
      offset + 328,
      "text column-height count",
    );
    return Object.freeze({
      index,
      handle: this.view.getBigUint64(offset, true),
      ownerHandle: this.view.getBigUint64(offset + 8, true),
      layerIndex: this.view.getUint32(offset + 16, true),
      color: this.view.getUint32(offset + 20, true),
      lineWeight: this.view.getInt16(offset + 24, true),
      commonFlags: this.view.getUint16(offset + 26, true),
      linetypeCode: this.view.getUint32(offset + 28, true),
      kind: this.view.getUint16(offset + 32, true),
      flags: this.view.getUint16(offset + 34, true),
      styleIndex: styleIndex === 0xffffffff ? null : styleIndex,
      style: styleIndex === 0xffffffff ? null : this.styles[styleIndex],
      value: this.#readString(offset + 40),
      tag: this.#readString(offset + 48),
      prompt: this.#readString(offset + 56),
      linkedHandle: this.view.getBigUint64(offset + 64, true),
      insertionPoint: readVec3F64(this.view, offset + 72),
      alignmentPoint: readVec3F64(this.view, offset + 96),
      normal: readVec3F64(this.view, offset + 120),
      xAxisDirection: readVec3F64(this.view, offset + 144),
      height: this.view.getFloat64(offset + 168, true),
      widthFactor: this.view.getFloat64(offset + 176, true),
      rotation: this.view.getFloat64(offset + 184, true),
      obliqueAngle: this.view.getFloat64(offset + 192, true),
      thickness: this.view.getFloat64(offset + 200, true),
      rectangleWidth: this.view.getFloat64(offset + 208, true),
      rectangleHeight: this.view.getFloat64(offset + 216, true),
      extentsWidth: this.view.getFloat64(offset + 224, true),
      extentsHeight: this.view.getFloat64(offset + 232, true),
      lineSpacingFactor: this.view.getFloat64(offset + 240, true),
      backgroundScale: this.view.getFloat64(offset + 248, true),
      backgroundColor: this.view.getUint32(offset + 256, true),
      backgroundTransparency: this.view.getInt32(offset + 260, true),
      backgroundFlags: this.view.getInt32(offset + 264, true),
      sourceFlags: this.view.getInt32(offset + 268, true),
      horizontalAlignment: this.view.getInt16(offset + 272, true),
      verticalAlignment: this.view.getInt16(offset + 274, true),
      attachment: this.view.getInt16(offset + 276, true),
      flowDirection: this.view.getInt16(offset + 278, true),
      lineSpacingStyle: this.view.getInt16(offset + 280, true),
      generationFlags: this.view.getInt16(offset + 282, true),
      fieldLength: this.view.getInt16(offset + 284, true),
      mtextType: this.view.getInt16(offset + 286, true),
      lineCount: this.view.getInt32(offset + 288, true),
      columnType: this.view.getInt32(offset + 292, true),
      columnCount: this.view.getInt32(offset + 296, true),
      columnFlags: this.view.getUint32(offset + 300, true),
      columnWidth: this.view.getFloat64(offset + 304, true),
      columnGutter: this.view.getFloat64(offset + 312, true),
      columnHeights: this.columnHeights.subarray(
        firstColumnHeight,
        firstColumnHeight + columnHeightCount,
      ),
      annotationContexts:
        this.annotationContextsByHandle.get(
          this.view.getBigUint64(offset, true),
        ) ?? EMPTY_ARRAY,
    });
  }

  #readString(referenceOffset) {
    const relativeOffset = this.view.getUint32(referenceOffset, true);
    const byteLength = this.view.getUint32(referenceOffset + 4, true);
    return this.decoder.decode(
      new Uint8Array(
        this.buffer,
        this.stringOffset + relativeOffset,
        byteLength,
      ),
    );
  }
}

export class HatchSourceTable {
  constructor({
    entityBuffer,
    stringOffset,
    entityCount,
    loopBuffer,
    loopCount,
    vertexBuffer,
    vertexCount,
    gradientColorBuffer,
    gradientColorCount,
    seedPointBuffer,
    seedPointCount,
    patternLineBuffer = new ArrayBuffer(0),
    patternLineCount = 0,
    patternDashBuffer = new ArrayBuffer(0),
    patternDashCount = 0,
    patternLineStarts = new Uint32Array(entityCount),
    patternLineCounts = new Uint32Array(entityCount),
  }) {
    this.entityBuffer = entityBuffer;
    this.entityView = new DataView(entityBuffer);
    this.stringOffset = stringOffset;
    this.entityCount = entityCount;
    this.loopBuffer = loopBuffer;
    this.loopView = new DataView(loopBuffer);
    this.loopCount = loopCount;
    this.vertexBuffer = vertexBuffer;
    this.vertexView = new DataView(vertexBuffer);
    this.vertexCount = vertexCount;
    this.gradientColorBuffer = gradientColorBuffer;
    this.gradientColorView = new DataView(gradientColorBuffer);
    this.gradientColorCount = gradientColorCount;
    this.seedPointBuffer = seedPointBuffer;
    this.seedPointView = new DataView(seedPointBuffer);
    this.seedPointCount = seedPointCount;
    this.patternLineBuffer = patternLineBuffer;
    this.patternLineView = new DataView(patternLineBuffer);
    this.patternLineCount = patternLineCount;
    this.patternDashBuffer = patternDashBuffer;
    this.patternDashView = new DataView(patternDashBuffer);
    this.patternDashCount = patternDashCount;
    this.patternLineStarts = patternLineStarts;
    this.patternLineCounts = patternLineCounts;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
  }

  get length() {
    return this.entityCount;
  }

  #entityOffset(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.entityCount) {
      throw new RangeError(`HATCH entity index is out of range: ${index}`);
    }
    return STRING_TABLE_HEADER_SIZE + index * HATCH_ENTITY_RECORD_SIZE;
  }

  readEntity(index, target) {
    if (!target || typeof target !== "object") {
      throw new TypeError("HATCH entity target must be an object");
    }
    const offset = this.#entityOffset(index);
    target.index = index;
    target.handle = this.entityView.getBigUint64(offset, true);
    target.ownerHandle = this.entityView.getBigUint64(offset + 8, true);
    target.layerIndex = this.entityView.getUint32(offset + 16, true);
    target.color = this.entityView.getUint32(offset + 20, true);
    target.lineWeight = this.entityView.getInt16(offset + 24, true);
    target.commonFlags = this.entityView.getUint16(offset + 26, true);
    target.flags = this.entityView.getUint32(offset + 48, true);
    target.style = this.entityView.getUint16(offset + 52, true);
    target.patternType = this.entityView.getUint16(offset + 54, true);
    target.firstLoop = readSafeU64(
      this.entityView,
      offset + 56,
      "HATCH loop offset",
    );
    target.loopCount = readSafeU64(
      this.entityView,
      offset + 64,
      "HATCH loop count",
    );
    target.firstGradientColor = readSafeU64(
      this.entityView,
      offset + 72,
      "HATCH gradient-color offset",
    );
    target.gradientColorCount = readSafeU64(
      this.entityView,
      offset + 80,
      "HATCH gradient-color count",
    );
    target.elevation = this.entityView.getFloat64(offset + 88, true);
    target.normal ??= [0, 0, 1];
    for (let axis = 0; axis < 3; axis += 1) {
      target.normal[axis] = this.entityView.getFloat64(
        offset + 96 + axis * 8,
        true,
      );
    }
    target.patternAngle = this.entityView.getFloat64(offset + 120, true);
    target.patternScale = this.entityView.getFloat64(offset + 128, true);
    target.pixelSize = this.entityView.getFloat64(offset + 136, true);
    target.gradientAngle = this.entityView.getFloat64(offset + 144, true);
    target.gradientShift = this.entityView.getFloat64(offset + 152, true);
    target.gradientTint = this.entityView.getFloat64(offset + 160, true);
    target.firstSeedPoint = readSafeU64(
      this.entityView,
      offset + 168,
      "HATCH seed-point offset",
    );
    target.seedPointCount = readSafeU64(
      this.entityView,
      offset + 176,
      "HATCH seed-point count",
    );
    target.backgroundColor = this.entityView.getUint32(offset + 184, true);
    target.definitionLineCount = this.entityView.getUint32(
      offset + 188,
      true,
    );
    target.firstPatternLine = this.patternLineStarts[index];
    target.patternLineCount = this.patternLineCounts[index];
    return target;
  }

  readPatternName(index) {
    return this.#readString(this.#entityOffset(index) + 32);
  }

  readGradientName(index) {
    return this.#readString(this.#entityOffset(index) + 40);
  }

  readLoop(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.loopCount) {
      throw new RangeError(`HATCH loop index is out of range: ${index}`);
    }
    if (!target || typeof target !== "object") {
      throw new TypeError("HATCH loop target must be an object");
    }
    const offset = index * HATCH_LOOP_RECORD_SIZE;
    target.index = index;
    target.hatchIndex = readSafeU64(
      this.loopView,
      offset,
      "HATCH loop source index",
    );
    target.pathFlags = this.loopView.getUint32(offset + 8, true);
    target.sourcePathIndex = this.loopView.getUint32(offset + 12, true);
    target.firstVertex = readSafeU64(
      this.loopView,
      offset + 16,
      "HATCH vertex offset",
    );
    target.vertexCount = readSafeU64(
      this.loopView,
      offset + 24,
      "HATCH vertex count",
    );
    target.sourceEdgeCount = this.loopView.getUint32(offset + 32, true);
    target.flags = this.loopView.getUint32(offset + 36, true);
    target.signedArea = this.loopView.getFloat64(offset + 40, true);
    return target;
  }

  readVertex(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.vertexCount) {
      throw new RangeError(`HATCH vertex index is out of range: ${index}`);
    }
    if (!target || target.length < 3) {
      throw new TypeError("HATCH vertex target must contain three values");
    }
    const offset = index * HATCH_VERTEX_RECORD_SIZE;
    for (let axis = 0; axis < 3; axis += 1) {
      target[axis] = this.vertexView.getFloat64(offset + axis * 8, true);
    }
    return target;
  }

  readGradientColor(index, target) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.gradientColorCount
    ) {
      throw new RangeError(`HATCH gradient-color index is out of range: ${index}`);
    }
    if (!target || typeof target !== "object") {
      throw new TypeError("HATCH gradient-color target must be an object");
    }
    const offset = index * HATCH_GRADIENT_COLOR_RECORD_SIZE;
    target.value = this.gradientColorView.getFloat64(offset, true);
    target.color = this.gradientColorView.getUint32(offset + 8, true);
    return target;
  }

  readSeedPoint(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.seedPointCount) {
      throw new RangeError(`HATCH seed-point index is out of range: ${index}`);
    }
    if (!target || target.length < 2) {
      throw new TypeError("HATCH seed-point target must contain two values");
    }
    const offset = index * HATCH_SEED_POINT_RECORD_SIZE;
    target[0] = this.seedPointView.getFloat64(offset, true);
    target[1] = this.seedPointView.getFloat64(offset + 8, true);
    return target;
  }

  readPatternLine(index, target) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.patternLineCount
    ) {
      throw new RangeError(`HATCH pattern-line index is out of range: ${index}`);
    }
    if (!target || typeof target !== "object") {
      throw new TypeError("HATCH pattern-line target must be an object");
    }
    const offset = index * HATCH_PATTERN_LINE_RECORD_SIZE;
    target.index = index;
    target.hatchIndex = readSafeU64(
      this.patternLineView,
      offset,
      "HATCH pattern-line source index",
    );
    target.sourceLineIndex = this.patternLineView.getUint32(offset + 8, true);
    target.angle = this.patternLineView.getFloat64(offset + 16, true);
    target.basePoint ??= [0, 0];
    target.basePoint[0] = this.patternLineView.getFloat64(offset + 24, true);
    target.basePoint[1] = this.patternLineView.getFloat64(offset + 32, true);
    target.offset ??= [0, 0];
    target.offset[0] = this.patternLineView.getFloat64(offset + 40, true);
    target.offset[1] = this.patternLineView.getFloat64(offset + 48, true);
    target.firstDash = readSafeU64(
      this.patternLineView,
      offset + 56,
      "HATCH pattern-dash offset",
    );
    target.dashCount = this.patternLineView.getUint32(offset + 64, true);
    return target;
  }

  readPatternDash(index) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.patternDashCount
    ) {
      throw new RangeError(`HATCH pattern-dash index is out of range: ${index}`);
    }
    return this.patternDashView.getFloat64(
      index * HATCH_PATTERN_DASH_RECORD_SIZE,
      true,
    );
  }

  get(index) {
    const record = this.readEntity(index, { normal: [0, 0, 1] });
    return Object.freeze({
      ...record,
      normal: Object.freeze([...record.normal]),
      patternName: this.readPatternName(index),
      gradientName: this.readGradientName(index),
    });
  }

  #readString(referenceOffset) {
    const relativeOffset = this.entityView.getUint32(referenceOffset, true);
    const byteLength = this.entityView.getUint32(referenceOffset + 4, true);
    return this.decoder.decode(
      new Uint8Array(
        this.entityBuffer,
        this.stringOffset + relativeOffset,
        byteLength,
      ),
    );
  }
}

function readPrimitiveCommon(view, offset, target) {
  target.handle = view.getBigUint64(offset, true);
  target.ownerHandle = view.getBigUint64(offset + 8, true);
  target.layerIndex = view.getUint32(offset + 16, true);
  target.color = view.getUint32(offset + 20, true);
  target.lineWeight = view.getInt16(offset + 24, true);
  target.commonFlags = view.getUint16(offset + 26, true);
  target.linetypeCode = view.getUint32(offset + 28, true);
  return target;
}

class ChunkedFixedRecordTable {
  constructor(chunks, recordSize, recordCount, recordsPerChunk, label) {
    this.chunks = chunks;
    this.recordSize = recordSize;
    this.recordCount = recordCount;
    this.recordsPerChunk = recordsPerChunk;
    this.label = label;
  }

  get length() {
    return this.recordCount;
  }

  locate(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.recordCount) {
      throw new RangeError(`${this.label} record index is out of range: ${index}`);
    }
    const chunkIndex = Math.floor(index / this.recordsPerChunk);
    const chunk = this.chunks[chunkIndex];
    if (!chunk) {
      throw new Error(`${this.label} record ${index} has no source chunk`);
    }
    return {
      view: chunk.view,
      offset: (index - chunk.firstRecord) * this.recordSize,
    };
  }

  readHandle(index) {
    const { view, offset } = this.locate(index);
    return view.getBigUint64(offset, true);
  }
}

class ConstructionLineSourceTable extends ChunkedFixedRecordTable {
  readEntity(index, target) {
    if (!target || typeof target !== "object") {
      throw new TypeError("construction-line target must be an object");
    }
    const { view, offset } = this.locate(index);
    target.index = index;
    readPrimitiveCommon(view, offset, target);
    target.point ??= [0, 0, 0];
    target.direction ??= [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      target.point[axis] = view.getFloat64(offset + 32 + axis * 8, true);
      target.direction[axis] = view.getFloat64(
        offset + 56 + axis * 8,
        true,
      );
    }
    target.kind = (target.commonFlags & (1 << 1)) !== 0 ? "ray" : "xline";
    if (
      target.handle === 0n ||
      (target.commonFlags & ~0x3) !== 0 ||
      target.layerIndex === 0xffffffff ||
      target.linetypeCode > 2047 ||
      !target.point.every(Number.isFinite) ||
      !target.direction.every(Number.isFinite) ||
      Math.hypot(target.direction[0], target.direction[1]) <= 1e-12
    ) {
      throw new Error(`construction line ${index} is invalid`);
    }
    return target;
  }
}

class CircularCurveSourceTable extends ChunkedFixedRecordTable {
  constructor(chunks, recordSize, recordCount, recordsPerChunk, kind) {
    super(chunks, recordSize, recordCount, recordsPerChunk, kind.toUpperCase());
    this.kind = kind;
  }

  readEntity(index, target) {
    if (!target || typeof target !== "object") {
      throw new TypeError(`${this.label} target must be an object`);
    }
    const { view, offset } = this.locate(index);
    target.index = index;
    target.kind = this.kind;
    readPrimitiveCommon(view, offset, target);
    target.center ??= [0, 0, 0];
    target.normal ??= [0, 0, 1];
    for (let axis = 0; axis < 3; axis += 1) {
      target.center[axis] = view.getFloat64(offset + 32 + axis * 8, true);
    }
    target.radius = view.getFloat64(offset + 56, true);
    if (this.kind === "arc") {
      target.startParameter = view.getFloat64(offset + 64, true);
      target.endParameter = view.getFloat64(offset + 72, true);
      target.thickness = view.getFloat64(offset + 80, true);
      for (let axis = 0; axis < 3; axis += 1) {
        target.normal[axis] = view.getFloat64(
          offset + 88 + axis * 8,
          true,
        );
      }
    } else {
      target.startParameter = 0;
      target.endParameter = Math.PI * 2;
      target.thickness = view.getFloat64(offset + 64, true);
      for (let axis = 0; axis < 3; axis += 1) {
        target.normal[axis] = view.getFloat64(
          offset + 72 + axis * 8,
          true,
        );
      }
    }
    return target;
  }
}

class EllipseCurveSourceTable extends ChunkedFixedRecordTable {
  readEntity(index, target) {
    if (!target || typeof target !== "object") {
      throw new TypeError("ELLIPSE target must be an object");
    }
    const { view, offset } = this.locate(index);
    target.index = index;
    target.kind = "ellipse";
    readPrimitiveCommon(view, offset, target);
    target.center ??= [0, 0, 0];
    target.majorAxis ??= [0, 0, 0];
    target.normal ??= [0, 0, 1];
    for (let axis = 0; axis < 3; axis += 1) {
      target.center[axis] = view.getFloat64(offset + 32 + axis * 8, true);
      target.majorAxis[axis] = view.getFloat64(
        offset + 56 + axis * 8,
        true,
      );
      target.normal[axis] = view.getFloat64(offset + 80 + axis * 8, true);
    }
    target.minorAxisRatio = view.getFloat64(offset + 104, true);
    target.startParameter = view.getFloat64(offset + 112, true);
    target.endParameter = view.getFloat64(offset + 120, true);
    return target;
  }
}

class PolylineHeaderSourceTable extends ChunkedFixedRecordTable {
  readEntity(index, target) {
    if (!target || typeof target !== "object") {
      throw new TypeError("polyline header target must be an object");
    }
    const { view, offset } = this.locate(index);
    target.index = index;
    target.kind = "polyline";
    readPrimitiveCommon(view, offset, target);
    target.firstVertex = readSafeU64(
      view,
      offset + 32,
      `polyline ${index} first vertex`,
    );
    target.vertexCount = view.getUint32(offset + 40, true);
    target.polylineKind = view.getUint16(offset + 44, true);
    target.polylineFlags = view.getUint16(offset + 46, true);
    target.elevation = view.getFloat64(offset + 48, true);
    target.thickness = view.getFloat64(offset + 56, true);
    target.normal ??= [0, 0, 1];
    for (let axis = 0; axis < 3; axis += 1) {
      target.normal[axis] = view.getFloat64(offset + 64 + axis * 8, true);
    }
    target.defaultStartWidth = view.getFloat64(offset + 88, true);
    target.defaultEndWidth = view.getFloat64(offset + 96, true);
    target.constantWidth = view.getFloat64(offset + 104, true);
    return target;
  }
}

class PolylineVertexSourceTable extends ChunkedFixedRecordTable {
  readVertex(index, target) {
    if (!target || typeof target !== "object") {
      throw new TypeError("polyline vertex target must be an object");
    }
    const { view, offset } = this.locate(index);
    target.index = index;
    target.position ??= [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      target.position[axis] = view.getFloat64(offset + axis * 8, true);
    }
    target.bulge = view.getFloat64(offset + 24, true);
    target.startWidth = view.getFloat64(offset + 32, true);
    target.endWidth = view.getFloat64(offset + 40, true);
    target.curveTangent = view.getFloat64(offset + 48, true);
    target.flags = view.getUint32(offset + 56, true);
    target.id = view.getInt32(offset + 60, true);
    return target;
  }
}

class SplineHeaderSourceTable extends ChunkedFixedRecordTable {
  readEntity(index, target) {
    if (!target || typeof target !== "object") {
      throw new TypeError("SPLINE target must be an object");
    }
    const { view, offset } = this.locate(index);
    target.index = index;
    target.kind = "spline";
    readPrimitiveCommon(view, offset, target);
    target.degree = view.getInt32(offset + 32, true);
    target.splineFlags = view.getUint32(offset + 36, true);
    target.knotParameterization = view.getInt32(offset + 40, true);
    target.reserved = view.getUint32(offset + 44, true);
    target.firstKnot = readSafeU64(
      view,
      offset + 48,
      `SPLINE ${index} first knot`,
    );
    target.knotCount = readSafeU64(
      view,
      offset + 56,
      `SPLINE ${index} knot count`,
    );
    target.firstControlPoint = readSafeU64(
      view,
      offset + 64,
      `SPLINE ${index} first control point`,
    );
    target.controlPointCount = readSafeU64(
      view,
      offset + 72,
      `SPLINE ${index} control-point count`,
    );
    target.firstWeight = readSafeU64(
      view,
      offset + 80,
      `SPLINE ${index} first weight`,
    );
    target.weightCount = readSafeU64(
      view,
      offset + 88,
      `SPLINE ${index} weight count`,
    );
    target.firstFitPoint = readSafeU64(
      view,
      offset + 96,
      `SPLINE ${index} first fit point`,
    );
    target.fitPointCount = readSafeU64(
      view,
      offset + 104,
      `SPLINE ${index} fit-point count`,
    );
    target.normal ??= [0, 0, 1];
    target.beginTangent ??= [0, 0, 0];
    target.endTangent ??= [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      target.normal[axis] = view.getFloat64(offset + 112 + axis * 8, true);
      target.beginTangent[axis] = view.getFloat64(
        offset + 160 + axis * 8,
        true,
      );
      target.endTangent[axis] = view.getFloat64(
        offset + 184 + axis * 8,
        true,
      );
    }
    target.knotTolerance = view.getFloat64(offset + 136, true);
    target.controlTolerance = view.getFloat64(offset + 144, true);
    target.fitTolerance = view.getFloat64(offset + 152, true);
    return target;
  }
}

class SplineScalarSourceTable extends ChunkedFixedRecordTable {
  readValue(index) {
    const { view, offset } = this.locate(index);
    return view.getFloat64(offset, true);
  }
}

class SplinePointSourceTable extends ChunkedFixedRecordTable {
  readPoint(index, target) {
    if (!target || target.length < 3) {
      throw new TypeError("SPLINE point target must contain three values");
    }
    const { view, offset } = this.locate(index);
    for (let axis = 0; axis < 3; axis += 1) {
      target[axis] = view.getFloat64(offset + axis * 8, true);
    }
    return target;
  }
}

function validatePrimitiveCommon(
  view,
  offset,
  layerCount,
  label,
  index,
) {
  const layerIndex = view.getUint32(offset + 16, true);
  const linetypeCode = view.getUint32(offset + 28, true);
  if (layerIndex !== 0xffffffff && layerIndex >= layerCount) {
    throw new Error(`${label} entity ${index} has an invalid layer reference`);
  }
  if (
    view.getUint16(offset + 26, true) & ~1 ||
    linetypeCode > 2047
  ) {
    throw new Error(`${label} entity ${index} has invalid common metadata`);
  }
}

export class PointSourceTable {
  constructor(buffer, recordCount) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.recordCount = recordCount;
  }

  get length() {
    return this.recordCount;
  }

  readEntity(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.recordCount) {
      throw new RangeError(`POINT entity index is out of range: ${index}`);
    }
    if (!target || typeof target !== "object") {
      throw new TypeError("POINT entity target must be an object");
    }
    const offset = index * POINT_ENTITY_RECORD_SIZE;
    target.index = index;
    readPrimitiveCommon(this.view, offset, target);
    target.location ??= [0, 0, 0];
    target.normal ??= [0, 0, 1];
    for (let axis = 0; axis < 3; axis += 1) {
      target.location[axis] = this.view.getFloat64(
        offset + 32 + axis * 8,
        true,
      );
      target.normal[axis] = this.view.getFloat64(
        offset + 56 + axis * 8,
        true,
      );
    }
    target.thickness = this.view.getFloat64(offset + 80, true);
    target.xAxisAngle = this.view.getFloat64(offset + 88, true);
    target.displaySize = this.view.getFloat64(offset + 96, true);
    target.displayMode = this.view.getInt16(offset + 104, true);
    return target;
  }

  get(index) {
    const record = this.readEntity(index, {
      location: [0, 0, 0],
      normal: [0, 0, 1],
    });
    return Object.freeze({
      ...record,
      location: Object.freeze([...record.location]),
      normal: Object.freeze([...record.normal]),
    });
  }
}

export class SolidSourceTable {
  constructor(buffer, recordCount) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.recordCount = recordCount;
  }

  get length() {
    return this.recordCount;
  }

  readEntity(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.recordCount) {
      throw new RangeError(`SOLID entity index is out of range: ${index}`);
    }
    if (!target || typeof target !== "object") {
      throw new TypeError("SOLID entity target must be an object");
    }
    const offset = index * SOLID_ENTITY_RECORD_SIZE;
    target.index = index;
    readPrimitiveCommon(this.view, offset, target);
    target.fillMode = Boolean(this.view.getUint32(offset + 32, true) & 1);
    target.corners ??= [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let corner = 0; corner < 4; corner += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        target.corners[corner][axis] = this.view.getFloat64(
          offset + 40 + corner * 24 + axis * 8,
          true,
        );
      }
    }
    target.normal ??= [0, 0, 1];
    for (let axis = 0; axis < 3; axis += 1) {
      target.normal[axis] = this.view.getFloat64(
        offset + 136 + axis * 8,
        true,
      );
    }
    target.thickness = this.view.getFloat64(offset + 160, true);
    return target;
  }

  get(index) {
    const record = this.readEntity(index, {
      corners: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      normal: [0, 0, 1],
    });
    return Object.freeze({
      ...record,
      corners: Object.freeze(
        record.corners.map((corner) => Object.freeze([...corner])),
      ),
      normal: Object.freeze([...record.normal]),
    });
  }
}

export class FaceSourceTable {
  constructor(buffer, recordCount) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.recordCount = recordCount;
  }

  get length() {
    return this.recordCount;
  }

  readEntity(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.recordCount) {
      throw new RangeError(`3DFACE entity index is out of range: ${index}`);
    }
    if (!target || typeof target !== "object") {
      throw new TypeError("3DFACE entity target must be an object");
    }
    const offset = index * FACE_ENTITY_RECORD_SIZE;
    target.index = index;
    readPrimitiveCommon(this.view, offset, target);
    target.invisibleEdges = this.view.getUint32(offset + 32, true);
    target.corners ??= [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let corner = 0; corner < 4; corner += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        target.corners[corner][axis] = this.view.getFloat64(
          offset + 40 + corner * 24 + axis * 8,
          true,
        );
      }
    }
    return target;
  }

  get(index) {
    const record = this.readEntity(index, {
      corners: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
    });
    return Object.freeze({
      ...record,
      corners: Object.freeze(
        record.corners.map((corner) => Object.freeze([...corner])),
      ),
    });
  }
}

export class WipeoutSourceTable {
  constructor(entityBuffer, recordCount, clipVertexBuffer, clipVertexCount) {
    this.entityBuffer = entityBuffer;
    this.entityView = new DataView(entityBuffer);
    this.recordCount = recordCount;
    this.clipVertexBuffer = clipVertexBuffer;
    this.clipVertexView = new DataView(clipVertexBuffer);
    this.clipVertexCount = clipVertexCount;
  }

  get length() {
    return this.recordCount;
  }

  readEntity(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.recordCount) {
      throw new RangeError(`WIPEOUT entity index is out of range: ${index}`);
    }
    if (!target || typeof target !== "object") {
      throw new TypeError("WIPEOUT entity target must be an object");
    }
    const offset = index * WIPEOUT_ENTITY_RECORD_SIZE;
    target.index = index;
    readPrimitiveCommon(this.entityView, offset, target);
    target.classVersion = this.entityView.getInt32(offset + 32, true);
    target.displayProperties = this.entityView.getUint16(offset + 36, true);
    target.clipType = this.entityView.getUint8(offset + 38);
    target.clippingEnabled = Boolean(this.entityView.getUint8(offset + 39));
    target.brightness = this.entityView.getUint8(offset + 40);
    target.contrast = this.entityView.getUint8(offset + 41);
    target.fade = this.entityView.getUint8(offset + 42);
    target.clipMode = this.entityView.getUint8(offset + 43);
    target.firstClipVertex = readSafeU64(
      this.entityView,
      offset + 48,
      `WIPEOUT entity ${index} first clip vertex`,
    );
    target.clipVertexCount = this.entityView.getUint32(offset + 56, true);
    target.definitionHandle = this.entityView.getBigUint64(offset + 64, true);
    target.definitionReactorHandle = this.entityView.getBigUint64(
      offset + 72,
      true,
    );
    target.insertionPoint ??= [0, 0, 0];
    target.uVector ??= [0, 0, 0];
    target.vVector ??= [0, 0, 0];
    target.size ??= [0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      target.insertionPoint[axis] = this.entityView.getFloat64(
        offset + 80 + axis * 8,
        true,
      );
      target.uVector[axis] = this.entityView.getFloat64(
        offset + 104 + axis * 8,
        true,
      );
      target.vVector[axis] = this.entityView.getFloat64(
        offset + 128 + axis * 8,
        true,
      );
    }
    target.size[0] = this.entityView.getFloat64(offset + 152, true);
    target.size[1] = this.entityView.getFloat64(offset + 160, true);
    return target;
  }

  readClipVertex(index, target) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.clipVertexCount
    ) {
      throw new RangeError(`WIPEOUT clip vertex index is out of range: ${index}`);
    }
    if (!Array.isArray(target) || target.length < 2) {
      throw new TypeError("WIPEOUT clip vertex target must be a two-value array");
    }
    const offset = index * WIPEOUT_CLIP_VERTEX_RECORD_SIZE;
    target[0] = this.clipVertexView.getFloat64(offset, true);
    target[1] = this.clipVertexView.getFloat64(offset + 8, true);
    return target;
  }

  get(index) {
    const record = this.readEntity(index, {
      insertionPoint: [0, 0, 0],
      uVector: [0, 0, 0],
      vVector: [0, 0, 0],
      size: [0, 0],
    });
    const clipBoundaryVertices = new Array(record.clipVertexCount);
    for (let vertex = 0; vertex < record.clipVertexCount; vertex += 1) {
      clipBoundaryVertices[vertex] = Object.freeze(
        this.readClipVertex(record.firstClipVertex + vertex, [0, 0]),
      );
    }
    return Object.freeze({
      ...record,
      insertionPoint: Object.freeze([...record.insertionPoint]),
      uVector: Object.freeze([...record.uVector]),
      vVector: Object.freeze([...record.vVector]),
      size: Object.freeze([...record.size]),
      clipBoundaryVertices: Object.freeze(clipBoundaryVertices),
    });
  }
}

export class ImageSourceTable {
  constructor(
    entityBuffer,
    stringOffset,
    recordCount,
    clipVertexBuffer,
    clipVertexCount,
  ) {
    this.entityBuffer = entityBuffer;
    this.entityView = new DataView(entityBuffer);
    this.stringOffset = stringOffset;
    this.recordCount = recordCount;
    this.clipVertexBuffer = clipVertexBuffer;
    this.clipVertexView = new DataView(clipVertexBuffer);
    this.clipVertexCount = clipVertexCount;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
  }

  get length() {
    return this.recordCount;
  }

  #recordOffset(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.recordCount) {
      throw new RangeError(`IMAGE entity index is out of range: ${index}`);
    }
    return STRING_TABLE_HEADER_SIZE + index * IMAGE_ENTITY_RECORD_SIZE;
  }

  readPath(index) {
    const offset = this.#recordOffset(index);
    const relativeOffset = this.entityView.getUint32(offset + 32, true);
    const byteLength = this.entityView.getUint32(offset + 36, true);
    return this.decoder.decode(
      new Uint8Array(
        this.entityBuffer,
        this.stringOffset + relativeOffset,
        byteLength,
      ),
    );
  }

  readEntity(index, target) {
    if (!target || typeof target !== "object") {
      throw new TypeError("IMAGE entity target must be an object");
    }
    const offset = this.#recordOffset(index);
    target.index = index;
    readPrimitiveCommon(this.entityView, offset, target);
    target.pathByteLength = this.entityView.getUint32(offset + 36, true);
    target.classVersion = this.entityView.getInt32(offset + 40, true);
    target.displayProperties = this.entityView.getUint16(offset + 44, true);
    target.clipType = this.entityView.getUint8(offset + 46);
    target.clippingEnabled = Boolean(this.entityView.getUint8(offset + 47));
    target.brightness = this.entityView.getUint8(offset + 48);
    target.contrast = this.entityView.getUint8(offset + 49);
    target.fade = this.entityView.getUint8(offset + 50);
    target.clipMode = this.entityView.getUint8(offset + 51);
    target.firstClipVertex = readSafeU64(
      this.entityView,
      offset + 56,
      `IMAGE entity ${index} first clip vertex`,
    );
    target.clipVertexCount = this.entityView.getUint32(offset + 64, true);
    target.definitionHandle = this.entityView.getBigUint64(offset + 72, true);
    target.definitionReactorHandle = this.entityView.getBigUint64(
      offset + 80,
      true,
    );
    target.insertionPoint ??= [0, 0, 0];
    target.uVector ??= [0, 0, 0];
    target.vVector ??= [0, 0, 0];
    target.size ??= [0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      target.insertionPoint[axis] = this.entityView.getFloat64(
        offset + 88 + axis * 8,
        true,
      );
      target.uVector[axis] = this.entityView.getFloat64(
        offset + 112 + axis * 8,
        true,
      );
      target.vVector[axis] = this.entityView.getFloat64(
        offset + 136 + axis * 8,
        true,
      );
    }
    target.size[0] = this.entityView.getFloat64(offset + 160, true);
    target.size[1] = this.entityView.getFloat64(offset + 168, true);
    return target;
  }

  readClipVertex(index, target) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.clipVertexCount
    ) {
      throw new RangeError(`IMAGE clip vertex index is out of range: ${index}`);
    }
    if (!Array.isArray(target) || target.length < 2) {
      throw new TypeError("IMAGE clip vertex target must be a two-value array");
    }
    const offset = index * IMAGE_CLIP_VERTEX_RECORD_SIZE;
    target[0] = this.clipVertexView.getFloat64(offset, true);
    target[1] = this.clipVertexView.getFloat64(offset + 8, true);
    return target;
  }

  get(index) {
    const record = this.readEntity(index, {
      insertionPoint: [0, 0, 0],
      uVector: [0, 0, 0],
      vVector: [0, 0, 0],
      size: [0, 0],
    });
    const clipBoundaryVertices = new Array(record.clipVertexCount);
    for (let vertex = 0; vertex < record.clipVertexCount; vertex += 1) {
      clipBoundaryVertices[vertex] = Object.freeze(
        this.readClipVertex(record.firstClipVertex + vertex, [0, 0]),
      );
    }
    return Object.freeze({
      ...record,
      path: this.readPath(index),
      insertionPoint: Object.freeze([...record.insertionPoint]),
      uVector: Object.freeze([...record.uVector]),
      vVector: Object.freeze([...record.vVector]),
      size: Object.freeze([...record.size]),
      clipBoundaryVertices: Object.freeze(clipBoundaryVertices),
    });
  }
}

export class EmbeddedImageSourceTable {
  constructor(source, byteSection, records) {
    this.source = source;
    this.byteSection = byteSection;
    this.records = records;
    this.recordsByImageIndex = new Map(
      records.map((record) => [record.imageIndex, record]),
    );
  }

  get length() {
    return this.records.length;
  }

  get(imageIndex) {
    if (!Number.isSafeInteger(imageIndex) || imageIndex < 0) {
      return undefined;
    }
    return this.recordsByImageIndex.get(imageIndex);
  }

  async readPayload(imageIndex) {
    const record = this.get(imageIndex);
    if (!record) {
      throw new RangeError(
        `embedded IMAGE index is unavailable: ${imageIndex}`,
      );
    }
    return requireArrayBuffer(
      await this.source.read(
        this.byteSection.offset + record.payloadOffset,
        record.payloadLength,
      ),
      record.payloadLength,
      `embedded IMAGE ${imageIndex} payload`,
    );
  }
}

export class DrawOrderSourceTable {
  constructor(tableBuffer, tableCount, entryBuffer, entryCount) {
    this.tableBuffer = tableBuffer;
    this.tableView = new DataView(tableBuffer);
    this.tableCount = tableCount;
    this.entryBuffer = entryBuffer;
    this.entryView = new DataView(entryBuffer);
    this.entryCount = entryCount;
  }

  get length() {
    return this.tableCount;
  }

  readTable(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.tableCount) {
      throw new RangeError(`draw-order table index is out of range: ${index}`);
    }
    if (!target || typeof target !== "object") {
      throw new TypeError("draw-order table target must be an object");
    }
    const offset = index * DRAW_ORDER_TABLE_RECORD_SIZE;
    target.index = index;
    target.handle = this.tableView.getBigUint64(offset, true);
    target.ownerHandle = this.tableView.getBigUint64(offset + 8, true);
    target.firstEntry = readSafeU64(
      this.tableView,
      offset + 16,
      `draw-order table ${index} first entry`,
    );
    target.entryCount = readSafeU64(
      this.tableView,
      offset + 24,
      `draw-order table ${index} entry count`,
    );
    return target;
  }

  readEntry(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.entryCount) {
      throw new RangeError(`draw-order entry index is out of range: ${index}`);
    }
    if (!target || typeof target !== "object") {
      throw new TypeError("draw-order entry target must be an object");
    }
    const offset = index * DRAW_ORDER_ENTRY_RECORD_SIZE;
    target.index = index;
    target.entityHandle = this.entryView.getBigUint64(offset, true);
    target.sortHandle = this.entryView.getBigUint64(offset + 8, true);
    return target;
  }

  get(index) {
    const table = this.readTable(index, {});
    const entries = new Array(table.entryCount);
    for (let entry = 0; entry < table.entryCount; entry += 1) {
      entries[entry] = Object.freeze(
        this.readEntry(table.firstEntry + entry, {}),
      );
    }
    return Object.freeze({
      ...table,
      entries: Object.freeze(entries),
    });
  }
}

export class DisplayOrderIdentitySourceTable {
  constructor(records, { sourceRecordCount, byteLength, limited = false }) {
    this.records = records;
    this.sourceRecordCount = sourceRecordCount;
    this.byteLength = byteLength;
    this.limited = limited;
  }

  get length() {
    return this.records.length;
  }

  readEntity(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.records.length) {
      throw new RangeError(
        `display-order identity index is out of range: ${index}`,
      );
    }
    if (!target || typeof target !== "object") {
      throw new TypeError("display-order identity target must be an object");
    }
    return Object.assign(target, this.records[index], { index });
  }
}

export class SceneCacheReader {
  constructor(source, header, sections) {
    this.source = source;
    this.header = header;
    this.sections = sections;
    this.cache = new Map();
  }

  static async open(source) {
    if (!source || typeof source.read !== "function") {
      throw new TypeError("SceneCacheReader requires a range source");
    }
    const headerBuffer = requireArrayBuffer(
      await source.read(0, HEADER_SIZE),
      HEADER_SIZE,
      "scene-cache header",
    );
    const headerView = new DataView(headerBuffer);
    for (let index = 0; index < CACHE_MAGIC.length; index += 1) {
      if (headerView.getUint8(index) !== CACHE_MAGIC[index]) {
        throw new Error("invalid scene-cache magic");
      }
    }

    const major = headerView.getUint16(8, true);
    const minor = headerView.getUint16(10, true);
    if (
      major !== CACHE_VERSION_MAJOR ||
      minor < MINIMUM_CACHE_VERSION_MINOR ||
      minor > CACHE_VERSION_MINOR
    ) {
      throw new Error(`unsupported scene-cache version ${major}.${minor}`);
    }
    if (headerView.getUint32(12, true) !== HEADER_SIZE) {
      throw new Error("unexpected scene-cache header size");
    }
    const requiredSectionKinds =
      minor >= 23 ? CURRENT_SECTION_KINDS : LEGACY_SECTION_KINDS;
    const sectionCount = headerView.getUint32(16, true);
    if (sectionCount !== requiredSectionKinds.length) {
      throw new Error(`invalid scene-cache section count: ${sectionCount}`);
    }
    if (headerView.getUint32(20, true) !== DIRECTORY_ENTRY_SIZE) {
      throw new Error("unexpected scene-cache directory-entry size");
    }
    const headerFlags = headerView.getUint32(24, true);
    if ((headerFlags & ~CACHE_HEADER_FLAG_PREVIEW) !== 0) {
      throw new Error("scene-cache contains unsupported header flags");
    }

    const directoryOffset = readSafeU64(
      headerView,
      32,
      "scene-cache directory offset",
    );
    const fileSize = readSafeU64(headerView, 40, "scene-cache file size");
    const sourceSize = readSafeU64(headerView, 48, "source DWG size");
    if (source.size !== undefined && source.size !== null && source.size !== fileSize) {
      throw new Error(
        `scene-cache size mismatch: header=${fileSize}, source=${source.size}`,
      );
    }

    const directoryLength = checkedMultiply(
      sectionCount,
      DIRECTORY_ENTRY_SIZE,
      "scene-cache directory length",
    );
    const directoryEnd = checkedAdd(
      directoryOffset,
      directoryLength,
      "scene-cache directory end",
    );
    if (directoryOffset < HEADER_SIZE || directoryEnd > fileSize) {
      throw new Error("scene-cache directory is outside the file");
    }
    const directoryBuffer = requireArrayBuffer(
      await source.read(directoryOffset, directoryLength),
      directoryLength,
      "scene-cache directory",
    );
    const directoryView = new DataView(directoryBuffer);
    const sections = new Map();
    const ranges = [];
    const bodyStart = alignUp(directoryEnd, 8);

    for (let index = 0; index < sectionCount; index += 1) {
      const offset = index * DIRECTORY_ENTRY_SIZE;
      const entry = {
        kind: directoryView.getUint32(offset, true),
        recordSize: directoryView.getUint32(offset + 4, true),
        offset: readSafeU64(directoryView, offset + 8, "section offset"),
        byteLength: readSafeU64(directoryView, offset + 16, "section byte length"),
        recordCount: readSafeU64(directoryView, offset + 24, "section record count"),
        flags: directoryView.getUint32(offset + 32, true),
      };
      if (sections.has(entry.kind)) {
        throw new Error(`duplicate scene-cache section ${entry.kind}`);
      }
      const end = checkedAdd(
        entry.offset,
        entry.byteLength,
        `section ${entry.kind} end`,
      );
      if (entry.offset < bodyStart || entry.offset % 8 !== 0 || end > fileSize) {
        throw new Error(`section ${entry.kind} has an invalid range`);
      }
      const expectedRecordSize =
        entry.kind === SectionKind.Drawing
          ? 160
          : entry.kind === SectionKind.GpuLineVertices
            ? GPU_LINE_VERTEX_RECORD_SIZE
            : FIXED_RECORD_SIZES.get(entry.kind);
      if (expectedRecordSize !== undefined) {
        validateRecordSection(entry, expectedRecordSize);
      }
      sections.set(entry.kind, Object.freeze(entry));
      ranges.push({ start: entry.offset, end, kind: entry.kind });
    }
    for (const kind of requiredSectionKinds) {
      if (!sections.has(kind)) {
        throw new Error(`Scene Cache is missing required section ${kind}`);
      }
    }

    ranges.sort((left, right) => left.start - right.start);
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index - 1].end > ranges[index].start) {
        throw new Error(
          `scene-cache sections ${ranges[index - 1].kind} and ${ranges[index].kind} overlap`,
        );
      }
    }

    {
      const textStyles = sections.get(SectionKind.TextStyles);
      const textEntities = sections.get(SectionKind.TextEntities);
      const columnHeights = sections.get(SectionKind.TextColumnHeights);
      const annotationContexts = sections.get(
        SectionKind.TextAnnotationContexts,
      );
      const annotationColumnHeights = sections.get(
        SectionKind.TextAnnotationColumnHeights,
      );
      if (
        !textStyles ||
        !textEntities ||
        !columnHeights ||
        !annotationContexts ||
        !annotationColumnHeights
      ) {
        throw new Error("Scene Cache is missing required text sections");
      }
      validateStringTableDirectoryEntry(textStyles, TEXT_STYLE_RECORD_SIZE);
      validateStringTableDirectoryEntry(textEntities, TEXT_ENTITY_RECORD_SIZE);
      validateRecordSection(columnHeights, TEXT_COLUMN_HEIGHT_RECORD_SIZE);
      validateRecordSection(
        annotationContexts,
        TEXT_ANNOTATION_CONTEXT_RECORD_SIZE,
      );
      validateRecordSection(
        annotationColumnHeights,
        TEXT_ANNOTATION_COLUMN_HEIGHT_RECORD_SIZE,
      );
      if (
        annotationContexts.recordCount > MAX_TEXT_ANNOTATION_CONTEXTS ||
        annotationColumnHeights.recordCount >
          MAX_TEXT_ANNOTATION_COLUMN_HEIGHTS
      ) {
        throw new Error(
          "Scene Cache text annotation metadata exceeds its limits",
        );
      }
    }
    {
      const hatchEntities = sections.get(SectionKind.HatchEntities);
      const hatchLoops = sections.get(SectionKind.HatchLoops);
      const hatchVertices = sections.get(SectionKind.HatchVertices);
      const hatchGradientColors = sections.get(
        SectionKind.HatchGradientColors,
      );
      const hatchSeedPoints = sections.get(SectionKind.HatchSeedPoints);
      if (
        !hatchEntities ||
        !hatchLoops ||
        !hatchVertices ||
        !hatchGradientColors ||
        !hatchSeedPoints
      ) {
        throw new Error("Scene Cache is missing required HATCH sections");
      }
      validateStringTableDirectoryEntry(
        hatchEntities,
        HATCH_ENTITY_RECORD_SIZE,
      );
      validateRecordSection(hatchLoops, HATCH_LOOP_RECORD_SIZE);
      validateRecordSection(hatchVertices, HATCH_VERTEX_RECORD_SIZE);
      validateRecordSection(
        hatchGradientColors,
        HATCH_GRADIENT_COLOR_RECORD_SIZE,
      );
      validateRecordSection(
        hatchSeedPoints,
        HATCH_SEED_POINT_RECORD_SIZE,
      );
    }
    {
      const hatchPatternLines = sections.get(
        SectionKind.HatchPatternLines,
      );
      const hatchPatternDashes = sections.get(
        SectionKind.HatchPatternDashes,
      );
      if (!hatchPatternLines || !hatchPatternDashes) {
        throw new Error(
          "Scene Cache is missing required HATCH pattern sections",
        );
      }
      validateRecordSection(
        hatchPatternLines,
        HATCH_PATTERN_LINE_RECORD_SIZE,
      );
      validateRecordSection(
        hatchPatternDashes,
        HATCH_PATTERN_DASH_RECORD_SIZE,
      );
    }
    {
      const pointEntities = sections.get(SectionKind.PointEntities);
      const solidEntities = sections.get(SectionKind.SolidEntities);
      if (!pointEntities || !solidEntities) {
        throw new Error(
          "Scene Cache is missing required POINT or SOLID sections",
        );
      }
      validateRecordSection(pointEntities, POINT_ENTITY_RECORD_SIZE);
      validateRecordSection(solidEntities, SOLID_ENTITY_RECORD_SIZE);
    }
    {
      const faceEntities = sections.get(SectionKind.FaceEntities);
      if (!faceEntities) {
        throw new Error(
          "Scene Cache is missing the required 3DFACE section",
        );
      }
      validateRecordSection(faceEntities, FACE_ENTITY_RECORD_SIZE);
    }
    {
      const wipeoutEntities = sections.get(SectionKind.WipeoutEntities);
      const wipeoutClipVertices = sections.get(
        SectionKind.WipeoutClipVertices,
      );
      if (!wipeoutEntities || !wipeoutClipVertices) {
        throw new Error(
          "Scene Cache is missing required WIPEOUT sections",
        );
      }
      validateRecordSection(wipeoutEntities, WIPEOUT_ENTITY_RECORD_SIZE);
      validateRecordSection(
        wipeoutClipVertices,
        WIPEOUT_CLIP_VERTEX_RECORD_SIZE,
      );
    }
    {
      const drawOrderTables = sections.get(SectionKind.DrawOrderTables);
      const drawOrderEntries = sections.get(SectionKind.DrawOrderEntries);
      if (!drawOrderTables || !drawOrderEntries) {
        throw new Error(
          "Scene Cache is missing required draw-order sections",
        );
      }
      validateRecordSection(
        drawOrderTables,
        DRAW_ORDER_TABLE_RECORD_SIZE,
      );
      validateRecordSection(
        drawOrderEntries,
        DRAW_ORDER_ENTRY_RECORD_SIZE,
      );
    }
    {
      const insertClips = sections.get(SectionKind.InsertClips);
      const insertClipVertices = sections.get(
        SectionKind.InsertClipVertices,
      );
      if (!insertClips || !insertClipVertices) {
        throw new Error(
          "Scene Cache is missing required INSERT XCLIP sections",
        );
      }
      validateRecordSection(insertClips, INSERT_CLIP_RECORD_SIZE);
      validateRecordSection(
        insertClipVertices,
        INSERT_CLIP_VERTEX_RECORD_SIZE,
      );
    }
    {
      const linetypes = sections.get(SectionKind.Linetypes);
      const linetypeDashes = sections.get(SectionKind.LinetypeDashes);
      if (!linetypes || !linetypeDashes) {
        throw new Error(
          "Scene Cache is missing required linetype sections",
        );
      }
      validateStringTableDirectoryEntry(linetypes, LINETYPE_RECORD_SIZE);
      validateStringTableDirectoryEntry(
        linetypeDashes,
        LINETYPE_DASH_RECORD_SIZE,
      );
      if (
        linetypes.recordCount > MAX_LINETYPES ||
        linetypeDashes.recordCount > MAX_LINETYPE_DASHES
      ) {
        throw new Error("Scene Cache linetype metadata exceeds its limits");
      }
    }
    {
      const layouts = sections.get(SectionKind.Layouts);
      const viewports = sections.get(SectionKind.Viewports);
      const frozenLayers = sections.get(
        SectionKind.ViewportFrozenLayers,
      );
      const clipVertices = sections.get(
        SectionKind.ViewportClipVertices,
      );
      const layerOverrides = sections.get(
        SectionKind.ViewportLayerOverrides,
      );
      if (
        !layouts ||
        !viewports ||
        !frozenLayers ||
        !clipVertices ||
        !layerOverrides
      ) {
        throw new Error(
          "Scene Cache is missing required layout sections",
        );
      }
      validateStringTableDirectoryEntry(layouts, LAYOUT_RECORD_SIZE);
      validateStringTableDirectoryEntry(viewports, VIEWPORT_RECORD_SIZE);
      validateRecordSection(
        frozenLayers,
        VIEWPORT_FROZEN_LAYER_RECORD_SIZE,
      );
      validateRecordSection(
        clipVertices,
        VIEWPORT_CLIP_VERTEX_RECORD_SIZE,
      );
      validateRecordSection(
        layerOverrides,
        VIEWPORT_LAYER_OVERRIDE_RECORD_SIZE,
      );
      if (
        layouts.recordCount > MAX_LAYOUTS ||
        viewports.recordCount > MAX_VIEWPORTS ||
        frozenLayers.recordCount > MAX_VIEWPORT_FROZEN_LAYERS ||
        clipVertices.recordCount > MAX_VIEWPORT_CLIP_VERTICES ||
        layerOverrides.recordCount > MAX_VIEWPORT_LAYER_OVERRIDES
      ) {
        throw new Error("Scene Cache layout metadata exceeds its limits");
      }
    }
    {
      const imageEntities = sections.get(SectionKind.ImageEntities);
      const imageClipVertices = sections.get(
        SectionKind.ImageClipVertices,
      );
      if (!imageEntities || !imageClipVertices) {
        throw new Error(
          "Scene Cache is missing required IMAGE sections",
        );
      }
      validateStringTableDirectoryEntry(
        imageEntities,
        IMAGE_ENTITY_RECORD_SIZE,
      );
      validateRecordSection(
        imageClipVertices,
        IMAGE_CLIP_VERTEX_RECORD_SIZE,
      );
      if (
        imageEntities.recordCount > MAX_IMAGE_SOURCE_RECORDS ||
        imageClipVertices.recordCount > MAX_IMAGE_CLIP_VERTICES
      ) {
        throw new Error("Scene Cache IMAGE metadata exceeds its limits");
      }
    }
    {
      const records = sections.get(SectionKind.EmbeddedImageRecords);
      const bytes = sections.get(SectionKind.EmbeddedImageBytes);
      const imageEntities = sections.get(SectionKind.ImageEntities);
      if (!records || !bytes || !imageEntities) {
        throw new Error(
          "Scene Cache is missing required embedded IMAGE sections",
        );
      }
      validateRecordSection(records, EMBEDDED_IMAGE_RECORD_SIZE);
      validateRecordSection(bytes, EMBEDDED_IMAGE_BYTE_RECORD_SIZE);
      if (
        records.recordCount > imageEntities.recordCount ||
        bytes.recordCount > MAX_EMBEDDED_IMAGE_BYTES
      ) {
        throw new Error("Scene Cache embedded IMAGE data exceeds its limits");
      }
    }

    return new SceneCacheReader(
      source,
      Object.freeze({
        major,
        minor,
        sectionCount,
        directoryOffset,
        fileSize,
        sourceSize,
        preview:
          (headerFlags & CACHE_HEADER_FLAG_PREVIEW) !== 0,
        sourceVersion: headerView.getUint32(56, true),
        maintenanceVersion: headerView.getUint32(60, true),
      }),
      sections,
    );
  }

  getSection(kind) {
    const section = this.sections.get(kind);
    if (!section) {
      throw new Error(`scene-cache section ${kind} is missing`);
    }
    return section;
  }

  async readDrawing() {
    return this.memoize("drawing", async () => {
      const section = this.getSection(SectionKind.Drawing);
      if (section.recordCount !== 1) {
        throw new Error("drawing section must contain one record");
      }
      const buffer = await this.readWholeMetadataSection(section);
      const view = new DataView(buffer);
      const bounds = {
        min: ensureFiniteVector(readVec3F64(view, 32), "drawing minimum bounds"),
        max: ensureFiniteVector(readVec3F64(view, 56), "drawing maximum bounds"),
      };
      const rawDisplaySettings = view.getUint32(12, true);
      const rawWipeoutFrame =
        rawDisplaySettings !== 0xffffffff
          ? rawDisplaySettings & 3
          : rawDisplaySettings;
      if (
        rawDisplaySettings !== 0xffffffff &&
        (rawDisplaySettings & ~0x1f) !== 0
      ) {
        throw new Error("drawing contains invalid display settings");
      }
      const globalLinetypeScale = view.getFloat64(80, true);
      const currentEntityLinetypeScale = view.getFloat64(88, true);
      const linetypeDisplayFlags = view.getUint32(96, true);
      const presentationSettings = view.getUint32(100, true);
      if (
        !Number.isFinite(globalLinetypeScale) ||
        globalLinetypeScale <= 0 ||
        !Number.isFinite(currentEntityLinetypeScale) ||
        currentEntityLinetypeScale <= 0 ||
        (linetypeDisplayFlags & ~1) !== 0
      ) {
        throw new Error("drawing contains invalid linetype settings");
      }
      if (
        (this.header.minor < 22 && presentationSettings !== 0) ||
        (this.header.minor >= 22 &&
          ((presentationSettings &
              ~(
                this.header.minor >= 26
                  ? 0x0fffffff
                  : this.header.minor >= 25
                    ? 0x1ffffff
                  : this.header.minor >= 23
                    ? 0x1fffff
                    : 0x7fff
              )) !==
              0 ||
            (this.header.minor < 23 &&
              (presentationSettings & ~0x7fff) !== 0) ||
            ((presentationSettings >>> 8) & 3) === 2 ||
            ((presentationSettings >>> 10) & 3) === 2 ||
            ((presentationSettings & (1 << 14)) === 0 &&
              (presentationSettings & (3 << 12)) !== 0)))
      ) {
        throw new Error("drawing contains invalid presentation settings");
      }
      const currentPresentationSettings = this.header.minor >= 22;
      const twoBitSetting = (
        shift,
        fallback,
        available = currentPresentationSettings,
      ) => {
        if (!available) {
          return fallback;
        }
        const value = (presentationSettings >>> shift) & 3;
        return value === 3 ? null : value;
      };
      let savedModelView = null;
      const savedViewFlags = view.getUint32(152, true);
      const modelAnnotationScale =
        this.header.minor >= 22 ? view.getFloat32(156, true) : 0;
      if (
        (savedViewFlags & ~1) !== 0 ||
        (this.header.minor < 22 && view.getUint32(156, true) !== 0) ||
        !Number.isFinite(modelAnnotationScale) ||
        modelAnnotationScale < 0
      ) {
        throw new Error("drawing contains invalid saved model-view flags");
      }
      if ((savedViewFlags & 1) !== 0) {
        const center = ensureFiniteVector(
          readVec3F64(view, 104),
          "saved model-view center",
        );
        const height = view.getFloat64(128, true);
        const width = view.getFloat64(136, true);
        const twist = view.getFloat64(144, true);
        if (
          !Number.isFinite(height) ||
          height <= 0 ||
          !Number.isFinite(width) ||
          width <= 0 ||
          !Number.isFinite(twist)
        ) {
          throw new Error("drawing contains an invalid saved model view");
        }
        savedModelView = Object.freeze({
          center,
          height,
          width,
          twist,
        });
      }
      return Object.freeze({
        version: view.getUint32(0, true),
        maintenanceVersion: view.getUint32(4, true),
        insertionUnits: view.getInt32(8, true),
        wipeoutFrame:
          rawWipeoutFrame <= 2 ? rawWipeoutFrame : null,
        lineWeightDisplay:
          rawDisplaySettings !== 0xffffffff
            ? (rawDisplaySettings & (1 << 2)) !== 0
            : false,
        fillMode:
          rawDisplaySettings !== 0xffffffff
            ? (rawDisplaySettings & (1 << 3)) !== 0
            : true,
        modelSpaceActive:
          rawDisplaySettings !== 0xffffffff
            ? (rawDisplaySettings & (1 << 4)) !== 0
            : true,
        globalLinetypeScale,
        currentEntityLinetypeScale,
        paperSpaceLinetypeScale: (linetypeDisplayFlags & 1) !== 0,
        attributeDisplayMode: twoBitSetting(0, 1),
        imageFrame: twoBitSetting(2, null),
        xclipFrame: twoBitSetting(4, null),
        oleFrame: twoBitSetting(6, null),
        annotationAllVisible:
          twoBitSetting(8, 1) !== 0,
        modelSpaceLinetypeScale:
          twoBitSetting(10, 0) === 1,
        frame:
          currentPresentationSettings &&
          (presentationSettings & (1 << 14)) !== 0
            ? (presentationSettings >>> 12) & 3
            : null,
        pdfFrame: twoBitSetting(15, null, this.header.minor >= 23),
        dwfFrame: twoBitSetting(17, null, this.header.minor >= 23),
        dgnFrame: twoBitSetting(19, null, this.header.minor >= 23),
        quickTextMode:
          this.header.minor >= 25 &&
          (presentationSettings & (1 << 21)) !== 0,
        splineFrame:
          this.header.minor >= 25 &&
          (presentationSettings & (1 << 22)) !== 0,
        displaySilhouettes:
          this.header.minor >= 25 &&
          (presentationSettings & (1 << 23)) !== 0,
        externalReferenceOverrides:
          this.header.minor >= 25 &&
          (presentationSettings & (1 << 24)) !== 0,
        retainExternalReferenceLayers:
          this.header.minor >= 26
            ? (presentationSettings & (1 << 25)) !== 0
            : true,
        rasterImageQualityHigh:
          this.header.minor >= 26
            ? (presentationSettings & (1 << 26)) !== 0
            : true,
        displaySilhouettesInBlocks:
          this.header.minor >= 26
            ? (presentationSettings & (1 << 27)) !== 0
            : true,
        modelAnnotationScale,
        savedModelView,
        totalEntities: readSafeU64(view, 16, "drawing entity count"),
        serializedEntities: readSafeU64(view, 24, "serialized entity count"),
        bounds,
      });
    });
  }

  async readLayers() {
    return this.memoize("layers", async () => {
      const section = this.getSection(SectionKind.Layers);
      return this.readStringTable(section, 40, (view, offset, readString) =>
        Object.freeze({
          handle: view.getBigUint64(offset, true),
          name: readString(
            view.getUint32(offset + 8, true),
            view.getUint32(offset + 12, true),
          ),
          linetype: readString(
            view.getUint32(offset + 16, true),
            view.getUint32(offset + 20, true),
          ),
          color: view.getUint32(offset + 24, true),
          flags: view.getUint32(offset + 28, true),
          lineWeight: view.getInt32(offset + 32, true),
        }),
      );
    });
  }

  async readLinetypes() {
    return this.memoize("linetypes", async () => {
      const definitionsSection = this.getSection(SectionKind.Linetypes);
      const dashesSection = this.getSection(SectionKind.LinetypeDashes);
      const [definitions, dashes] = await Promise.all([
        this.readStringTable(
          definitionsSection,
          LINETYPE_RECORD_SIZE,
          (view, offset, readString) =>
            Object.freeze({
              handle: view.getBigUint64(offset, true),
              code: view.getUint32(offset + 8, true),
              alignment: view.getUint16(offset + 12, true),
              flags: view.getUint16(offset + 14, true),
              patternLength: view.getFloat64(offset + 16, true),
              firstDash: readSafeU64(
                view,
                offset + 24,
                "linetype first dash",
              ),
              dashCount: view.getUint32(offset + 32, true),
              name: readString(
                view.getUint32(offset + 36, true),
                view.getUint32(offset + 40, true),
              ),
              description: readString(
                view.getUint32(offset + 44, true),
                view.getUint32(offset + 48, true),
              ),
              reserved: [
                view.getUint32(offset + 52, true),
                view.getUint32(offset + 56, true),
                view.getUint32(offset + 60, true),
              ],
            }),
        ),
        this.readStringTable(
          dashesSection,
          LINETYPE_DASH_RECORD_SIZE,
          (view, offset, readString) => {
            const encodedStyleIndex = view.getUint32(offset + 20, true);
            return Object.freeze({
              linetypeCode: view.getUint32(offset, true),
              flags: view.getUint32(offset + 4, true),
              length: view.getFloat64(offset + 8, true),
              shapeCode: view.getInt32(offset + 16, true),
              textStyleIndex:
                encodedStyleIndex === 0xffffffff
                  ? null
                  : encodedStyleIndex,
              xOffset: view.getFloat64(offset + 24, true),
              yOffset: view.getFloat64(offset + 32, true),
              scale: view.getFloat64(offset + 40, true),
              rotation: view.getFloat64(offset + 48, true),
              text: readString(
                view.getUint32(offset + 56, true),
                view.getUint32(offset + 60, true),
              ),
              reserved: view.getBigUint64(offset + 64, true),
            });
          },
        ),
      ]);
      const textStyleCount =
        this.getSection(SectionKind.TextStyles)?.recordCount ?? 0;
      const codes = new Set();
      let expectedFirstDash = 0;
      const output = definitions.map((definition, index) => {
        const endDash = checkedAdd(
          definition.firstDash,
          definition.dashCount,
          `linetype ${index} dash range`,
        );
        if (
          definition.code > 2047 ||
          codes.has(definition.code) ||
          definition.flags & ~1 ||
          definition.reserved.some(Boolean) ||
          !Number.isFinite(definition.patternLength) ||
          definition.patternLength < 0 ||
          definition.firstDash !== expectedFirstDash ||
          endDash > dashes.length
        ) {
          throw new Error(`linetype ${index} contains invalid metadata`);
        }
        codes.add(definition.code);
        expectedFirstDash = endDash;
        const definitionDashes = dashes.slice(
          definition.firstDash,
          endDash,
        );
        for (const dash of definitionDashes) {
          if (
            dash.linetypeCode !== definition.code ||
            dash.flags & ~15 ||
            dash.reserved !== 0n ||
            (dash.textStyleIndex !== null &&
              dash.textStyleIndex >= textStyleCount) ||
            ![
              dash.length,
              dash.xOffset,
              dash.yOffset,
              dash.scale,
              dash.rotation,
            ].every(Number.isFinite)
          ) {
            throw new Error(
              `linetype ${index} contains an invalid dash definition`,
            );
          }
        }
        return Object.freeze({
          ...definition,
          dashes: Object.freeze(definitionDashes),
        });
      });
      if (expectedFirstDash !== dashes.length) {
        throw new Error("linetype dash pool is not fully covered");
      }
      return Object.freeze(output);
    });
  }

  async readBlocks() {
    return this.memoize("blocks", async () => {
      const section = this.getSection(SectionKind.Blocks);
      return this.readStringTable(section, 64, (view, offset, readString, index) => {
        const rawFlags = view.getUint32(offset + 24, true);
        const xrefPath = readString(
          view.getUint32(offset + 56, true),
          view.getUint32(offset + 60, true),
        );
        // Scene Cache v1.21 could retain xref_pname while omitting blkisxref.
        // Recover that legacy representation without overriding the explicit
        // loaded/resolved XREF state introduced in v1.22.
        const flags =
          this.header.minor < 22 &&
          xrefPath.length > 0 &&
          (rawFlags & (1 << 4)) !== 0
            ? rawFlags | (1 << 2)
            : rawFlags;
        const supportedFlags = this.header.minor >= 22 ? 0x1ff : 0x7f;
        if ((flags & ~supportedFlags) !== 0) {
          throw new Error(`block ${index} contains unsupported flags`);
        }
        const isExternalReference = (flags & (1 << 2)) !== 0;
        if (
          !isExternalReference &&
          (flags & ((1 << 7) | (1 << 8))) !== 0
        ) {
          throw new Error(`block ${index} contains invalid XREF state`);
        }
        return Object.freeze({
          index,
          handle: view.getBigUint64(offset, true),
          name: readString(
            view.getUint32(offset + 8, true),
            view.getUint32(offset + 12, true),
          ),
          entityCount: view.getUint32(offset + 16, true),
          referenceCount: view.getUint32(offset + 20, true),
          flags,
          xrefLoaded:
            isExternalReference &&
            (this.header.minor < 22 || (flags & (1 << 7)) !== 0),
          xrefResolved:
            isExternalReference &&
            (this.header.minor < 22 || (flags & (1 << 8)) !== 0),
          units: view.getInt32(offset + 28, true),
          basePoint: ensureFiniteVector(
            readVec3F64(view, offset + 32),
            "block base point",
          ),
          xrefPath,
        });
      });
    });
  }

  async readLayouts() {
    return this.memoize("layouts", async () => {
      const layoutSection = this.getSection(SectionKind.Layouts);
      const viewportSection = this.getSection(SectionKind.Viewports);
      const frozenSection = this.getSection(
        SectionKind.ViewportFrozenLayers,
      );
      const clipSection = this.getSection(
        SectionKind.ViewportClipVertices,
      );
      const layerOverrideSection = this.getSection(
        SectionKind.ViewportLayerOverrides,
      );
      const [
        layoutRows,
        viewportRows,
        frozenBuffer,
        clipBuffer,
        layerOverrideBuffer,
        blocks,
        layers,
      ] =
        await Promise.all([
          this.readStringTable(
            layoutSection,
            LAYOUT_RECORD_SIZE,
            (view, offset, readString, index) =>
              Object.freeze({
                index,
                handle: view.getBigUint64(offset, true),
                blockHandle: view.getBigUint64(offset + 8, true),
                activeViewportHandle: view.getBigUint64(
                  offset + 16,
                  true,
                ),
                firstViewport: readSafeU64(
                  view,
                  offset + 24,
                  `layout ${index} first viewport`,
                ),
                viewportCount: view.getUint32(offset + 32, true),
                tabOrder: view.getUint16(offset + 36, true),
                flags: view.getUint16(offset + 38, true),
                plotFlags: view.getUint32(offset + 40, true),
                paperUnit: view.getUint16(offset + 44, true),
                rotation: view.getUint16(offset + 46, true),
                plotType: view.getUint16(offset + 48, true),
                standardScaleType: view.getUint16(offset + 50, true),
                shadePlotType: view.getUint16(offset + 52, true),
                annotationAllVisible:
                  this.header.minor >= 24
                    ? view.getUint16(offset + 54, true) !== 0
                    : null,
                reserved:
                  this.header.minor >= 24
                    ? view.getUint16(offset + 54, true) & ~1
                    : view.getUint16(offset + 54, true),
                standardScaleFactor: view.getFloat64(offset + 56, true),
                paperUnits: view.getFloat64(offset + 64, true),
                drawingUnits: view.getFloat64(offset + 72, true),
                paperWidth: view.getFloat64(offset + 80, true),
                paperHeight: view.getFloat64(offset + 88, true),
                margins: Object.freeze([
                  view.getFloat64(offset + 96, true),
                  view.getFloat64(offset + 104, true),
                  view.getFloat64(offset + 112, true),
                  view.getFloat64(offset + 120, true),
                ]),
                plotOrigin: Object.freeze([
                  view.getFloat64(offset + 128, true),
                  view.getFloat64(offset + 136, true),
                ]),
                limits: Object.freeze({
                  min: Object.freeze([
                    view.getFloat64(offset + 144, true),
                    view.getFloat64(offset + 152, true),
                  ]),
                  max: Object.freeze([
                    view.getFloat64(offset + 160, true),
                    view.getFloat64(offset + 168, true),
                  ]),
                }),
                extents: Object.freeze({
                  min: Object.freeze(readVec3F64(view, offset + 176)),
                  max: Object.freeze(readVec3F64(view, offset + 200)),
                }),
                name: readString(
                  view.getUint32(offset + 224, true),
                  view.getUint32(offset + 228, true),
                ),
                styleSheet: readString(
                  view.getUint32(offset + 232, true),
                  view.getUint32(offset + 236, true),
                ),
                canonicalMediaName: readString(
                  view.getUint32(offset + 240, true),
                  view.getUint32(offset + 244, true),
                ),
                printerConfig: readString(
                  view.getUint32(offset + 248, true),
                  view.getUint32(offset + 252, true),
                ),
              }),
          ),
          this.readStringTable(
            viewportSection,
            VIEWPORT_RECORD_SIZE,
            (view, offset, readString, index) =>
              Object.freeze({
                index,
                handle: view.getBigUint64(offset, true),
                ownerHandle: view.getBigUint64(offset + 8, true),
                layerIndex: view.getUint32(offset + 16, true),
                color: view.getUint32(offset + 20, true),
                firstFrozenLayer: readSafeU64(
                  view,
                  offset + 24,
                  `viewport ${index} first frozen layer`,
                ),
                frozenLayerCount: view.getUint32(offset + 32, true),
                status: view.getUint32(offset + 36, true),
                on: view.getInt16(offset + 40, true),
                id: view.getInt16(offset + 42, true),
                flags: view.getUint32(offset + 44, true),
                center: Object.freeze(readVec3F64(view, offset + 48)),
                width: view.getFloat64(offset + 72, true),
                height: view.getFloat64(offset + 80, true),
                viewTarget: Object.freeze(readVec3F64(view, offset + 88)),
                viewDirection: Object.freeze(
                  readVec3F64(view, offset + 112),
                ),
                viewTwist: view.getFloat64(offset + 136, true),
                viewHeight: view.getFloat64(offset + 144, true),
                viewCenter: Object.freeze([
                  view.getFloat64(offset + 152, true),
                  view.getFloat64(offset + 160, true),
                ]),
                lensLength: view.getFloat64(offset + 168, true),
                frontClip: view.getFloat64(offset + 176, true),
                backClip: view.getFloat64(offset + 184, true),
                brightness: view.getFloat64(offset + 192, true),
                contrast: view.getFloat64(offset + 200, true),
                ambientColor: view.getUint32(offset + 208, true),
                renderMode: view.getUint16(offset + 212, true),
                shadePlotMode: view.getUint16(offset + 214, true),
                clipBoundaryHandle: view.getBigUint64(
                  offset + 216,
                  true,
                ),
                visualStyleHandle: view.getBigUint64(
                  offset + 224,
                  true,
                ),
                backgroundHandle: view.getBigUint64(
                  offset + 232,
                  true,
                ),
                styleSheet: readString(
                  view.getUint32(offset + 240, true),
                  view.getUint32(offset + 244, true),
                ),
                firstClipVertex: readSafeU64(
                  view,
                  offset + 248,
                  `viewport ${index} first clip vertex`,
                ),
                clipVertexCount: view.getUint32(offset + 256, true),
                clipFlags: view.getUint32(offset + 260, true),
                annotationScale: view.getFloat64(offset + 264, true),
              }),
          ),
          this.readWholeMetadataSection(frozenSection),
          this.readWholeMetadataSection(clipSection),
          this.readWholeMetadataSection(layerOverrideSection),
          this.readBlocks(),
          this.readLayers(),
        ]);
      const blockIndexByHandle = new Map(
        blocks.map((block) => [block.handle, block.index]),
      );
      const frozenView = new DataView(frozenBuffer);
      const frozenLayers = new Array(frozenSection.recordCount);
      for (let index = 0; index < frozenLayers.length; index += 1) {
        const offset =
          index * VIEWPORT_FROZEN_LAYER_RECORD_SIZE;
        const layerIndex = frozenView.getUint32(offset, true);
        if (
          layerIndex >= layers.length ||
          frozenView.getUint32(offset + 4, true) !== 0
        ) {
          throw new Error(
            `viewport frozen layer ${index} contains invalid metadata`,
          );
        }
        frozenLayers[index] = layerIndex;
      }

      const viewportHandles = new Set(
        viewportRows.map((viewport) => viewport.handle),
      );
      const mutableOverridesByViewport = new Map();
      const layerOverrideView = new DataView(layerOverrideBuffer);
      for (
        let index = 0;
        index < layerOverrideSection.recordCount;
        index += 1
      ) {
        const offset = index * VIEWPORT_LAYER_OVERRIDE_RECORD_SIZE;
        const viewportHandle = layerOverrideView.getBigUint64(
          offset,
          true,
        );
        const layerIndex = layerOverrideView.getUint32(offset + 8, true);
        const property = layerOverrideView.getUint16(offset + 12, true);
        const value = layerOverrideView.getUint32(offset + 16, true);
        let flag = 0;
        let field = "";
        let validValue = false;
        if (property === ViewportLayerOverrideProperty.Color) {
          const kind = value >>> 30;
          const aci = value & 255;
          flag = ViewportLayerOverrideFlags.Color;
          field = "color";
          validValue =
            (value & 0x3f000000) === 0 &&
            (kind === 3 ||
              (kind === 2 &&
                aci > 0 &&
                (value & 0x00ffff00) === 0));
        } else if (
          property === ViewportLayerOverrideProperty.Transparency
        ) {
          const opacityCode = (value >>> 24) & 63;
          flag = ViewportLayerOverrideFlags.Transparency;
          field = "transparency";
          validValue =
            ((value & 0xc0ffffff) >>> 0) === 0 &&
            opacityCode >= 3 &&
            opacityCode <= 63;
        } else if (
          property === ViewportLayerOverrideProperty.Linetype
        ) {
          flag = ViewportLayerOverrideFlags.Linetype;
          field = "linetypeCode";
          validValue = value >= 2 && value <= 2047;
        } else if (
          property === ViewportLayerOverrideProperty.LineWeight
        ) {
          flag = ViewportLayerOverrideFlags.LineWeight;
          field = "lineWeight";
          validValue = value <= 211;
        }
        if (
          viewportHandle === 0n ||
          !viewportHandles.has(viewportHandle) ||
          layerIndex >= layers.length ||
          layerOverrideView.getUint16(offset + 14, true) !== 0 ||
          layerOverrideView.getUint32(offset + 20, true) !== 0 ||
          !validValue
        ) {
          throw new Error(
            `viewport layer override ${index} contains invalid metadata`,
          );
        }
        let overridesByLayer = mutableOverridesByViewport.get(
          viewportHandle,
        );
        if (!overridesByLayer) {
          overridesByLayer = new Map();
          mutableOverridesByViewport.set(viewportHandle, overridesByLayer);
        }
        let layerOverride = overridesByLayer.get(layerIndex);
        if (!layerOverride) {
          layerOverride = { layerIndex, flags: 0 };
          overridesByLayer.set(layerIndex, layerOverride);
        }
        if ((layerOverride.flags & flag) !== 0) {
          throw new Error(
            `viewport layer override ${index} duplicates a property`,
          );
        }
        layerOverride.flags |= flag;
        layerOverride[field] = value;
      }
      const layerOverridesByViewport = new Map(
        [...mutableOverridesByViewport].map(
          ([viewportHandle, overridesByLayer]) => [
            viewportHandle,
            Object.freeze(
              [...overridesByLayer.values()]
                .sort((left, right) => left.layerIndex - right.layerIndex)
                .map((override) => Object.freeze(override)),
            ),
          ],
        ),
      );

      const clipView = new DataView(clipBuffer);
      let expectedFirstFrozenLayer = 0;
      let expectedFirstClipVertex = 0;
      const viewports = viewportRows.map((viewport, index) => {
        const frozenEnd = checkedAdd(
          viewport.firstFrozenLayer,
          viewport.frozenLayerCount,
          `viewport ${index} frozen layer range`,
        );
        const clipEnd = checkedAdd(
          viewport.firstClipVertex,
          viewport.clipVertexCount,
          `viewport ${index} clip vertex range`,
        );
        if (
          viewport.ownerHandle === 0n ||
          viewport.layerIndex >= layers.length ||
          viewport.firstFrozenLayer !== expectedFirstFrozenLayer ||
          frozenEnd > frozenLayers.length ||
          viewport.firstClipVertex !== expectedFirstClipVertex ||
          clipEnd > clipSection.recordCount ||
          viewport.clipVertexCount > MAX_VIEWPORT_CLIP_VERTICES_PER_BOUNDARY ||
          (viewport.clipVertexCount > 0 && viewport.clipVertexCount < 3) ||
          (viewport.clipVertexCount > 0 &&
            viewport.clipBoundaryHandle === 0n) ||
          viewport.flags & ~0xf ||
          viewport.clipFlags !== 0 ||
          ![
            ...viewport.center,
            viewport.width,
            viewport.height,
            ...viewport.viewTarget,
            ...viewport.viewDirection,
            viewport.viewTwist,
            viewport.viewHeight,
            ...viewport.viewCenter,
            viewport.lensLength,
            viewport.frontClip,
            viewport.backClip,
            viewport.brightness,
            viewport.contrast,
            viewport.annotationScale,
          ].every(Number.isFinite) ||
          viewport.width < 0 ||
          viewport.height < 0 ||
          viewport.viewHeight < 0 ||
          viewport.annotationScale < 0
        ) {
          throw new Error(
            `viewport ${index} contains invalid metadata`,
          );
        }
        const clipBoundaryVertices = new Array(
          viewport.clipVertexCount,
        );
        for (
          let vertexIndex = viewport.firstClipVertex;
          vertexIndex < clipEnd;
          vertexIndex += 1
        ) {
          const clipOffset =
            vertexIndex * VIEWPORT_CLIP_VERTEX_RECORD_SIZE;
          const point = Object.freeze([
            clipView.getFloat64(clipOffset, true),
            clipView.getFloat64(clipOffset + 8, true),
            0,
          ]);
          if (!point.every(Number.isFinite)) {
            throw new Error(
              `viewport ${index} contains a non-finite clip vertex`,
            );
          }
          clipBoundaryVertices[
            vertexIndex - viewport.firstClipVertex
          ] = point;
        }
        expectedFirstFrozenLayer = frozenEnd;
        expectedFirstClipVertex = clipEnd;
        return Object.freeze({
          ...viewport,
          frozenLayerIndices: Object.freeze(
            frozenLayers.slice(
              viewport.firstFrozenLayer,
              frozenEnd,
            ),
          ),
          clipBoundaryVertices: Object.freeze(
            clipBoundaryVertices,
          ),
          layerOverrides:
            layerOverridesByViewport.get(viewport.handle) ?? EMPTY_ARRAY,
        });
      });
      if (expectedFirstFrozenLayer !== frozenLayers.length) {
        throw new Error("viewport frozen layer pool is not fully covered");
      }
      if (expectedFirstClipVertex !== clipSection.recordCount) {
        throw new Error("viewport clip vertex pool is not fully covered");
      }

      let expectedFirstViewport = 0;
      const layouts = layoutRows.map((layout, index) => {
        const viewportEnd = checkedAdd(
          layout.firstViewport,
          layout.viewportCount,
          `layout ${index} viewport range`,
        );
        const layoutViewports = viewports.slice(
          layout.firstViewport,
          viewportEnd,
        );
        const blockIndex = blockIndexByHandle.get(layout.blockHandle);
        if (
          layout.handle === 0n ||
          blockIndex === undefined ||
          layout.firstViewport !== expectedFirstViewport ||
          viewportEnd > viewports.length ||
          layout.reserved !== 0 ||
          ![
            layout.standardScaleFactor,
            layout.paperUnits,
            layout.drawingUnits,
            layout.paperWidth,
            layout.paperHeight,
            ...layout.margins,
            ...layout.plotOrigin,
            ...layout.limits.min,
            ...layout.limits.max,
            ...layout.extents.min,
            ...layout.extents.max,
          ].every(Number.isFinite) ||
          layout.paperWidth < 0 ||
          layout.paperHeight < 0 ||
          layoutViewports.some(
            (viewport) => viewport.ownerHandle !== layout.blockHandle,
          )
        ) {
          throw new Error(`layout ${index} contains invalid metadata`);
        }
        expectedFirstViewport = viewportEnd;
        return Object.freeze({
          ...layout,
          blockIndex,
          viewports: Object.freeze(layoutViewports),
        });
      });
      if (expectedFirstViewport !== viewports.length) {
        throw new Error("layout viewport pool is not fully covered");
      }
      return Object.freeze(layouts);
    });
  }

  async readTextStyles() {
    return this.memoize("text-styles", async () => {
      const section = this.getSection(SectionKind.TextStyles);
      return this.readStringTable(
        section,
        TEXT_STYLE_RECORD_SIZE,
        (view, offset, readString, index) =>
          Object.freeze({
            index,
            handle: view.getBigUint64(offset, true),
            name: readString(
              view.getUint32(offset + 8, true),
              view.getUint32(offset + 12, true),
            ),
            fontFile: readString(
              view.getUint32(offset + 16, true),
              view.getUint32(offset + 20, true),
            ),
            bigFontFile: readString(
              view.getUint32(offset + 24, true),
              view.getUint32(offset + 28, true),
            ),
            trueTypeFont: readString(
              view.getUint32(offset + 32, true),
              view.getUint32(offset + 36, true),
            ),
            flags: view.getUint32(offset + 40, true),
            height: view.getFloat64(offset + 48, true),
            widthFactor: view.getFloat64(offset + 56, true),
            obliqueAngle: view.getFloat64(offset + 64, true),
            lastHeight: view.getFloat64(offset + 72, true),
          }),
      );
    });
  }

  async readTextColumnHeights() {
    return this.memoize("text-column-heights", async () => {
      const section = this.getSection(SectionKind.TextColumnHeights);
      const buffer = await this.readWholeMetadataSection(section);
      const view = new DataView(buffer);
      const values = new Float64Array(section.recordCount);
      for (let index = 0; index < values.length; index += 1) {
        values[index] = view.getFloat64(
          index * TEXT_COLUMN_HEIGHT_RECORD_SIZE,
          true,
        );
      }
      return values;
    });
  }

  async readTextEntities() {
    return this.memoize("text-entities", async () => {
      const section = this.getSection(SectionKind.TextEntities);
      const annotationContextSection = this.getSection(
        SectionKind.TextAnnotationContexts,
      );
      const annotationColumnHeightSection = this.getSection(
        SectionKind.TextAnnotationColumnHeights,
      );
      validateStringTableDirectoryEntry(section, TEXT_ENTITY_RECORD_SIZE);
      const [
        styles,
        columnHeights,
        buffer,
        annotationContextBuffer,
        annotationColumnHeightBuffer,
      ] = await Promise.all([
        this.readTextStyles(),
        this.readTextColumnHeights(),
        this.readWholeMetadataSection(section),
        this.readWholeMetadataSection(annotationContextSection),
        this.readWholeMetadataSection(annotationColumnHeightSection),
      ]);
      const view = new DataView(buffer);
      const recordCount = view.getUint32(0, true);
      const recordSize = view.getUint32(4, true);
      const stringOffset = readSafeU64(view, 8, "text UTF-8 blob offset");
      const minimumStringOffset = checkedAdd(
        STRING_TABLE_HEADER_SIZE,
        checkedMultiply(
          section.recordCount,
          section.recordSize,
          "text record bytes",
        ),
        "text UTF-8 minimum offset",
      );
      if (
        recordCount !== section.recordCount ||
        recordSize !== section.recordSize ||
        stringOffset < minimumStringOffset ||
        stringOffset > section.byteLength
      ) {
        throw new Error("text-entity string-table header is inconsistent");
      }

      const decoder = new TextDecoder("utf-8", { fatal: true });
      const textKindsByHandle = new Map();
      for (let index = 0; index < section.recordCount; index += 1) {
        const offset = STRING_TABLE_HEADER_SIZE + index * section.recordSize;
        const handle = view.getBigUint64(offset, true);
        const kind = view.getUint16(offset + 32, true);
        const styleIndex = view.getUint32(offset + 36, true);
        if (kind > TextEntityKind.Attribute) {
          throw new Error(`text entity ${index} has an unsupported kind`);
        }
        if (styleIndex !== 0xffffffff && styleIndex >= styles.length) {
          throw new Error(`text entity ${index} has an invalid style reference`);
        }
        if (handle === 0n || textKindsByHandle.has(handle)) {
          throw new Error(`text entity ${index} has an invalid handle`);
        }
        textKindsByHandle.set(handle, kind);
        for (const referenceOffset of [40, 48, 56]) {
          const relativeOffset = view.getUint32(offset + referenceOffset, true);
          const byteLength = view.getUint32(offset + referenceOffset + 4, true);
          if (byteLength > MAX_CACHE_STRING_BYTES) {
            throw new Error(`text entity ${index} contains an oversized string`);
          }
          const start = checkedAdd(
            stringOffset,
            relativeOffset,
            "text UTF-8 offset",
          );
          const end = checkedAdd(start, byteLength, "text UTF-8 end");
          if (start < stringOffset || end > section.byteLength) {
            throw new Error(`text entity ${index} points outside its UTF-8 blob`);
          }
          decoder.decode(new Uint8Array(buffer, start, byteLength));
        }
        const firstColumnHeight = readSafeU64(
          view,
          offset + 320,
          "text column-height offset",
        );
        const columnHeightCount = readSafeU64(
          view,
          offset + 328,
          "text column-height count",
        );
        if (
          checkedAdd(
            firstColumnHeight,
            columnHeightCount,
            "text column-height range",
          ) > columnHeights.length
        ) {
          throw new Error(`text entity ${index} has an invalid column-height range`);
        }
      }

      const annotationHeightView = new DataView(
        annotationColumnHeightBuffer,
      );
      const annotationColumnHeights = new Float64Array(
        annotationColumnHeightSection.recordCount,
      );
      for (
        let index = 0;
        index < annotationColumnHeights.length;
        index += 1
      ) {
        const value = annotationHeightView.getFloat64(
          index * TEXT_ANNOTATION_COLUMN_HEIGHT_RECORD_SIZE,
          true,
        );
        if (!Number.isFinite(value)) {
          throw new Error(
            `text annotation column height ${index} is invalid`,
          );
        }
        annotationColumnHeights[index] = value;
      }

      const annotationContextsByHandle = new Map();
      const annotationView = new DataView(annotationContextBuffer);
      let expectedFirstColumnHeight = 0;
      for (
        let index = 0;
        index < annotationContextSection.recordCount;
        index += 1
      ) {
        const offset = index * TEXT_ANNOTATION_CONTEXT_RECORD_SIZE;
        const handle = annotationView.getBigUint64(offset, true);
        const scale = annotationView.getFloat64(offset + 8, true);
        const flags = annotationView.getUint32(offset + 16, true);
        const attachment = annotationView.getInt32(offset + 20, true);
        const insertionPoint = readVec3F64(annotationView, offset + 24);
        const xAxisDirection = readVec3F64(annotationView, offset + 48);
        const rectangleHeight = annotationView.getFloat64(
          offset + 72,
          true,
        );
        const rectangleWidth = annotationView.getFloat64(
          offset + 80,
          true,
        );
        const extentsWidth = annotationView.getFloat64(offset + 88, true);
        const extentsHeight = annotationView.getFloat64(offset + 96, true);
        const columnType = annotationView.getInt32(offset + 104, true);
        const columnWidth = annotationView.getFloat64(offset + 112, true);
        const columnGutter = annotationView.getFloat64(offset + 120, true);
        const firstColumnHeight = readSafeU64(
          annotationView,
          offset + 128,
          `text annotation context ${index} column-height offset`,
        );
        const columnHeightCount = readSafeU64(
          annotationView,
          offset + 136,
          `text annotation context ${index} column-height count`,
        );
        const columnHeightEnd = checkedAdd(
          firstColumnHeight,
          columnHeightCount,
          `text annotation context ${index} column-height range`,
        );
        const ownerKind = textKindsByHandle.get(handle);
        const textContext = (flags & (1 << 3)) !== 0;
        const validTextOwner =
          ownerKind === TextEntityKind.Text ||
          ownerKind === TextEntityKind.AttributeDefinition ||
          ownerKind === TextEntityKind.Attribute;
        const commonInvalid =
          !Number.isFinite(scale) ||
          scale <= 0 ||
          !insertionPoint.every(Number.isFinite) ||
          !xAxisDirection.every(Number.isFinite) ||
          annotationView.getUint32(offset + 108, true) !== 0 ||
          firstColumnHeight !== expectedFirstColumnHeight ||
          columnHeightCount >
            MAX_TEXT_ANNOTATION_COLUMN_HEIGHTS_PER_CONTEXT ||
          columnHeightEnd > annotationColumnHeights.length ||
          annotationView.getBigUint64(offset + 144, true) !== 0n ||
          annotationView.getBigUint64(offset + 152, true) !== 0n;
        const textInvalid =
          !validTextOwner ||
          flags & ~0x9 ||
          attachment < 0 ||
          attachment > 5 ||
          !Number.isFinite(rectangleHeight) ||
          rectangleWidth !== 0 ||
          extentsWidth !== 0 ||
          extentsHeight !== 0 ||
          columnType !== 0 ||
          columnWidth !== 0 ||
          columnGutter !== 0 ||
          columnHeightCount !== 0;
        const mtextInvalid =
          ownerKind !== TextEntityKind.MText ||
          flags & ~0x7 ||
          attachment < 1 ||
          attachment > 9 ||
          Math.hypot(...xAxisDirection) <= Number.EPSILON ||
          ![
            rectangleHeight,
            rectangleWidth,
            extentsWidth,
            extentsHeight,
            columnWidth,
            columnGutter,
          ].every((value) => Number.isFinite(value) && value >= 0) ||
          columnType < 0 ||
          columnType > 2;
        if (commonInvalid || (textContext ? textInvalid : mtextInvalid)) {
          throw new Error(
            `text annotation context ${index} contains invalid metadata`,
          );
        }
        const context = textContext
          ? Object.freeze({
              kind: "text",
              scale,
              isDefault: Boolean(flags & 1),
              horizontalAlignment: attachment,
              insertionPoint: Object.freeze(insertionPoint),
              alignmentPoint: Object.freeze(xAxisDirection),
              rotation: rectangleHeight,
              columnHeights: annotationColumnHeights.subarray(
                firstColumnHeight,
                columnHeightEnd,
              ),
            })
          : Object.freeze({
              kind: "mtext",
              scale,
              isDefault: Boolean(flags & 1),
              autoHeight: Boolean(flags & 2),
              flowReversed: Boolean(flags & 4),
              attachment,
              insertionPoint: Object.freeze(insertionPoint),
              xAxisDirection: Object.freeze(xAxisDirection),
              rectangleHeight,
              rectangleWidth,
              extentsWidth,
              extentsHeight,
              columnType,
              columnWidth,
              columnGutter,
              columnHeights: annotationColumnHeights.subarray(
                firstColumnHeight,
                columnHeightEnd,
              ),
            });
        const contexts = annotationContextsByHandle.get(handle);
        if (contexts) {
          contexts.push(context);
        } else {
          annotationContextsByHandle.set(handle, [context]);
        }
        expectedFirstColumnHeight = columnHeightEnd;
      }
      if (expectedFirstColumnHeight !== annotationColumnHeights.length) {
        throw new Error(
          "text annotation column-height pool contains unreferenced records",
        );
      }
      for (const [handle, contexts] of annotationContextsByHandle) {
        const defaultCount = contexts.reduce(
          (count, context) => count + Number(context.isDefault),
          0,
        );
        if (defaultCount > 1) {
          throw new Error(
            `text entity ${handle} has multiple default annotation contexts`,
          );
        }
        annotationContextsByHandle.set(handle, Object.freeze(contexts));
      }
      return new TextEntityTable(
        buffer,
        stringOffset,
        section.recordCount,
        styles,
        columnHeights,
        annotationContextsByHandle,
      );
    });
  }

  async readHatchSource() {
    return this.memoize("hatch-source", async () => {
      const entities = this.getSection(SectionKind.HatchEntities);
      const loops = this.getSection(SectionKind.HatchLoops);
      const vertices = this.getSection(SectionKind.HatchVertices);
      const gradientColors = this.getSection(SectionKind.HatchGradientColors);
      const seedPoints = this.getSection(SectionKind.HatchSeedPoints);
      const patternLines = this.getSection(SectionKind.HatchPatternLines);
      const patternDashes = this.getSection(SectionKind.HatchPatternDashes);
      validateStringTableDirectoryEntry(entities, HATCH_ENTITY_RECORD_SIZE);
      validateRecordSection(loops, HATCH_LOOP_RECORD_SIZE);
      validateRecordSection(vertices, HATCH_VERTEX_RECORD_SIZE);
      validateRecordSection(
        gradientColors,
        HATCH_GRADIENT_COLOR_RECORD_SIZE,
      );
      validateRecordSection(seedPoints, HATCH_SEED_POINT_RECORD_SIZE);
      validateRecordSection(
        patternLines,
        HATCH_PATTERN_LINE_RECORD_SIZE,
      );
      validateRecordSection(
        patternDashes,
        HATCH_PATTERN_DASH_RECORD_SIZE,
      );
      for (const section of [
        entities,
        loops,
        vertices,
        gradientColors,
        seedPoints,
        patternLines,
        patternDashes,
      ]) {
        if (section.recordCount > MAX_HATCH_SOURCE_RECORDS) {
          throw new Error(
            `HATCH section ${section.kind} exceeds the ${MAX_HATCH_SOURCE_RECORDS}-record limit`,
          );
        }
      }
      if (
        patternLines &&
        patternLines.recordCount > MAX_HATCH_PATTERN_LINES
      ) {
        throw new Error(
          `HATCH pattern-line section exceeds the ${MAX_HATCH_PATTERN_LINES}-record limit`,
        );
      }

      const [
        entityBuffer,
        loopBuffer,
        vertexBuffer,
        gradientColorBuffer,
        seedPointBuffer,
        patternLineBuffer,
        patternDashBuffer,
      ] = await Promise.all([
        this.readWholeMetadataSection(entities),
        this.readWholeMetadataSection(loops),
        this.readWholeMetadataSection(vertices),
        this.readWholeMetadataSection(gradientColors),
        this.readWholeMetadataSection(seedPoints),
        patternLines
          ? this.readWholeMetadataSection(patternLines)
          : Promise.resolve(new ArrayBuffer(0)),
        patternDashes
          ? this.readWholeMetadataSection(patternDashes)
          : Promise.resolve(new ArrayBuffer(0)),
      ]);
      const entityView = new DataView(entityBuffer);
      const loopView = new DataView(loopBuffer);
      const vertexView = new DataView(vertexBuffer);
      const gradientColorView = new DataView(gradientColorBuffer);
      const seedPointView = new DataView(seedPointBuffer);
      const patternLineView = new DataView(patternLineBuffer);
      const patternDashView = new DataView(patternDashBuffer);
      const recordCount = entityView.getUint32(0, true);
      const recordSize = entityView.getUint32(4, true);
      const stringOffset = readSafeU64(
        entityView,
        8,
        "HATCH UTF-8 blob offset",
      );
      const minimumStringOffset = checkedAdd(
        STRING_TABLE_HEADER_SIZE,
        checkedMultiply(
          entities.recordCount,
          entities.recordSize,
          "HATCH entity bytes",
        ),
        "HATCH UTF-8 minimum offset",
      );
      if (
        recordCount !== entities.recordCount ||
        recordSize !== entities.recordSize ||
        stringOffset < minimumStringOffset ||
        stringOffset > entities.byteLength
      ) {
        throw new Error("HATCH string-table header is inconsistent");
      }

      const decoder = new TextDecoder("utf-8", { fatal: true });
      const validateString = (entityIndex, referenceOffset) => {
        const relativeOffset = entityView.getUint32(referenceOffset, true);
        const byteLength = entityView.getUint32(referenceOffset + 4, true);
        if (byteLength > MAX_CACHE_STRING_BYTES) {
          throw new Error(
            `HATCH entity ${entityIndex} contains an oversized string`,
          );
        }
        const start = checkedAdd(
          stringOffset,
          relativeOffset,
          "HATCH UTF-8 offset",
        );
        const end = checkedAdd(start, byteLength, "HATCH UTF-8 end");
        if (start < stringOffset || end > entities.byteLength) {
          throw new Error(
            `HATCH entity ${entityIndex} points outside its UTF-8 blob`,
          );
        }
        decoder.decode(new Uint8Array(entityBuffer, start, byteLength));
      };
      let expectedFirstLoop = 0;
      let expectedFirstGradientColor = 0;
      let expectedFirstSeedPoint = 0;
      for (let index = 0; index < entities.recordCount; index += 1) {
        const offset =
          STRING_TABLE_HEADER_SIZE + index * HATCH_ENTITY_RECORD_SIZE;
        validateString(index, offset + 32);
        validateString(index, offset + 40);
        const flags = entityView.getUint32(offset + 48, true);
        const style = entityView.getUint16(offset + 52, true);
        const patternType = entityView.getUint16(offset + 54, true);
        if (flags & ~0x7f || style > HatchStyle.Ignore || patternType > 2) {
          throw new Error(
            `HATCH entity ${index} has unsupported flags or enum values`,
          );
        }
        const backgroundColor = entityView.getUint32(offset + 184, true);
        if (
          flags & HatchFlags.BackgroundColor
            ? backgroundColor >>> 30 !== 3
            : backgroundColor !== 0
        ) {
          throw new Error(
            `HATCH entity ${index} has an invalid background color`,
          );
        }
        const firstLoop = readSafeU64(
          entityView,
          offset + 56,
          "HATCH loop offset",
        );
        const loopCount = readSafeU64(
          entityView,
          offset + 64,
          "HATCH loop count",
        );
        const firstGradientColor = readSafeU64(
          entityView,
          offset + 72,
          "HATCH gradient-color offset",
        );
        const gradientColorCount = readSafeU64(
          entityView,
          offset + 80,
          "HATCH gradient-color count",
        );
        const firstSeedPoint = readSafeU64(
          entityView,
          offset + 168,
          "HATCH seed-point offset",
        );
        const seedPointCount = readSafeU64(
          entityView,
          offset + 176,
          "HATCH seed-point count",
        );
        if (
          firstLoop !== expectedFirstLoop ||
          firstGradientColor !== expectedFirstGradientColor ||
          firstSeedPoint !== expectedFirstSeedPoint ||
          checkedAdd(firstLoop, loopCount, "HATCH loop range") >
            loops.recordCount ||
          checkedAdd(
            firstGradientColor,
            gradientColorCount,
            "HATCH gradient-color range",
          ) > gradientColors.recordCount ||
          checkedAdd(
            firstSeedPoint,
            seedPointCount,
            "HATCH seed-point range",
          ) > seedPoints.recordCount
        ) {
          throw new Error(`HATCH entity ${index} has an invalid pool range`);
        }
        expectedFirstLoop += loopCount;
        expectedFirstGradientColor += gradientColorCount;
        expectedFirstSeedPoint += seedPointCount;
        const finiteOffsets = [
          88, 96, 104, 112, 120, 128, 136, 144, 152, 160,
        ];
        if (
          finiteOffsets.some(
            (relativeOffset) =>
              !Number.isFinite(
                entityView.getFloat64(offset + relativeOffset, true),
              ),
          )
        ) {
          throw new Error(`HATCH entity ${index} has a non-finite scalar`);
        }
        const normalLengthSquared =
          entityView.getFloat64(offset + 96, true) ** 2 +
          entityView.getFloat64(offset + 104, true) ** 2 +
          entityView.getFloat64(offset + 112, true) ** 2;
        if (
          !Number.isFinite(normalLengthSquared) ||
          normalLengthSquared <= 1e-12
        ) {
          throw new Error(`HATCH entity ${index} has an invalid normal`);
        }
      }
      if (
        expectedFirstLoop !== loops.recordCount ||
        expectedFirstGradientColor !== gradientColors.recordCount ||
        expectedFirstSeedPoint !== seedPoints.recordCount
      ) {
        throw new Error("HATCH source pools are not fully covered");
      }

      let expectedFirstVertex = 0;
      for (let index = 0; index < loops.recordCount; index += 1) {
        const offset = index * HATCH_LOOP_RECORD_SIZE;
        const hatchIndex = readSafeU64(
          loopView,
          offset,
          "HATCH loop source index",
        );
        const pathFlags = loopView.getUint32(offset + 8, true);
        const firstVertex = readSafeU64(
          loopView,
          offset + 16,
          "HATCH vertex offset",
        );
        const vertexCount = readSafeU64(
          loopView,
          offset + 24,
          "HATCH vertex count",
        );
        const flags = loopView.getUint32(offset + 36, true);
        const signedArea = loopView.getFloat64(offset + 40, true);
        if (
          hatchIndex >= entities.recordCount ||
          pathFlags & 32 ||
          firstVertex !== expectedFirstVertex ||
          vertexCount < 3 ||
          flags & ~1 ||
          !Number.isFinite(signedArea) ||
          Math.abs(signedArea) <= 1e-18 ||
          checkedAdd(firstVertex, vertexCount, "HATCH vertex range") >
            vertices.recordCount
        ) {
          throw new Error(`HATCH loop ${index} has invalid metadata`);
        }
        expectedFirstVertex += vertexCount;
      }
      if (expectedFirstVertex !== vertices.recordCount) {
        throw new Error("HATCH vertex pool is not fully covered");
      }

      for (let index = 0; index < vertices.recordCount; index += 1) {
        const offset = index * HATCH_VERTEX_RECORD_SIZE;
        if (
          [0, 8, 16].some(
            (relativeOffset) =>
              !Number.isFinite(
                vertexView.getFloat64(offset + relativeOffset, true),
              ),
          )
        ) {
          throw new Error(`HATCH vertex ${index} contains a non-finite value`);
        }
      }
      for (let index = 0; index < gradientColors.recordCount; index += 1) {
        if (
          !Number.isFinite(
            gradientColorView.getFloat64(
              index * HATCH_GRADIENT_COLOR_RECORD_SIZE,
              true,
            ),
          )
        ) {
          throw new Error(
            `HATCH gradient color ${index} contains a non-finite value`,
          );
        }
      }
      for (let index = 0; index < seedPoints.recordCount; index += 1) {
        const offset = index * HATCH_SEED_POINT_RECORD_SIZE;
        if (
          !Number.isFinite(seedPointView.getFloat64(offset, true)) ||
          !Number.isFinite(seedPointView.getFloat64(offset + 8, true))
        ) {
          throw new Error(
            `HATCH seed point ${index} contains a non-finite value`,
          );
        }
      }

      const patternLineStarts = new Uint32Array(entities.recordCount);
      const patternLineCounts = new Uint32Array(entities.recordCount);
      const patternDashCounts = new Uint32Array(entities.recordCount);
      let expectedFirstDash = 0;
      let previousHatchIndex = -1;
      let previousSourceLineIndex = -1;
      for (
        let index = 0;
        index < (patternLines?.recordCount ?? 0);
        index += 1
      ) {
        const offset = index * HATCH_PATTERN_LINE_RECORD_SIZE;
        const hatchIndex = readSafeU64(
          patternLineView,
          offset,
          "HATCH pattern-line source index",
        );
        const sourceLineIndex = patternLineView.getUint32(offset + 8, true);
        const flags = patternLineView.getUint32(offset + 12, true);
        const firstDash = readSafeU64(
          patternLineView,
          offset + 56,
          "HATCH pattern-dash offset",
        );
        const dashCount = patternLineView.getUint32(offset + 64, true);
        const reserved = patternLineView.getUint32(offset + 68, true);
        const definitionLineCount =
          hatchIndex < entities.recordCount
            ? entityView.getUint32(
                STRING_TABLE_HEADER_SIZE +
                  hatchIndex * HATCH_ENTITY_RECORD_SIZE +
                  188,
                true,
              )
            : 0;
        if (
          hatchIndex >= entities.recordCount ||
          hatchIndex < previousHatchIndex ||
          sourceLineIndex >= definitionLineCount ||
          (hatchIndex === previousHatchIndex &&
            sourceLineIndex <= previousSourceLineIndex) ||
          flags !== 0 ||
          reserved !== 0 ||
          firstDash !== expectedFirstDash ||
          patternLineCounts[hatchIndex] >=
            MAX_HATCH_PATTERN_LINES_PER_ENTITY ||
          patternDashCounts[hatchIndex] + dashCount >
            MAX_HATCH_PATTERN_DASHES_PER_ENTITY ||
          checkedAdd(firstDash, dashCount, "HATCH pattern-dash range") >
            (patternDashes?.recordCount ?? 0) ||
          [16, 24, 32, 40, 48].some(
            (relativeOffset) =>
              !Number.isFinite(
                patternLineView.getFloat64(
                  offset + relativeOffset,
                  true,
                ),
              ),
          )
        ) {
          throw new Error(`HATCH pattern line ${index} has invalid metadata`);
        }
        if (hatchIndex !== previousHatchIndex) {
          previousSourceLineIndex = -1;
        }
        patternLineCounts[hatchIndex] += 1;
        patternDashCounts[hatchIndex] += dashCount;
        expectedFirstDash += dashCount;
        previousHatchIndex = hatchIndex;
        previousSourceLineIndex = sourceLineIndex;
      }
      if (expectedFirstDash !== (patternDashes?.recordCount ?? 0)) {
        throw new Error("HATCH pattern-dash pool is not fully covered");
      }
      for (
        let index = 0;
        index < (patternDashes?.recordCount ?? 0);
        index += 1
      ) {
        if (
          !Number.isFinite(
            patternDashView.getFloat64(
              index * HATCH_PATTERN_DASH_RECORD_SIZE,
              true,
            ),
          )
        ) {
          throw new Error(`HATCH pattern dash ${index} is non-finite`);
        }
      }
      let firstPatternLine = 0;
      for (let index = 0; index < patternLineCounts.length; index += 1) {
        patternLineStarts[index] = firstPatternLine;
        firstPatternLine += patternLineCounts[index];
      }

      return new HatchSourceTable({
        entityBuffer,
        stringOffset,
        entityCount: entities.recordCount,
        loopBuffer,
        loopCount: loops.recordCount,
        vertexBuffer,
        vertexCount: vertices.recordCount,
        gradientColorBuffer,
        gradientColorCount: gradientColors.recordCount,
        seedPointBuffer,
        seedPointCount: seedPoints.recordCount,
        patternLineBuffer,
        patternLineCount: patternLines.recordCount,
        patternDashBuffer,
        patternDashCount: patternDashes.recordCount,
        patternLineStarts,
        patternLineCounts,
      });
    });
  }

  async readPointEntities() {
    return this.memoize("point-entities", async () => {
      const section = this.getSection(SectionKind.PointEntities);
      validateRecordSection(section, POINT_ENTITY_RECORD_SIZE);
      if (section.recordCount > MAX_POINT_SOURCE_RECORDS) {
        throw new Error(
          `POINT section exceeds the ${MAX_POINT_SOURCE_RECORDS}-record limit`,
        );
      }
      const layerCount = this.getSection(SectionKind.Layers).recordCount;
      const buffer = await this.readWholeMetadataSection(section);
      const view = new DataView(buffer);
      for (let index = 0; index < section.recordCount; index += 1) {
        const offset = index * POINT_ENTITY_RECORD_SIZE;
        validatePrimitiveCommon(
          view,
          offset,
          layerCount,
          "POINT",
          index,
        );
        if (
          view.getUint16(offset + 106, true) !== 0 ||
          view.getUint32(offset + 108, true) !== 0
        ) {
          throw new Error(`POINT entity ${index} has nonzero reserved metadata`);
        }
        for (const valueOffset of [32, 40, 48, 56, 64, 72, 80, 88, 96]) {
          if (!Number.isFinite(view.getFloat64(offset + valueOffset, true))) {
            throw new Error(`POINT entity ${index} contains a non-finite value`);
          }
        }
        const normalLengthSquared =
          view.getFloat64(offset + 56, true) ** 2 +
          view.getFloat64(offset + 64, true) ** 2 +
          view.getFloat64(offset + 72, true) ** 2;
        if (
          !Number.isFinite(normalLengthSquared) ||
          normalLengthSquared <= 1e-12
        ) {
          throw new Error(`POINT entity ${index} has an invalid normal`);
        }
      }
      return new PointSourceTable(buffer, section.recordCount);
    });
  }

  async readSolidEntities() {
    return this.memoize("solid-entities", async () => {
      const section = this.getSection(SectionKind.SolidEntities);
      validateRecordSection(section, SOLID_ENTITY_RECORD_SIZE);
      if (section.recordCount > MAX_SOLID_SOURCE_RECORDS) {
        throw new Error(
          `SOLID section exceeds the ${MAX_SOLID_SOURCE_RECORDS}-record limit`,
        );
      }
      const layerCount = this.getSection(SectionKind.Layers).recordCount;
      const buffer = await this.readWholeMetadataSection(section);
      const view = new DataView(buffer);
      for (let index = 0; index < section.recordCount; index += 1) {
        const offset = index * SOLID_ENTITY_RECORD_SIZE;
        validatePrimitiveCommon(
          view,
          offset,
          layerCount,
          "SOLID",
          index,
        );
        if (
          view.getUint32(offset + 32, true) & ~1 ||
          view.getUint32(offset + 36, true) !== 0
        ) {
          throw new Error(
            `SOLID entity ${index} has invalid flags or reserved metadata`,
          );
        }
        for (let valueOffset = 40; valueOffset <= 160; valueOffset += 8) {
          if (!Number.isFinite(view.getFloat64(offset + valueOffset, true))) {
            throw new Error(`SOLID entity ${index} contains a non-finite value`);
          }
        }
        const normalLengthSquared =
          view.getFloat64(offset + 136, true) ** 2 +
          view.getFloat64(offset + 144, true) ** 2 +
          view.getFloat64(offset + 152, true) ** 2;
        if (
          !Number.isFinite(normalLengthSquared) ||
          normalLengthSquared <= 1e-12
        ) {
          throw new Error(`SOLID entity ${index} has an invalid normal`);
        }
      }
      return new SolidSourceTable(buffer, section.recordCount);
    });
  }

  async readFaceEntities() {
    return this.memoize("face-entities", async () => {
      const section = this.getSection(SectionKind.FaceEntities);
      validateRecordSection(section, FACE_ENTITY_RECORD_SIZE);
      if (section.recordCount > MAX_FACE_SOURCE_RECORDS) {
        throw new Error(
          `3DFACE section exceeds the ${MAX_FACE_SOURCE_RECORDS}-record limit`,
        );
      }
      const layerCount = this.getSection(SectionKind.Layers).recordCount;
      const buffer = await this.readWholeMetadataSection(section);
      const view = new DataView(buffer);
      for (let index = 0; index < section.recordCount; index += 1) {
        const offset = index * FACE_ENTITY_RECORD_SIZE;
        validatePrimitiveCommon(
          view,
          offset,
          layerCount,
          "3DFACE",
          index,
        );
        if (
          view.getUint32(offset + 32, true) & ~0xf ||
          view.getUint32(offset + 36, true) !== 0
        ) {
          throw new Error(
            `3DFACE entity ${index} has invalid flags or reserved metadata`,
          );
        }
        for (let valueOffset = 40; valueOffset < 136; valueOffset += 8) {
          if (!Number.isFinite(view.getFloat64(offset + valueOffset, true))) {
            throw new Error(
              `3DFACE entity ${index} contains a non-finite coordinate`,
            );
          }
        }
      }
      return new FaceSourceTable(buffer, section.recordCount);
    });
  }

  async readWipeoutEntities() {
    return this.memoize("wipeout-entities", async () => {
      const entities = this.getSection(SectionKind.WipeoutEntities);
      const clipVertices = this.getSection(
        SectionKind.WipeoutClipVertices,
      );
      validateRecordSection(entities, WIPEOUT_ENTITY_RECORD_SIZE);
      validateRecordSection(
        clipVertices,
        WIPEOUT_CLIP_VERTEX_RECORD_SIZE,
      );
      if (entities.recordCount > MAX_WIPEOUT_SOURCE_RECORDS) {
        throw new Error(
          `WIPEOUT section exceeds the ${MAX_WIPEOUT_SOURCE_RECORDS}-record limit`,
        );
      }
      if (clipVertices.recordCount > MAX_WIPEOUT_CLIP_VERTICES) {
        throw new Error(
          `WIPEOUT clip vertices exceed the ${MAX_WIPEOUT_CLIP_VERTICES}-record limit`,
        );
      }
      const layerCount = this.getSection(SectionKind.Layers).recordCount;
      const [entityBuffer, clipVertexBuffer] = await Promise.all([
        this.readWholeMetadataSection(entities),
        this.readWholeMetadataSection(clipVertices),
      ]);
      const entityView = new DataView(entityBuffer);
      const clipVertexView = new DataView(clipVertexBuffer);
      let expectedFirstVertex = 0;
      for (let index = 0; index < entities.recordCount; index += 1) {
        const offset = index * WIPEOUT_ENTITY_RECORD_SIZE;
        validatePrimitiveCommon(
          entityView,
          offset,
          layerCount,
          "WIPEOUT",
          index,
        );
        const displayProperties = entityView.getUint16(offset + 36, true);
        const clipType = entityView.getUint8(offset + 38);
        const clippingEnabled = entityView.getUint8(offset + 39);
        const brightness = entityView.getUint8(offset + 40);
        const contrast = entityView.getUint8(offset + 41);
        const fade = entityView.getUint8(offset + 42);
        const clipMode = entityView.getUint8(offset + 43);
        const firstVertex = readSafeU64(
          entityView,
          offset + 48,
          `WIPEOUT entity ${index} first clip vertex`,
        );
        const vertexCount = entityView.getUint32(offset + 56, true);
        if (
          displayProperties & ~0xf ||
          (clipType !== 1 && clipType !== 2) ||
          clippingEnabled > 1 ||
          brightness > 100 ||
          contrast > 100 ||
          fade > 100 ||
          clipMode > 1 ||
          entityView.getUint32(offset + 44, true) !== 0 ||
          entityView.getUint32(offset + 60, true) !== 0 ||
          firstVertex !== expectedFirstVertex ||
          (clipType === 1 && vertexCount !== 2) ||
          (clipType === 2 && vertexCount < 3)
        ) {
          throw new Error(`WIPEOUT entity ${index} has invalid metadata`);
        }
        expectedFirstVertex = checkedAdd(
          firstVertex,
          vertexCount,
          `WIPEOUT entity ${index} clip-vertex range`,
        );
        if (expectedFirstVertex > clipVertices.recordCount) {
          throw new Error(
            `WIPEOUT entity ${index} has an invalid clip-vertex range`,
          );
        }
        for (let valueOffset = 80; valueOffset < 168; valueOffset += 8) {
          if (
            !Number.isFinite(entityView.getFloat64(offset + valueOffset, true))
          ) {
            throw new Error(
              `WIPEOUT entity ${index} contains a non-finite value`,
            );
          }
        }
        const ux = entityView.getFloat64(offset + 104, true);
        const uy = entityView.getFloat64(offset + 112, true);
        const uz = entityView.getFloat64(offset + 120, true);
        const vx = entityView.getFloat64(offset + 128, true);
        const vy = entityView.getFloat64(offset + 136, true);
        const vz = entityView.getFloat64(offset + 144, true);
        const crossX = uy * vz - uz * vy;
        const crossY = uz * vx - ux * vz;
        const crossZ = ux * vy - uy * vx;
        const basisLengthSquared =
          crossX * crossX + crossY * crossY + crossZ * crossZ;
        if (
          !Number.isFinite(basisLengthSquared) ||
          basisLengthSquared <= 1e-24 ||
          entityView.getFloat64(offset + 152, true) <= 0 ||
          entityView.getFloat64(offset + 160, true) <= 0
        ) {
          throw new Error(
            `WIPEOUT entity ${index} has an invalid image basis or size`,
          );
        }
      }
      if (expectedFirstVertex !== clipVertices.recordCount) {
        throw new Error("WIPEOUT clip-vertex pool is not fully covered");
      }
      for (let index = 0; index < clipVertices.recordCount; index += 1) {
        const offset = index * WIPEOUT_CLIP_VERTEX_RECORD_SIZE;
        if (
          !Number.isFinite(clipVertexView.getFloat64(offset, true)) ||
          !Number.isFinite(clipVertexView.getFloat64(offset + 8, true))
        ) {
          throw new Error(
            `WIPEOUT clip vertex ${index} contains a non-finite coordinate`,
          );
        }
      }
      return new WipeoutSourceTable(
        entityBuffer,
        entities.recordCount,
        clipVertexBuffer,
        clipVertices.recordCount,
      );
    });
  }

  async readImageEntities() {
    return this.memoize("image-entities", async () => {
      const entities = this.getSection(SectionKind.ImageEntities);
      const clipVertices = this.getSection(SectionKind.ImageClipVertices);
      validateStringTableDirectoryEntry(
        entities,
        IMAGE_ENTITY_RECORD_SIZE,
      );
      validateRecordSection(
        clipVertices,
        IMAGE_CLIP_VERTEX_RECORD_SIZE,
      );
      if (entities.recordCount > MAX_IMAGE_SOURCE_RECORDS) {
        throw new Error(
          `IMAGE section exceeds the ${MAX_IMAGE_SOURCE_RECORDS}-record limit`,
        );
      }
      if (clipVertices.recordCount > MAX_IMAGE_CLIP_VERTICES) {
        throw new Error(
          `IMAGE clip vertices exceed the ${MAX_IMAGE_CLIP_VERTICES}-record limit`,
        );
      }
      const layerCount = this.getSection(SectionKind.Layers).recordCount;
      const [entityBuffer, clipVertexBuffer] = await Promise.all([
        this.readWholeMetadataSection(entities),
        this.readWholeMetadataSection(clipVertices),
      ]);
      const entityView = new DataView(entityBuffer);
      const clipVertexView = new DataView(clipVertexBuffer);
      const recordCount = entityView.getUint32(0, true);
      const recordSize = entityView.getUint32(4, true);
      const stringOffset = readSafeU64(
        entityView,
        8,
        "IMAGE UTF-8 blob offset",
      );
      const minimumStringOffset = checkedAdd(
        STRING_TABLE_HEADER_SIZE,
        checkedMultiply(
          entities.recordCount,
          IMAGE_ENTITY_RECORD_SIZE,
          "IMAGE record bytes",
        ),
        "IMAGE UTF-8 minimum offset",
      );
      if (
        recordCount !== entities.recordCount ||
        recordSize !== IMAGE_ENTITY_RECORD_SIZE ||
        stringOffset < minimumStringOffset ||
        stringOffset > entities.byteLength
      ) {
        throw new Error("IMAGE string-table header is inconsistent");
      }
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let expectedFirstVertex = 0;
      for (let index = 0; index < entities.recordCount; index += 1) {
        const offset =
          STRING_TABLE_HEADER_SIZE + index * IMAGE_ENTITY_RECORD_SIZE;
        validatePrimitiveCommon(
          entityView,
          offset,
          layerCount,
          "IMAGE",
          index,
        );
        const relativePathOffset = entityView.getUint32(offset + 32, true);
        const pathByteLength = entityView.getUint32(offset + 36, true);
        const pathStart = checkedAdd(
          stringOffset,
          relativePathOffset,
          `IMAGE entity ${index} path offset`,
        );
        const pathEnd = checkedAdd(
          pathStart,
          pathByteLength,
          `IMAGE entity ${index} path end`,
        );
        if (
          pathByteLength > MAX_CACHE_STRING_BYTES ||
          pathStart < stringOffset ||
          pathEnd > entities.byteLength
        ) {
          throw new Error(`IMAGE entity ${index} has an invalid path`);
        }
        decoder.decode(
          new Uint8Array(entityBuffer, pathStart, pathByteLength),
        );
        const displayProperties = entityView.getUint16(offset + 44, true);
        const clipType = entityView.getUint8(offset + 46);
        const clippingEnabled = entityView.getUint8(offset + 47);
        const brightness = entityView.getUint8(offset + 48);
        const contrast = entityView.getUint8(offset + 49);
        const fade = entityView.getUint8(offset + 50);
        const clipMode = entityView.getUint8(offset + 51);
        const firstVertex = readSafeU64(
          entityView,
          offset + 56,
          `IMAGE entity ${index} first clip vertex`,
        );
        const vertexCount = entityView.getUint32(offset + 64, true);
        const validBoundary =
          vertexCount === 0
            ? clipType <= 2
            : (clipType === 1 && vertexCount === 2) ||
              (clipType === 2 && vertexCount >= 3);
        if (
          displayProperties & ~0xf ||
          clippingEnabled > 1 ||
          brightness > 100 ||
          contrast > 100 ||
          fade > 100 ||
          clipMode > 1 ||
          entityView.getUint32(offset + 52, true) !== 0 ||
          entityView.getUint32(offset + 68, true) !== 0 ||
          firstVertex !== expectedFirstVertex ||
          !validBoundary ||
          (clippingEnabled === 1 &&
            (displayProperties & 4) !== 0 &&
            vertexCount === 0)
        ) {
          throw new Error(`IMAGE entity ${index} has invalid metadata`);
        }
        expectedFirstVertex = checkedAdd(
          firstVertex,
          vertexCount,
          `IMAGE entity ${index} clip-vertex range`,
        );
        if (expectedFirstVertex > clipVertices.recordCount) {
          throw new Error(
            `IMAGE entity ${index} has an invalid clip-vertex range`,
          );
        }
        for (let valueOffset = 88; valueOffset < 176; valueOffset += 8) {
          if (
            !Number.isFinite(entityView.getFloat64(offset + valueOffset, true))
          ) {
            throw new Error(
              `IMAGE entity ${index} contains a non-finite value`,
            );
          }
        }
        const ux = entityView.getFloat64(offset + 112, true);
        const uy = entityView.getFloat64(offset + 120, true);
        const uz = entityView.getFloat64(offset + 128, true);
        const vx = entityView.getFloat64(offset + 136, true);
        const vy = entityView.getFloat64(offset + 144, true);
        const vz = entityView.getFloat64(offset + 152, true);
        const crossX = uy * vz - uz * vy;
        const crossY = uz * vx - ux * vz;
        const crossZ = ux * vy - uy * vx;
        const basisLengthSquared =
          crossX * crossX + crossY * crossY + crossZ * crossZ;
        if (
          !Number.isFinite(basisLengthSquared) ||
          basisLengthSquared <= 1e-24 ||
          entityView.getFloat64(offset + 160, true) <= 0 ||
          entityView.getFloat64(offset + 168, true) <= 0
        ) {
          throw new Error(
            `IMAGE entity ${index} has an invalid image basis or size`,
          );
        }
      }
      if (expectedFirstVertex !== clipVertices.recordCount) {
        throw new Error("IMAGE clip-vertex pool is not fully covered");
      }
      for (let index = 0; index < clipVertices.recordCount; index += 1) {
        const offset = index * IMAGE_CLIP_VERTEX_RECORD_SIZE;
        if (
          !Number.isFinite(clipVertexView.getFloat64(offset, true)) ||
          !Number.isFinite(clipVertexView.getFloat64(offset + 8, true))
        ) {
          throw new Error(
            `IMAGE clip vertex ${index} contains a non-finite coordinate`,
          );
        }
      }
      return new ImageSourceTable(
        entityBuffer,
        stringOffset,
        entities.recordCount,
        clipVertexBuffer,
        clipVertices.recordCount,
      );
    });
  }

  async readEmbeddedImages() {
    return this.memoize("embedded-images", async () => {
      const recordSection = this.getSection(
        SectionKind.EmbeddedImageRecords,
      );
      const byteSection = this.getSection(SectionKind.EmbeddedImageBytes);
      const imageSection = this.getSection(SectionKind.ImageEntities);
      validateRecordSection(recordSection, EMBEDDED_IMAGE_RECORD_SIZE);
      validateRecordSection(byteSection, EMBEDDED_IMAGE_BYTE_RECORD_SIZE);
      if (recordSection.recordCount > imageSection.recordCount) {
        throw new Error("embedded IMAGE records exceed the IMAGE table");
      }
      if (byteSection.byteLength > MAX_EMBEDDED_IMAGE_BYTES) {
        throw new Error(
          `embedded IMAGE bytes exceed the ${MAX_EMBEDDED_IMAGE_BYTES}-byte limit`,
        );
      }
      const buffer = await this.readWholeMetadataSection(recordSection);
      const view = new DataView(buffer);
      const records = new Array(recordSection.recordCount);
      let expectedPayloadOffset = 0;
      let previousImageIndex = -1;
      for (let index = 0; index < recordSection.recordCount; index += 1) {
        const offset = index * EMBEDDED_IMAGE_RECORD_SIZE;
        const imageIndex = view.getUint32(offset, true);
        const mime = view.getUint32(offset + 4, true);
        const payloadOffset = readSafeU64(
          view,
          offset + 8,
          `embedded IMAGE ${index} payload offset`,
        );
        const payloadLength = readSafeU64(
          view,
          offset + 16,
          `embedded IMAGE ${index} payload length`,
        );
        const width = view.getUint32(offset + 24, true);
        const height = view.getUint32(offset + 28, true);
        const flags = view.getUint32(offset + 32, true);
        const pixels = width * height;
        const payloadEnd = checkedAdd(
          payloadOffset,
          payloadLength,
          `embedded IMAGE ${index} payload end`,
        );
        if (
          imageIndex >= imageSection.recordCount ||
          imageIndex <= previousImageIndex ||
          (mime !== 1 && mime !== 2) ||
          payloadOffset !== expectedPayloadOffset ||
          payloadLength <= 0 ||
          payloadLength > MAX_EMBEDDED_IMAGE_BYTES_PER_RECORD ||
          payloadEnd > byteSection.byteLength ||
          !Number.isSafeInteger(pixels) ||
          pixels <= 0 ||
          pixels > MAX_EMBEDDED_IMAGE_PIXELS ||
          (mime === 1 && (flags & ~1) !== 0) ||
          (mime === 2 && flags !== 2) ||
          view.getUint32(offset + 36, true) !== 0
        ) {
          throw new Error(`embedded IMAGE record ${index} is invalid`);
        }
        records[index] = Object.freeze({
          imageIndex,
          mimeType: mime === 1 ? "image/bmp" : "application/x-emf",
          payloadOffset,
          payloadLength,
          width,
          height,
          sourceBmp: Boolean(flags & 1),
          sourceEmf: Boolean(flags & 2),
        });
        previousImageIndex = imageIndex;
        expectedPayloadOffset = payloadEnd;
      }
      if (expectedPayloadOffset !== byteSection.byteLength) {
        throw new Error("embedded IMAGE byte pool is not fully covered");
      }
      return new EmbeddedImageSourceTable(
        this.source,
        byteSection,
        Object.freeze(records),
      );
    });
  }

  async readDrawOrder() {
    return this.memoize("draw-order", async () => {
      const tables = this.getSection(SectionKind.DrawOrderTables);
      const entries = this.getSection(SectionKind.DrawOrderEntries);
      validateRecordSection(tables, DRAW_ORDER_TABLE_RECORD_SIZE);
      validateRecordSection(entries, DRAW_ORDER_ENTRY_RECORD_SIZE);
      if (tables.recordCount > MAX_DRAW_ORDER_TABLES) {
        throw new Error(
          `draw-order tables exceed the ${MAX_DRAW_ORDER_TABLES}-record limit`,
        );
      }
      if (entries.recordCount > MAX_DRAW_ORDER_ENTRIES) {
        throw new Error(
          `draw-order entries exceed the ${MAX_DRAW_ORDER_ENTRIES}-record limit`,
        );
      }
      const [tableBuffer, entryBuffer] = await Promise.all([
        this.readWholeMetadataSection(tables),
        this.readWholeMetadataSection(entries),
      ]);
      const tableView = new DataView(tableBuffer);
      const entryView = new DataView(entryBuffer);
      let expectedFirstEntry = 0;
      let previousOwner = -1n;
      let previousTable = -1n;
      for (let index = 0; index < tables.recordCount; index += 1) {
        const offset = index * DRAW_ORDER_TABLE_RECORD_SIZE;
        const handle = tableView.getBigUint64(offset, true);
        const ownerHandle = tableView.getBigUint64(offset + 8, true);
        const firstEntry = readSafeU64(
          tableView,
          offset + 16,
          `draw-order table ${index} first entry`,
        );
        const entryCount = readSafeU64(
          tableView,
          offset + 24,
          `draw-order table ${index} entry count`,
        );
        if (
          firstEntry !== expectedFirstEntry ||
          tableView.getUint32(offset + 32, true) !== 0 ||
          tableView.getUint32(offset + 36, true) !== 0 ||
          ownerHandle < previousOwner ||
          (ownerHandle === previousOwner && handle < previousTable)
        ) {
          throw new Error(`draw-order table ${index} has invalid metadata`);
        }
        expectedFirstEntry = checkedAdd(
          firstEntry,
          entryCount,
          `draw-order table ${index} entry range`,
        );
        if (expectedFirstEntry > entries.recordCount) {
          throw new Error(
            `draw-order table ${index} has an invalid entry range`,
          );
        }
        let previousEntity = -1n;
        let previousSort = -1n;
        for (let entry = firstEntry; entry < expectedFirstEntry; entry += 1) {
          const entryOffset = entry * DRAW_ORDER_ENTRY_RECORD_SIZE;
          const entityHandle = entryView.getBigUint64(entryOffset, true);
          const sortHandle = entryView.getBigUint64(entryOffset + 8, true);
          if (
            entityHandle < previousEntity ||
            (entityHandle === previousEntity && sortHandle < previousSort)
          ) {
            throw new Error(
              `draw-order table ${index} entries are not normalized`,
            );
          }
          previousEntity = entityHandle;
          previousSort = sortHandle;
        }
        previousOwner = ownerHandle;
        previousTable = handle;
      }
      if (expectedFirstEntry !== entries.recordCount) {
        throw new Error("draw-order entry pool is not fully covered");
      }
      return new DrawOrderSourceTable(
        tableBuffer,
        tables.recordCount,
        entryBuffer,
        entries.recordCount,
      );
    });
  }

  async readDisplayOrderIdentities({
    maximumRecords = DEFAULT_MAX_DISPLAY_ORDER_IDENTITY_RECORDS,
    maximumBytes = DEFAULT_MAX_DISPLAY_ORDER_IDENTITY_BYTES,
  } = {}) {
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords <= 0) {
      throw new RangeError(
        "display-order identity record limit must be positive",
      );
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new RangeError(
        "display-order identity byte limit must be positive",
      );
    }
    return this.memoize(
      `display-order-identities:${maximumRecords}:${maximumBytes}`,
      async () => {
        const specifications = [
          [SectionKind.TextEntities, TEXT_ENTITY_RECORD_SIZE, true],
          [SectionKind.HatchEntities, HATCH_ENTITY_RECORD_SIZE, true],
          [SectionKind.PointEntities, POINT_ENTITY_RECORD_SIZE, false],
          [SectionKind.SolidEntities, SOLID_ENTITY_RECORD_SIZE, false],
          [SectionKind.FaceEntities, FACE_ENTITY_RECORD_SIZE, false],
          [SectionKind.ImageEntities, IMAGE_ENTITY_RECORD_SIZE, true],
          ...(this.header.minor >= 23
            ? [
                [
                  SectionKind.ConstructionLines,
                  CONSTRUCTION_LINE_RECORD_SIZE,
                  false,
                ],
              ]
            : []),
        ].map(([kind, recordSize, stringTable]) => {
          const section = this.getSection(kind);
          if (stringTable) {
            validateStringTableDirectoryEntry(section, recordSize);
          } else {
            validateRecordSection(section, recordSize);
          }
          const prefixBytes = checkedAdd(
            stringTable ? STRING_TABLE_HEADER_SIZE : 0,
            checkedMultiply(
              section.recordCount,
              recordSize,
              "display-order identity record bytes",
            ),
            "display-order identity prefix bytes",
          );
          return { section, recordSize, stringTable, prefixBytes };
        });
        const sourceRecordCount = specifications.reduce(
          (total, { section }) =>
            checkedAdd(
              total,
              section.recordCount,
              "display-order identity count",
            ),
          0,
        );
        const byteLength = specifications.reduce(
          (total, { prefixBytes }) =>
            checkedAdd(
              total,
              prefixBytes,
              "display-order identity bytes",
            ),
          0,
        );
        if (
          sourceRecordCount > maximumRecords ||
          byteLength > maximumBytes
        ) {
          return Object.freeze(
            new DisplayOrderIdentitySourceTable(Object.freeze([]), {
              sourceRecordCount,
              byteLength,
              limited: true,
            }),
          );
        }

        const buffers = await Promise.all(
          specifications.map(({ section, prefixBytes }) =>
            this.source
              .read(section.offset, prefixBytes)
              .then((buffer) =>
                requireArrayBuffer(
                  buffer,
                  prefixBytes,
                  `display-order identity section ${section.kind}`,
                ),
              ),
          ),
        );
        const records = [];
        for (
          let specificationIndex = 0;
          specificationIndex < specifications.length;
          specificationIndex += 1
        ) {
          const {
            section,
            recordSize,
            stringTable,
            prefixBytes,
          } = specifications[specificationIndex];
          const buffer = buffers[specificationIndex];
          const view = new DataView(buffer);
          const firstRecord = stringTable ? STRING_TABLE_HEADER_SIZE : 0;
          if (stringTable) {
            const recordCount = view.getUint32(0, true);
            const storedRecordSize = view.getUint32(4, true);
            const stringOffset = readSafeU64(
              view,
              8,
              `display-order identity section ${section.kind} string offset`,
            );
            if (
              recordCount !== section.recordCount ||
              storedRecordSize !== recordSize ||
              stringOffset < prefixBytes ||
              stringOffset > section.byteLength
            ) {
              throw new Error(
                `display-order identity section ${section.kind} has an invalid string-table header`,
              );
            }
          }
          for (let index = 0; index < section.recordCount; index += 1) {
            const offset = firstRecord + index * recordSize;
            records.push(
              Object.freeze({
                handle: view.getBigUint64(offset, true),
                ownerHandle: view.getBigUint64(offset + 8, true),
                commonFlags: view.getUint16(offset + 26, true),
              }),
            );
          }
        }
        return Object.freeze(
          new DisplayOrderIdentitySourceTable(Object.freeze(records), {
            sourceRecordCount,
            byteLength,
          }),
        );
      },
    );
  }

  async readPolylineSource({
    maximumRangeBytes = MAX_CURVE_SOURCE_RANGE_BYTES,
    maximumSourceBytes = MAX_CURVE_SOURCE_BYTES,
  } = {}) {
    if (
      !Number.isSafeInteger(maximumRangeBytes) ||
      maximumRangeBytes < POLYLINE_HEADER_RECORD_SIZE ||
      maximumRangeBytes > MAX_CURVE_SOURCE_RANGE_BYTES
    ) {
      throw new RangeError(
        `polyline source range limit must be between ${POLYLINE_HEADER_RECORD_SIZE} and ${MAX_CURVE_SOURCE_RANGE_BYTES} bytes`,
      );
    }
    if (
      !Number.isSafeInteger(maximumSourceBytes) ||
      maximumSourceBytes < POLYLINE_HEADER_RECORD_SIZE ||
      maximumSourceBytes > MAX_CURVE_SOURCE_BYTES
    ) {
      throw new RangeError(
        `polyline source byte budget must be between ${POLYLINE_HEADER_RECORD_SIZE} and ${MAX_CURVE_SOURCE_BYTES} bytes`,
      );
    }
    const specifications = [
      [SectionKind.PolylineHeaders, "polyline headers"],
      [SectionKind.PolylineVertices, "polyline vertices"],
    ].map(([kind, label]) => {
      const section = this.sections.get(kind);
      if (!section) {
        throw new Error(`polyline source section ${kind} is missing`);
      }
      return { kind, label, section };
    });
    const byteLength = specifications.reduce(
      (total, { section }) =>
        checkedAdd(total, section.byteLength, "polyline source bytes"),
      0,
    );
    if (byteLength > maximumSourceBytes) {
      throw new Error(
        `polyline source is ${byteLength} bytes, above the ${maximumSourceBytes}-byte limit`,
      );
    }
    let requestCount = 0;
    let maximumReadBytes = 0;
    const tables = new Map();
    for (const { kind, label, section } of specifications) {
      const recordsPerChunk = Math.max(
        1,
        Math.floor(maximumRangeBytes / section.recordSize),
      );
      const chunks = [];
      for (
        let firstRecord = 0;
        firstRecord < section.recordCount;
        firstRecord += recordsPerChunk
      ) {
        const recordCount = Math.min(
          recordsPerChunk,
          section.recordCount - firstRecord,
        );
        const chunkByteLength = checkedMultiply(
          recordCount,
          section.recordSize,
          `${label} chunk bytes`,
        );
        const offset = checkedAdd(
          section.offset,
          checkedMultiply(
            firstRecord,
            section.recordSize,
            `${label} chunk offset`,
          ),
          `${label} source offset`,
        );
        const buffer = requireArrayBuffer(
          await this.source.read(offset, chunkByteLength),
          chunkByteLength,
          `${label} source chunk`,
        );
        chunks.push(
          Object.freeze({
            firstRecord,
            recordCount,
            buffer,
            view: new DataView(buffer),
          }),
        );
        requestCount += 1;
        maximumReadBytes = Math.max(maximumReadBytes, chunkByteLength);
      }
      const arguments_ = [
        Object.freeze(chunks),
        section.recordSize,
        section.recordCount,
        recordsPerChunk,
      ];
      tables.set(
        kind,
        kind === SectionKind.PolylineHeaders
          ? new PolylineHeaderSourceTable(
              ...arguments_,
              "polyline headers",
            )
          : new PolylineVertexSourceTable(
              ...arguments_,
              "polyline vertices",
            ),
      );
    }
    return Object.freeze({
      polylines: tables.get(SectionKind.PolylineHeaders),
      polylineVertices: tables.get(SectionKind.PolylineVertices),
      byteLength,
      requestCount,
      maximumReadBytes,
    });
  }

  async readCurveLinetypeScales() {
    return this.memoize("curve-linetype-scales", async () => {
      if (this.header.minor < 23) {
        return Object.freeze(new Map());
      }
      const section = this.getSection(SectionKind.CurveLinetypeScales);
      validateRecordSection(section, CURVE_LINETYPE_SCALE_RECORD_SIZE);
      const buffer = await this.readWholeMetadataSection(section);
      const view = new DataView(buffer);
      const scales = new Map();
      for (let index = 0; index < section.recordCount; index += 1) {
        const offset = index * section.recordSize;
        const handle = view.getBigUint64(offset, true);
        const scale = view.getFloat64(offset + 8, true);
        if (
          handle === 0n ||
          !Number.isFinite(scale) ||
          scale <= 0 ||
          scales.has(handle)
        ) {
          throw new Error(`curve linetype scale ${index} is invalid`);
        }
        scales.set(handle, scale);
      }
      return Object.freeze(scales);
    });
  }

  async readPrimitiveSource() {
    const [
      points,
      solids,
      faces,
      wipeouts,
      polylineSource,
      curveLinetypeScales,
    ] = await Promise.all([
      this.readPointEntities(),
      this.readSolidEntities(),
      this.readFaceEntities(),
      this.readWipeoutEntities(),
      this.readPolylineSource(),
      this.readCurveLinetypeScales(),
    ]);
    return Object.freeze({
      points,
      solids,
      faces,
      wipeouts,
      polylines: polylineSource.polylines,
      polylineVertices: polylineSource.polylineVertices,
      curveLinetypeScales,
    });
  }

  async readInsertClips() {
    return this.memoize("insert-clips", async () => {
      const records = this.getSection(SectionKind.InsertClips);
      const vertices = this.getSection(SectionKind.InsertClipVertices);
      validateRecordSection(records, INSERT_CLIP_RECORD_SIZE);
      validateRecordSection(
        vertices,
        INSERT_CLIP_VERTEX_RECORD_SIZE,
      );
      if (records.recordCount > MAX_INSERT_CLIPS) {
        throw new Error(
          `INSERT XCLIP section exceeds the ${MAX_INSERT_CLIPS}-record limit`,
        );
      }
      if (vertices.recordCount > MAX_INSERT_CLIP_VERTICES) {
        throw new Error(
          `INSERT XCLIP vertices exceed the ${MAX_INSERT_CLIP_VERTICES}-record limit`,
        );
      }
      const [recordBuffer, vertexBuffer, inserts] = await Promise.all([
        this.readWholeMetadataSection(records),
        this.readWholeMetadataSection(vertices),
        this.readInserts(),
      ]);
      const recordView = new DataView(recordBuffer);
      const vertexView = new DataView(vertexBuffer);
      const insertHandles = new Set(inserts.map((insert) => insert.handle));
      const seenHandles = new Set();
      const output = new Array(records.recordCount);
      let expectedFirstVertex = 0;
      for (let index = 0; index < records.recordCount; index += 1) {
        const offset = index * INSERT_CLIP_RECORD_SIZE;
        const insertHandle = recordView.getBigUint64(offset, true);
        const firstVertex = readSafeU64(
          recordView,
          offset + 8,
          `INSERT XCLIP ${index} first vertex`,
        );
        const vertexCount = recordView.getUint32(offset + 16, true);
        const flags = recordView.getUint32(offset + 20, true);
        const rectangular =
          (flags & InsertClipFlags.Rectangular) !== 0;
        if (
          !insertHandles.has(insertHandle) ||
          seenHandles.has(insertHandle) ||
          firstVertex !== expectedFirstVertex ||
          vertexCount < 2 ||
          vertexCount > MAX_INSERT_CLIP_VERTICES_PER_BOUNDARY ||
          (rectangular && vertexCount !== 2) ||
          (!rectangular && vertexCount < 3) ||
          (flags &
            ~(InsertClipFlags.Rectangular | InsertClipFlags.Inverted)) !==
            0 ||
          recordView.getBigUint64(offset + 24, true) !== 0n
        ) {
          throw new Error(`INSERT XCLIP ${index} has invalid metadata`);
        }
        expectedFirstVertex = checkedAdd(
          firstVertex,
          vertexCount,
          `INSERT XCLIP ${index} vertex range`,
        );
        if (expectedFirstVertex > vertices.recordCount) {
          throw new Error(
            `INSERT XCLIP ${index} has an invalid vertex range`,
          );
        }
        const points = new Array(vertexCount);
        for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
          const vertexOffset =
            (firstVertex + vertexIndex) * INSERT_CLIP_VERTEX_RECORD_SIZE;
          const x = vertexView.getFloat64(vertexOffset, true);
          const y = vertexView.getFloat64(vertexOffset + 8, true);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(
              `INSERT XCLIP ${index} contains a non-finite vertex`,
            );
          }
          points[vertexIndex] = Object.freeze([x, y, 0]);
        }
        seenHandles.add(insertHandle);
        output[index] = Object.freeze({
          index,
          insertHandle,
          rectangular,
          inverted: (flags & InsertClipFlags.Inverted) !== 0,
          vertices: Object.freeze(points),
        });
      }
      if (expectedFirstVertex !== vertices.recordCount) {
        throw new Error(
          "INSERT XCLIP vertex pool is not fully covered",
        );
      }
      return Object.freeze(output);
    });
  }

  async readInserts() {
    return this.memoize("inserts", async () => {
      const section = this.getSection(SectionKind.Inserts);
      const buffer = await this.readWholeMetadataSection(section);
      const view = new DataView(buffer);
      const inserts = new Array(section.recordCount);
      for (let index = 0; index < section.recordCount; index += 1) {
        const offset = index * section.recordSize;
        const linetypeCode = view.getUint32(offset + 28, true);
        if (linetypeCode > 2047) {
          throw new Error(`INSERT ${index} has an invalid linetype code`);
        }
        inserts[index] = Object.freeze({
          index,
          handle: view.getBigUint64(offset, true),
          ownerHandle: view.getBigUint64(offset + 8, true),
          layerIndex: view.getUint32(offset + 16, true),
          color: view.getUint32(offset + 20, true),
          lineWeight: view.getInt16(offset + 24, true),
          flags: view.getUint16(offset + 26, true),
          linetypeCode,
          blockIndex: view.getUint32(offset + 32, true),
          columnCount: view.getUint16(offset + 36, true),
          rowCount: view.getUint16(offset + 38, true),
          insertPoint: ensureFiniteVector(
            readVec3F64(view, offset + 40),
            "INSERT point",
          ),
          scale: ensureFiniteVector(readVec3F64(view, offset + 64), "INSERT scale"),
          rotation: view.getFloat64(offset + 88, true),
          normal: ensureFiniteVector(
            readVec3F64(view, offset + 96),
            "INSERT normal",
          ),
          columnSpacing: view.getFloat64(offset + 120, true),
          rowSpacing: view.getFloat64(offset + 128, true),
        });
      }
      return Object.freeze(inserts);
    });
  }

  async readCurveRefinementSource({
    maximumRangeBytes = MAX_CURVE_SOURCE_RANGE_BYTES,
    maximumSourceBytes = MAX_CURVE_SOURCE_BYTES,
  } = {}) {
    if (
      !Number.isSafeInteger(maximumRangeBytes) ||
      maximumRangeBytes < SPLINE_HEADER_RECORD_SIZE ||
      maximumRangeBytes > MAX_CURVE_SOURCE_RANGE_BYTES
    ) {
      throw new RangeError(
        `curve source range limit must be between ${SPLINE_HEADER_RECORD_SIZE} and ${MAX_CURVE_SOURCE_RANGE_BYTES} bytes`,
      );
    }
    if (
      !Number.isSafeInteger(maximumSourceBytes) ||
      maximumSourceBytes < SPLINE_HEADER_RECORD_SIZE ||
      maximumSourceBytes > MAX_CURVE_SOURCE_BYTES
    ) {
      throw new RangeError(
        `curve source byte budget must be between ${SPLINE_HEADER_RECORD_SIZE} and ${MAX_CURVE_SOURCE_BYTES} bytes`,
      );
    }
    const specifications = [
      [SectionKind.Arcs, "ARC"],
      [SectionKind.Circles, "CIRCLE"],
      [SectionKind.PolylineHeaders, "polyline headers"],
      [SectionKind.PolylineVertices, "polyline vertices"],
      [SectionKind.Ellipses, "ELLIPSE"],
      [SectionKind.SplineHeaders, "SPLINE headers"],
      [SectionKind.SplineKnots, "SPLINE knots"],
      [SectionKind.SplineWeights, "SPLINE weights"],
      [SectionKind.SplineControlPoints, "SPLINE control points"],
      [SectionKind.SplineFitPoints, "SPLINE fit points"],
      ...(this.header.minor >= 23
        ? [
            [SectionKind.CurveLinetypeScales, "curve linetype scales"],
            [SectionKind.ConstructionLines, "construction lines"],
          ]
        : []),
    ].map(([kind, label]) => {
      const section = this.sections.get(kind);
      if (!section) {
        throw new Error(`curve source section ${kind} is missing`);
      }
      return { kind, label, section };
    });
    const byteLength = specifications.reduce(
      (total, { section }) =>
        checkedAdd(total, section.byteLength, "curve source bytes"),
      0,
    );
    if (byteLength > maximumSourceBytes) {
      throw new Error(
        `curve source is ${byteLength} bytes, above the ${maximumSourceBytes}-byte limit`,
      );
    }

    let requestCount = 0;
    let maximumReadBytes = 0;
    const tables = new Map();
    for (const { kind, label, section } of specifications) {
      const recordsPerChunk = Math.max(
        1,
        Math.floor(maximumRangeBytes / section.recordSize),
      );
      const chunks = [];
      for (
        let firstRecord = 0;
        firstRecord < section.recordCount;
        firstRecord += recordsPerChunk
      ) {
        const recordCount = Math.min(
          recordsPerChunk,
          section.recordCount - firstRecord,
        );
        const chunkByteLength = checkedMultiply(
          recordCount,
          section.recordSize,
          `${label} chunk bytes`,
        );
        const offset = checkedAdd(
          section.offset,
          checkedMultiply(
            firstRecord,
            section.recordSize,
            `${label} chunk offset`,
          ),
          `${label} source offset`,
        );
        const buffer = requireArrayBuffer(
          await this.source.read(offset, chunkByteLength),
          chunkByteLength,
          `${label} source chunk`,
        );
        chunks.push(
          Object.freeze({
            firstRecord,
            recordCount,
            buffer,
            view: new DataView(buffer),
          }),
        );
        requestCount += 1;
        maximumReadBytes = Math.max(maximumReadBytes, chunkByteLength);
      }
      const arguments_ = [
        Object.freeze(chunks),
        section.recordSize,
        section.recordCount,
        recordsPerChunk,
      ];
      let table;
      switch (kind) {
        case SectionKind.Arcs:
          table = new CircularCurveSourceTable(...arguments_, "arc");
          break;
        case SectionKind.Circles:
          table = new CircularCurveSourceTable(...arguments_, "circle");
          break;
        case SectionKind.PolylineHeaders:
          table = new PolylineHeaderSourceTable(
            ...arguments_,
            "polyline headers",
          );
          break;
        case SectionKind.PolylineVertices:
          table = new PolylineVertexSourceTable(
            ...arguments_,
            "polyline vertices",
          );
          break;
        case SectionKind.Ellipses:
          table = new EllipseCurveSourceTable(...arguments_, "ELLIPSE");
          break;
        case SectionKind.SplineHeaders:
          table = new SplineHeaderSourceTable(
            ...arguments_,
            "SPLINE headers",
          );
          break;
        case SectionKind.SplineKnots:
        case SectionKind.SplineWeights:
          table = new SplineScalarSourceTable(...arguments_, label);
          break;
        case SectionKind.SplineControlPoints:
        case SectionKind.SplineFitPoints:
          table = new SplinePointSourceTable(...arguments_, label);
          break;
        case SectionKind.CurveLinetypeScales: {
          table = new Map();
          for (const chunk of chunks) {
            for (let index = 0; index < chunk.recordCount; index += 1) {
              const offset = index * section.recordSize;
              const handle = chunk.view.getBigUint64(offset, true);
              const scale = chunk.view.getFloat64(offset + 8, true);
              if (
                handle === 0n ||
                !Number.isFinite(scale) ||
                scale <= 0 ||
                table.has(handle)
              ) {
                throw new Error(
                  `curve linetype scale ${chunk.firstRecord + index} is invalid`,
                );
              }
              table.set(handle, scale);
            }
          }
          table = Object.freeze(table);
          break;
        }
        case SectionKind.ConstructionLines:
          table = new ConstructionLineSourceTable(
            ...arguments_,
            "construction lines",
          );
          for (let index = 0; index < table.length; index += 1) {
            table.readEntity(index, {
              point: [0, 0, 0],
              direction: [0, 0, 0],
            });
          }
          break;
        default:
          throw new Error(`unsupported curve source section ${kind}`);
      }
      tables.set(kind, table);
    }
    const curveLinetypeScales =
      tables.get(SectionKind.CurveLinetypeScales) ?? new Map();
    if (this.header.minor >= 23) {
      const curveTables = [
        tables.get(SectionKind.Arcs),
        tables.get(SectionKind.Circles),
        tables.get(SectionKind.PolylineHeaders),
        tables.get(SectionKind.Ellipses),
        tables.get(SectionKind.SplineHeaders),
      ];
      const constructionLines = tables.get(SectionKind.ConstructionLines);
      const expectedCurveScaleCount = curveTables.reduce(
        (total, table) => total + table.length,
        constructionLines.length,
      );
      const sourceHandles = new Set();
      for (const table of curveTables) {
        for (let index = 0; index < table.length; index += 1) {
          const handle = table.readHandle(index);
          if (
            handle === 0n ||
            sourceHandles.has(handle) ||
            !curveLinetypeScales.has(handle)
          ) {
            throw new Error(
              "curve linetype-scale records do not cover the curve source",
            );
          }
          sourceHandles.add(handle);
        }
      }
      for (let index = 0; index < constructionLines.length; index += 1) {
        const handle = constructionLines.readHandle(index);
        if (
          handle === 0n ||
          sourceHandles.has(handle) ||
          !curveLinetypeScales.has(handle)
        ) {
          throw new Error(
            "curve linetype-scale records do not cover the construction-line source",
          );
        }
        sourceHandles.add(handle);
      }
      if (
        curveLinetypeScales.size !== expectedCurveScaleCount ||
        sourceHandles.size !== expectedCurveScaleCount
      ) {
        throw new Error(
          "curve linetype-scale records do not cover the curve source",
        );
      }
    }
    return Object.freeze({
      arcs: tables.get(SectionKind.Arcs),
      circles: tables.get(SectionKind.Circles),
      polylines: tables.get(SectionKind.PolylineHeaders),
      polylineVertices: tables.get(SectionKind.PolylineVertices),
      ellipses: tables.get(SectionKind.Ellipses),
      splines: tables.get(SectionKind.SplineHeaders),
      splineKnots: tables.get(SectionKind.SplineKnots),
      splineWeights: tables.get(SectionKind.SplineWeights),
      splineControlPoints: tables.get(SectionKind.SplineControlPoints),
      splineFitPoints: tables.get(SectionKind.SplineFitPoints),
      constructionLines: tables.get(SectionKind.ConstructionLines),
      curveLinetypeScales,
      byteLength,
      requestCount,
      maximumReadBytes,
    });
  }

  async readReviewCurves({
    maximumBytes = MAX_REVIEW_CURVE_BYTES,
  } = {}) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new RangeError("review curve byte budget must be positive");
    }
    const curves = new Map();
    let bytesRead = 0;
    let records = 0;
    let truncated = false;
    const specifications = [
      {
        kind: SectionKind.Arcs,
        name: "ARC",
        parse(view, offset) {
          return {
            kind: "arc",
            center: ensureFiniteVector(
              readVec3F64(view, offset + 32),
              "ARC center",
            ),
            radius: view.getFloat64(offset + 56, true),
            startParameter: view.getFloat64(offset + 64, true),
            endParameter: view.getFloat64(offset + 72, true),
            normal: ensureFiniteVector(
              readVec3F64(view, offset + 88),
              "ARC normal",
            ),
          };
        },
      },
      {
        kind: SectionKind.Circles,
        name: "CIRCLE",
        parse(view, offset) {
          return {
            kind: "circle",
            center: ensureFiniteVector(
              readVec3F64(view, offset + 32),
              "CIRCLE center",
            ),
            radius: view.getFloat64(offset + 56, true),
            startParameter: 0,
            endParameter: Math.PI * 2,
            normal: ensureFiniteVector(
              readVec3F64(view, offset + 72),
              "CIRCLE normal",
            ),
          };
        },
      },
      {
        kind: SectionKind.Ellipses,
        name: "ELLIPSE",
        parse(view, offset) {
          return {
            kind: "ellipse",
            center: ensureFiniteVector(
              readVec3F64(view, offset + 32),
              "ELLIPSE center",
            ),
            majorAxis: ensureFiniteVector(
              readVec3F64(view, offset + 56),
              "ELLIPSE major axis",
            ),
            normal: ensureFiniteVector(
              readVec3F64(view, offset + 80),
              "ELLIPSE normal",
            ),
            minorAxisRatio: view.getFloat64(offset + 104, true),
            startParameter: view.getFloat64(offset + 112, true),
            endParameter: view.getFloat64(offset + 120, true),
          };
        },
      },
    ];
    for (const specification of specifications) {
      const section = this.sections.get(specification.kind);
      if (!section || section.recordCount === 0) {
        continue;
      }
      const remaining = maximumBytes - bytesRead;
      const recordCount = Math.min(
        section.recordCount,
        Math.floor(remaining / section.recordSize),
      );
      if (recordCount < section.recordCount) {
        truncated = true;
      }
      if (recordCount === 0) {
        continue;
      }
      const byteLength = checkedMultiply(
        recordCount,
        section.recordSize,
        `${specification.name} review bytes`,
      );
      const buffer = requireArrayBuffer(
        await this.source.read(section.offset, byteLength),
        byteLength,
        `${specification.name} review records`,
      );
      const view = new DataView(buffer);
      for (let index = 0; index < recordCount; index += 1) {
        const offset = index * section.recordSize;
        const handle = view.getBigUint64(offset, true);
        const ownerHandle = view.getBigUint64(offset + 8, true);
        const layerIndex = view.getUint32(offset + 16, true);
        const color = view.getUint32(offset + 20, true);
        const lineWeight = view.getInt16(offset + 24, true);
        const flags = view.getUint16(offset + 26, true);
        const linetypeCode = view.getUint32(offset + 28, true);
        const curve = specification.parse(view, offset);
        const normalLength = Math.hypot(...curve.normal);
        const validCircular =
          curve.kind === "ellipse" ||
          (Number.isFinite(curve.radius) && curve.radius > 0);
        const validEllipse =
          curve.kind !== "ellipse" ||
          (curve.majorAxis.every(Number.isFinite) &&
            Math.hypot(...curve.majorAxis) > 1e-12 &&
            Number.isFinite(curve.minorAxisRatio) &&
            Math.abs(curve.minorAxisRatio) > 1e-12);
        if (
          handle === 0n ||
          layerIndex === 0xffffffff ||
          (flags & ~1) !== 0 ||
          linetypeCode > 2047 ||
          !validCircular ||
          !validEllipse ||
          !Number.isFinite(curve.startParameter) ||
          !Number.isFinite(curve.endParameter) ||
          !Number.isFinite(normalLength) ||
          normalLength <= 1e-12
        ) {
          throw new Error(
            `${specification.name} ${index} has invalid review geometry`,
          );
        }
        if (curves.has(handle)) {
          throw new Error(
            `${specification.name} ${index} duplicates an entity handle`,
          );
        }
        curves.set(
          handle,
          Object.freeze({
            ...curve,
            handle,
            ownerHandle,
            layerIndex,
            color,
            lineWeight,
            linetypeCode,
            invisible: (flags & 1) !== 0,
          }),
        );
      }
      bytesRead += byteLength;
      records += recordCount;
    }
    return Object.freeze({
      curves,
      byteLength: bytesRead,
      records,
      truncated,
    });
  }

  async readGpuLineBatches() {
    return this.memoize("gpu-line-batches", async () => {
      const section = this.getSection(SectionKind.GpuLineBatches);
      const vertices = this.getSection(SectionKind.GpuLineVertices);
      const blocks = this.getSection(SectionKind.Blocks);
      const buffer = await this.readWholeMetadataSection(section);
      const view = new DataView(buffer);
      const batches = new Array(section.recordCount);
      let expectedFirstVertex = 0;
      let detailStarted = false;
      let overviewVertexCount = 0;

      for (let index = 0; index < section.recordCount; index += 1) {
        const offset = index * section.recordSize;
        const id = view.getUint32(offset, true);
        const kind = view.getUint16(offset + 4, true);
        const lodLevel = view.getUint16(offset + 6, true);
        const flags = view.getUint32(offset + 8, true);
        const encodedBlockIndex = view.getUint32(offset + 12, true);
        const firstVertex = readSafeU64(view, offset + 16, "GPU first vertex");
        const vertexCount = readSafeU64(view, offset + 24, "GPU vertex count");
        const segmentCount = view.getUint32(offset + 32, true);
        const origin = ensureFiniteVector(
          readVec3F64(view, offset + 40),
          "GPU batch origin",
        );
        const bounds = {
          min: ensureFiniteVector(
            readVec3F64(view, offset + 64),
            "GPU batch minimum bounds",
          ),
          max: ensureFiniteVector(
            readVec3F64(view, offset + 88),
            "GPU batch maximum bounds",
          ),
        };
        const maximumPositionError = view.getFloat32(offset + 112, true);

        if (id !== index) {
          throw new Error("GPU batch IDs are not sequential");
        }
        if (kind > GpuLineBatchKind.BlockDefinition || lodLevel > 1) {
          throw new Error(`GPU batch ${id} has unsupported metadata`);
        }
        if (detailStarted && lodLevel === 0) {
          throw new Error("GPU overview batches are not a contiguous prefix");
        }
        detailStarted ||= lodLevel === 1;
        if (firstVertex !== expectedFirstVertex) {
          throw new Error("GPU vertex ranges are not contiguous");
        }
        if (vertexCount !== segmentCount * 2) {
          throw new Error(`GPU batch ${id} vertex count does not match segments`);
        }
        expectedFirstVertex = checkedAdd(
          firstVertex,
          vertexCount,
          "GPU vertex range end",
        );
        if (lodLevel === 0) {
          overviewVertexCount = expectedFirstVertex;
        }
        const isBlock = kind === GpuLineBatchKind.BlockDefinition;
        if (
          (isBlock && encodedBlockIndex >= blocks.recordCount) ||
          (!isBlock && encodedBlockIndex !== 0xffffffff)
        ) {
          throw new Error(`GPU batch ${id} has an invalid block reference`);
        }
        if (
          !Number.isFinite(maximumPositionError) ||
          maximumPositionError < 0 ||
          bounds.min.some((value, axis) => value > bounds.max[axis])
        ) {
          throw new Error(`GPU batch ${id} has invalid bounds or precision`);
        }

        batches[index] = Object.freeze({
          id,
          kind,
          lodLevel,
          flags,
          blockIndex: isBlock ? encodedBlockIndex : null,
          firstVertex,
          vertexCount,
          segmentCount,
          origin,
          bounds,
          maximumPositionError,
        });
      }
      if (expectedFirstVertex !== vertices.recordCount) {
        throw new Error("GPU batches do not cover the complete vertex pool");
      }
      Object.defineProperty(batches, "overviewVertexCount", {
        value: overviewVertexCount,
        enumerable: false,
      });
      return Object.freeze(batches);
    });
  }

  async readRenderMetadata() {
    const [
      drawing,
      layers,
      linetypes,
      blocks,
      layouts,
      inserts,
      insertClips,
      batches,
    ] =
      await Promise.all([
        this.readDrawing(),
        this.readLayers(),
        this.readLinetypes(),
        this.readBlocks(),
        this.readLayouts(),
        this.readInserts(),
        this.readInsertClips(),
        this.readGpuLineBatches(),
      ]);
    return Object.freeze({
      drawing,
      layers,
      linetypes,
      blocks,
      layouts,
      inserts,
      insertClips,
      batches,
    });
  }

  async readOverviewVertices({ maximumBytes = MAX_OVERVIEW_BYTES } = {}) {
    const batches = await this.readGpuLineBatches();
    const section = this.getSection(SectionKind.GpuLineVertices);
    const vertexCount = batches.overviewVertexCount;
    const byteLength = checkedMultiply(
      vertexCount,
      section.recordSize,
      "overview vertex bytes",
    );
    if (byteLength > maximumBytes) {
      throw new Error(
        `overview vertex prefix is ${byteLength} bytes, above the ${maximumBytes}-byte limit`,
      );
    }
    const buffer = requireArrayBuffer(
      await this.source.read(section.offset, byteLength),
      byteLength,
      "overview GPU vertices",
    );
    return Object.freeze({
      buffer,
      firstVertex: 0,
      vertexCount,
      byteLength,
      recordSize: section.recordSize,
    });
  }

  async readBatchVertices(
    batch,
    {
      maximumBytes = MAX_DETAIL_BATCH_BYTES,
      signal,
    } = {},
  ) {
    const section = this.getSection(SectionKind.GpuLineVertices);
    const byteLength = checkedMultiply(
      batch.vertexCount,
      section.recordSize,
      "GPU batch vertex bytes",
    );
    if (byteLength > maximumBytes) {
      throw new Error(
        `GPU batch ${batch.id} is ${byteLength} bytes, above the ${maximumBytes}-byte limit`,
      );
    }
    const relativeOffset = checkedMultiply(
      batch.firstVertex,
      section.recordSize,
      "GPU batch vertex offset",
    );
    const offset = checkedAdd(
      section.offset,
      relativeOffset,
      "GPU batch file offset",
    );
    const buffer = requireArrayBuffer(
      await this.source.read(offset, byteLength, { signal }),
      byteLength,
      `GPU batch ${batch.id} vertices`,
    );
    return Object.freeze({
      buffer,
      firstVertex: batch.firstVertex,
      vertexCount: batch.vertexCount,
      byteLength,
      recordSize: section.recordSize,
    });
  }

  async readStringTable(section, expectedRecordSize, parseRecord) {
    if (
      section.recordSize !== expectedRecordSize ||
      section.flags !== STRING_TABLE_FLAG ||
      section.byteLength < STRING_TABLE_HEADER_SIZE
    ) {
      throw new Error(`section ${section.kind} has invalid string-table metadata`);
    }
    const buffer = await this.readWholeMetadataSection(section);
    const view = new DataView(buffer);
    const recordCount = view.getUint32(0, true);
    const recordSize = view.getUint32(4, true);
    const stringOffset = readSafeU64(view, 8, "string-table blob offset");
    const minimumStringOffset =
      STRING_TABLE_HEADER_SIZE + section.recordCount * section.recordSize;
    if (
      recordCount !== section.recordCount ||
      recordSize !== section.recordSize ||
      stringOffset < minimumStringOffset ||
      stringOffset > section.byteLength
    ) {
      throw new Error(`section ${section.kind} string-table header is inconsistent`);
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const readString = (relativeOffset, byteLength) => {
      if (byteLength > MAX_CACHE_STRING_BYTES) {
        throw new Error(`section ${section.kind} contains an oversized string`);
      }
      const start = checkedAdd(
        stringOffset,
        relativeOffset,
        "string-table string offset",
      );
      const end = checkedAdd(start, byteLength, "string-table string end");
      if (start < stringOffset || end > section.byteLength) {
        throw new Error(`section ${section.kind} string points outside its blob`);
      }
      return decoder.decode(new Uint8Array(buffer, start, byteLength));
    };
    const rows = new Array(section.recordCount);
    for (let index = 0; index < section.recordCount; index += 1) {
      const offset = STRING_TABLE_HEADER_SIZE + index * section.recordSize;
      rows[index] = parseRecord(view, offset, readString, index);
    }
    return Object.freeze(rows);
  }

  async readWholeMetadataSection(section) {
    if (section.byteLength > MAX_METADATA_SECTION_BYTES) {
      throw new Error(
        `metadata section ${section.kind} exceeds the ${MAX_METADATA_SECTION_BYTES}-byte limit`,
      );
    }
    return requireArrayBuffer(
      await this.source.read(section.offset, section.byteLength),
      section.byteLength,
      `section ${section.kind}`,
    );
  }

  memoize(key, loader) {
    if (!this.cache.has(key)) {
      this.cache.set(
        key,
        Promise.resolve()
          .then(loader)
          .catch((error) => {
            this.cache.delete(key);
            throw error;
          }),
      );
    }
    return this.cache.get(key);
  }
}

export {
  MAX_CURVE_SOURCE_BYTES,
  MAX_CURVE_SOURCE_RANGE_BYTES,
  MAX_DETAIL_BATCH_BYTES,
  MAX_METADATA_SECTION_BYTES,
  MAX_OVERVIEW_BYTES,
  checkedAdd,
  checkedMultiply,
  readSafeU64,
};
