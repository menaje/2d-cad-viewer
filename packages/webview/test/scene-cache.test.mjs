import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRangeSource,
  TrackedRangeSource,
} from "../src/range-source.mjs";
import {
  ARC_RECORD_SIZE,
  CACHE_VERSION_MINOR,
  DIRECTORY_ENTRY_SIZE,
  ELLIPSE_RECORD_SIZE,
  GPU_LINE_VERTEX_RECORD_SIZE,
  MAX_CURVE_SOURCE_BYTES,
  MAX_CURVE_SOURCE_RANGE_BYTES,
  POLYLINE_HEADER_RECORD_SIZE,
  POLYLINE_VERTEX_RECORD_SIZE,
  SceneCacheReader,
  SectionKind,
  SPLINE_HEADER_RECORD_SIZE,
  SPLINE_POINT_RECORD_SIZE,
  SPLINE_SCALAR_RECORD_SIZE,
  ViewportLayerOverrideFlags,
  ViewportLayerOverrideProperty,
} from "../src/scene-cache.mjs";
import { makeFixtureCache } from "./cache-fixture.mjs";

test("opens the header and directory without reading the full cache", async () => {
  const buffer = makeFixtureCache();
  const source = new TrackedRangeSource(new MemoryRangeSource(buffer));
  const reader = await SceneCacheReader.open(source);

  assert.equal(reader.header.major, 1);
  assert.equal(reader.header.minor, CACHE_VERSION_MINOR);
  assert.equal(reader.header.fileSize, buffer.byteLength);
  assert.equal(reader.header.preview, false);
  assert.equal(reader.sections.size, Object.keys(SectionKind).length);
  assert.deepEqual(source.requests, [
    { offset: 0, length: 64 },
    { offset: 64, length: Object.keys(SectionKind).length * 40 },
  ]);
  assert.ok(source.bytesRead < buffer.byteLength / 2);
});

test("identifies a bounded progressive preview cache", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({ preview: true }),
    ),
  );

  assert.equal(reader.header.preview, true);
});

test("rejects unsupported Scene Cache header flags", async () => {
  const buffer = makeFixtureCache();
  new DataView(buffer).setUint32(24, 2, true);
  await assert.rejects(
    SceneCacheReader.open(new MemoryRangeSource(buffer)),
    /unsupported header flags/u,
  );
});

test("rejects a legacy Scene Cache minor version", async () => {
  await assert.rejects(
    SceneCacheReader.open(
      new MemoryRangeSource(makeFixtureCache({ minorVersion: 14 })),
    ),
    /unsupported scene-cache version 1\.14/u,
  );
});

test("reads bounded exact ARC, CIRCLE, and ELLIPSE review geometry", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(
      makeFixtureCache({ includeReviewCurves: true }),
    ),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const result = await reader.readReviewCurves();

  assert.equal(result.records, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.curves.get(0x501n).kind, "arc");
  assert.equal(result.curves.get(0x501n).ownerHandle, 100n);
  assert.equal(result.curves.get(0x501n).layerIndex, 0);
  assert.equal(result.curves.get(0x501n).color, 0);
  assert.equal(result.curves.get(0x501n).lineWeight, -1);
  assert.equal(result.curves.get(0x501n).linetypeCode, 0);
  assert.deepEqual(result.curves.get(0x501n).center, [0, 0, 0]);
  assert.equal(result.curves.get(0x501n).radius, 10);
  assert.equal(result.curves.get(0x502n).kind, "circle");
  assert.deepEqual(result.curves.get(0x502n).center, [20, 0, 0]);
  assert.equal(result.curves.get(0x503n).kind, "ellipse");
  assert.deepEqual(result.curves.get(0x503n).majorAxis, [8, 0, 0]);
  assert.equal(result.curves.get(0x503n).minorAxisRatio, 0.5);
  assert.equal(source.requests.length - requestsAfterOpen, 3);

  const bounded = await reader.readReviewCurves({
    maximumBytes: 112,
  });
  assert.equal(bounded.records, 1);
  assert.equal(bounded.truncated, true);
});

test("reads deferred curve source only in record-aligned 512 KiB chunks", async () => {
  const arcCount = 5_000;
  const arcBytes = arcCount * ARC_RECORD_SIZE;
  const buffer = new ArrayBuffer(arcBytes);
  const source = new TrackedRangeSource(new MemoryRangeSource(buffer));
  let offset = 0;
  const sections = new Map();
  const addSection = (kind, recordSize, recordCount) => {
    const byteLength = recordSize * recordCount;
    sections.set(kind, {
      kind,
      recordSize,
      recordCount,
      offset,
      byteLength,
      flags: 0,
    });
    offset += byteLength;
  };
  addSection(SectionKind.Arcs, ARC_RECORD_SIZE, arcCount);
  addSection(SectionKind.Circles, 96, 0);
  addSection(
    SectionKind.PolylineHeaders,
    POLYLINE_HEADER_RECORD_SIZE,
    0,
  );
  addSection(
    SectionKind.PolylineVertices,
    POLYLINE_VERTEX_RECORD_SIZE,
    0,
  );
  addSection(SectionKind.Ellipses, ELLIPSE_RECORD_SIZE, 0);
  addSection(
    SectionKind.SplineHeaders,
    SPLINE_HEADER_RECORD_SIZE,
    0,
  );
  addSection(SectionKind.SplineKnots, SPLINE_SCALAR_RECORD_SIZE, 0);
  addSection(SectionKind.SplineWeights, SPLINE_SCALAR_RECORD_SIZE, 0);
  addSection(
    SectionKind.SplineControlPoints,
    SPLINE_POINT_RECORD_SIZE,
    0,
  );
  addSection(
    SectionKind.SplineFitPoints,
    SPLINE_POINT_RECORD_SIZE,
    0,
  );
  const reader = new SceneCacheReader(
    source,
    { minor: CACHE_VERSION_MINOR },
    sections,
  );
  const curves = await reader.readCurveRefinementSource();

  assert.equal(curves.arcs.length, arcCount);
  assert.equal(curves.splineFitPoints.length, 0);
  assert.equal(curves.requestCount, 2);
  assert.ok(curves.maximumReadBytes <= MAX_CURVE_SOURCE_RANGE_BYTES);
  assert.ok(source.maximumRequestBytes <= MAX_CURVE_SOURCE_RANGE_BYTES);
  assert.equal(source.bytesRead, arcBytes);
  await assert.rejects(
    reader.readCurveRefinementSource({
      maximumSourceBytes: MAX_CURVE_SOURCE_BYTES + 1,
    }),
    /byte budget must be between/,
  );
});

test("reads deferred polyline source in independently bounded chunks", async () => {
  const headerCount = 5_000;
  const vertexCount = 9_000;
  const headerBytes = headerCount * POLYLINE_HEADER_RECORD_SIZE;
  const vertexBytes = vertexCount * POLYLINE_VERTEX_RECORD_SIZE;
  const source = new TrackedRangeSource(
    new MemoryRangeSource(new ArrayBuffer(headerBytes + vertexBytes)),
  );
  const sections = new Map([
    [
      SectionKind.PolylineHeaders,
      {
        kind: SectionKind.PolylineHeaders,
        recordSize: POLYLINE_HEADER_RECORD_SIZE,
        recordCount: headerCount,
        offset: 0,
        byteLength: headerBytes,
        flags: 0,
      },
    ],
    [
      SectionKind.PolylineVertices,
      {
        kind: SectionKind.PolylineVertices,
        recordSize: POLYLINE_VERTEX_RECORD_SIZE,
        recordCount: vertexCount,
        offset: headerBytes,
        byteLength: vertexBytes,
        flags: 0,
      },
    ],
  ]);
  const reader = new SceneCacheReader(
    source,
    { minor: CACHE_VERSION_MINOR },
    sections,
  );
  const polylines = await reader.readPolylineSource();

  assert.equal(polylines.polylines.length, headerCount);
  assert.equal(polylines.polylineVertices.length, vertexCount);
  assert.equal(polylines.requestCount, 4);
  assert.ok(polylines.maximumReadBytes <= MAX_CURVE_SOURCE_RANGE_BYTES);
  assert.ok(source.maximumRequestBytes <= MAX_CURVE_SOURCE_RANGE_BYTES);
  assert.equal(source.bytesRead, headerBytes + vertexBytes);
  await assert.rejects(
    reader.readPolylineSource({
      maximumSourceBytes: MAX_CURVE_SOURCE_BYTES + 1,
    }),
    /byte budget must be between/,
  );
});

test("does not read curve source sections while loading first-frame data", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(
      makeFixtureCache({ includeReviewCurves: true }),
    ),
  );
  const reader = await SceneCacheReader.open(source);
  const curveRanges = [
    reader.getSection(SectionKind.Arcs),
    reader.getSection(SectionKind.Circles),
    reader.getSection(SectionKind.Ellipses),
  ].map((section) => [
    section.offset,
    section.offset + section.byteLength,
  ]);

  await reader.readRenderMetadata();
  await reader.readOverviewVertices();

  assert.equal(
    source.requests.some(({ offset, length }) =>
      curveRanges.some(
        ([start, end]) => offset < end && offset + length > start,
      ),
    ),
    false,
  );
});

test("rejects a newer unsupported Scene Cache minor version", async () => {
  await assert.rejects(
    SceneCacheReader.open(
      new MemoryRangeSource(
        makeFixtureCache({ minorVersion: CACHE_VERSION_MINOR + 1 }),
      ),
    ),
    /unsupported scene-cache version 1\.22/,
  );
});

test("reads current drawing display settings", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        minorVersion: CACHE_VERSION_MINOR,
        wipeoutFrame: 2,
        lineWeightDisplay: true,
        fillMode: false,
        modelSpaceActive: false,
      }),
    ),
  );
  const metadata = await reader.readRenderMetadata();

  assert.equal(metadata.drawing.wipeoutFrame, 2);
  assert.equal(metadata.drawing.lineWeightDisplay, true);
  assert.equal(metadata.drawing.fillMode, false);
  assert.equal(metadata.drawing.modelSpaceActive, false);

  const missingWipeoutReader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        wipeoutFrame: null,
        lineWeightDisplay: true,
        fillMode: false,
        modelSpaceActive: false,
      }),
    ),
  );
  const missingWipeoutDrawing = await missingWipeoutReader.readDrawing();
  assert.equal(missingWipeoutDrawing.wipeoutFrame, null);
  assert.equal(missingWipeoutDrawing.lineWeightDisplay, true);
  assert.equal(missingWipeoutDrawing.fillMode, false);
  assert.equal(missingWipeoutDrawing.modelSpaceActive, false);
});

test("reads current linetype definitions and scale", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        minorVersion: CACHE_VERSION_MINOR,
        globalLinetypeScale: 300,
      }),
    ),
  );
  const metadata = await reader.readRenderMetadata();

  assert.equal(metadata.drawing.globalLinetypeScale, 300);
  assert.equal(metadata.drawing.paperSpaceLinetypeScale, true);
  assert.equal(metadata.linetypes.length, 1);
  assert.equal(metadata.linetypes[0].name, "DASHED");
  assert.equal(metadata.linetypes[0].patternLength, 1.5);
  assert.deepEqual(
    metadata.linetypes[0].dashes.map((dash) => dash.length),
    [1, -0.5],
  );
});

test("reads current layouts, viewports and frozen layers", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const metadata = await reader.readRenderMetadata();

  assert.equal(metadata.layouts.length, 2);
  assert.equal(metadata.layouts[0].name, "Model");
  assert.equal(metadata.layouts[0].blockIndex, 0);
  assert.equal(metadata.layouts[1].name, "배치1");
  assert.deepEqual(
    [metadata.layouts[1].paperWidth, metadata.layouts[1].paperHeight],
    [420, 297],
  );
  assert.equal(metadata.layouts[1].viewports.length, 2);
  assert.equal(metadata.layouts[1].viewports[1].id, 2);
  assert.equal(metadata.layouts[1].viewports[1].annotationScale, 100);
  assert.deepEqual(
    metadata.layouts[1].viewports[1].frozenLayerIndices,
    [0],
  );
  assert.deepEqual(
    metadata.layouts[1].viewports[1].clipBoundaryVertices,
    [
      [40, 20, 0],
      [380, 20, 0],
      [360, 277, 0],
      [60, 277, 0],
    ],
  );
});

test("reads sparse viewport layer property overrides", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        viewportLayerOverrides: [
          {
            viewportHandle: 2002,
            layerIndex: 0,
            property: ViewportLayerOverrideProperty.Color,
            value: (3 << 30) | 0x112233,
          },
          {
            viewportHandle: 2002,
            layerIndex: 0,
            property: ViewportLayerOverrideProperty.Transparency,
            value: 39 << 24,
          },
          {
            viewportHandle: 2002,
            layerIndex: 0,
            property: ViewportLayerOverrideProperty.Linetype,
            value: 3,
          },
          {
            viewportHandle: 2002,
            layerIndex: 0,
            property: ViewportLayerOverrideProperty.LineWeight,
            value: 50,
          },
        ],
      }),
    ),
  );

  const layouts = await reader.readLayouts();
  assert.deepEqual(layouts[1].viewports[1].layerOverrides, [
    {
      layerIndex: 0,
      flags:
        ViewportLayerOverrideFlags.Color |
        ViewportLayerOverrideFlags.Transparency |
        ViewportLayerOverrideFlags.Linetype |
        ViewportLayerOverrideFlags.LineWeight,
      color: ((3 << 30) | 0x112233) >>> 0,
      transparency: 39 << 24,
      linetypeCode: 3,
      lineWeight: 50,
    },
  ]);
});

test("rejects duplicate and orphan viewport layer overrides", async () => {
  const duplicateReader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        viewportLayerOverrides: [
          {
            viewportHandle: 2002,
            layerIndex: 0,
            property: ViewportLayerOverrideProperty.LineWeight,
            value: 50,
          },
          {
            viewportHandle: 2002,
            layerIndex: 0,
            property: ViewportLayerOverrideProperty.LineWeight,
            value: 70,
          },
        ],
      }),
    ),
  );
  await assert.rejects(
    duplicateReader.readLayouts(),
    /duplicates a property/u,
  );

  const orphanReader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        viewportLayerOverrides: [
          {
            viewportHandle: 9999,
            layerIndex: 0,
            property: ViewportLayerOverrideProperty.Color,
            value: (3 << 30) | 0x112233,
          },
        ],
      }),
    ),
  );
  await assert.rejects(
    orphanReader.readLayouts(),
    /contains invalid metadata/u,
  );
});

test("rejects a negative viewport annotation scale", async () => {
  const buffer = makeFixtureCache();
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let viewportOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.Viewports) {
      viewportOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(viewportOffset, undefined);
  view.setFloat64(viewportOffset + 16 + 264, -1, true);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(reader.readLayouts(), /viewport 0 contains invalid metadata/);
});

test("reads the current saved model view", async () => {
  const savedModelView = {
    center: [1_903_111.951778639, -372_937.2779705549, 0],
    height: 144_557.98890031595,
    width: 364_416.2807004749,
    twist: 0,
  };
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        minorVersion: CACHE_VERSION_MINOR,
        savedModelView,
      }),
    ),
  );
  const metadata = await reader.readRenderMetadata();

  assert.deepEqual(metadata.drawing.savedModelView, savedModelView);
});

test("reads bounded Scene Cache v1.21 raster image references", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const images = await reader.readImageEntities();

  assert.equal(images.length, 1);
  assert.equal(images.clipVertexCount, 2);
  assert.equal(images.readPath(0), String.raw`.\image\한글 사진.png`);
  assert.equal(images.get(0).displayProperties, 7);
  assert.equal(images.get(0).clippingEnabled, true);
  assert.equal(images.get(0).brightness, 40);
  assert.equal(images.get(0).contrast, 60);
  assert.equal(images.get(0).fade, 10);
  assert.deepEqual(images.get(0).insertionPoint, [100, 200, 0]);
  assert.deepEqual(images.get(0).uVector, [2, 0, 0]);
  assert.deepEqual(images.get(0).vVector, [0, 3, 0]);
  assert.deepEqual(images.get(0).size, [8, 6]);
  assert.deepEqual(images.get(0).clipBoundaryVertices, [
    [1.5, 0.5],
    [6.5, 4.5],
  ]);
  assert.equal(source.requests.length - requestsAfterOpen, 2);
});

test("range-reads bounded embedded OLE bitmap payloads", async () => {
  const payload = new Uint8Array([0x42, 0x4d, 1, 2, 3, 4, 5, 6]);
  const source = new TrackedRangeSource(
    new MemoryRangeSource(
      makeFixtureCache({ embeddedImageBytes: payload }),
    ),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const embedded = await reader.readEmbeddedImages();

  assert.equal(embedded.length, 1);
  assert.deepEqual(embedded.get(0), {
    imageIndex: 0,
    mimeType: "image/bmp",
    payloadOffset: 0,
    payloadLength: payload.byteLength,
    width: 2,
    height: 2,
    sourceBmp: true,
    sourceEmf: false,
  });
  assert.deepEqual(
    new Uint8Array(await embedded.readPayload(0)),
    payload,
  );
  assert.equal(source.requests.length - requestsAfterOpen, 2);
});

test("range-reads bounded embedded OLE EMF payloads", async () => {
  const payload = new Uint8Array(108);
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        embeddedImageBytes: payload,
        embeddedImageMime: 2,
        embeddedImageWidth: 1_835,
        embeddedImageHeight: 949,
      }),
    ),
  );
  const embedded = await reader.readEmbeddedImages();

  assert.deepEqual(embedded.get(0), {
    imageIndex: 0,
    mimeType: "application/x-emf",
    payloadOffset: 0,
    payloadLength: payload.byteLength,
    width: 1_835,
    height: 949,
    sourceBmp: false,
    sourceEmf: true,
  });
  assert.deepEqual(new Uint8Array(await embedded.readPayload(0)), payload);
});

test("rejects an embedded OLE bitmap range outside its byte pool", async () => {
  const buffer = makeFixtureCache({
    embeddedImageBytes: new Uint8Array([0x42, 0x4d, 1, 2]),
  });
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  for (let index = 0; index < sectionCount; index += 1) {
    const directoryOffset = 64 + index * DIRECTORY_ENTRY_SIZE;
    if (
      view.getUint32(directoryOffset, true) ===
      SectionKind.EmbeddedImageRecords
    ) {
      const sectionOffset = Number(
        view.getBigUint64(directoryOffset + 8, true),
      );
      view.setBigUint64(sectionOffset + 16, 5n, true);
      break;
    }
  }
  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(
    reader.readEmbeddedImages(),
    /embedded IMAGE record 0 is invalid/u,
  );
});

test("reads the original XREF path", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const blocks = await reader.readBlocks();

  assert.equal(blocks[0].xrefPath, "");
  assert.equal(blocks[2].xrefPath, String.raw`.\xref\외부도면.dwg`);
});

test("reads bounded INSERT XCLIP metadata", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const clips = await reader.readInsertClips();

  assert.equal(clips.length, 1);
  assert.equal(clips[0].insertHandle, 201n);
  assert.equal(clips[0].rectangular, true);
  assert.equal(clips[0].inverted, false);
  assert.deepEqual(clips[0].vertices, [
    [10, 20, 0],
    [30, 40, 0],
  ]);
});

test("accepts the current HATCH-boundary sections", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );

  assert.equal(reader.header.major, 1);
  assert.equal(reader.header.minor, CACHE_VERSION_MINOR);
});

test("reads bounded HATCH source pools lazily", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const hatches = await reader.readHatchSource();

  assert.equal(reader.header.minor, CACHE_VERSION_MINOR);
  assert.equal(hatches.length, 1);
  assert.equal(hatches.loopCount, 2);
  assert.equal(hatches.vertexCount, 8);
  assert.equal(hatches.gradientColorCount, 2);
  assert.equal(hatches.seedPointCount, 1);
  assert.equal(hatches.get(0).patternName, "SOLID");
  assert.equal(hatches.get(0).gradientName, "LINEAR");
  assert.equal(hatches.get(0).loopCount, 2);

  const loop = hatches.readLoop(1, {});
  assert.equal(loop.firstVertex, 4);
  assert.equal(loop.vertexCount, 4);
  assert.equal(loop.signedArea, -16);
  assert.deepEqual(hatches.readVertex(6, [0, 0, 0]), [7, 7, 0]);
  assert.deepEqual(hatches.readSeedPoint(0, [0, 0]), [1, 1]);
  assert.equal(hatches.readGradientColor(1, {}).value, 1);
  assert.equal(source.requests.length - requestsAfterOpen, 7);
});

test("reads bounded HATCH pattern definitions lazily", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const hatches = await reader.readHatchSource();

  assert.equal(hatches.patternLineCount, 2);
  assert.equal(hatches.patternDashCount, 2);
  assert.equal(hatches.get(0).firstPatternLine, 0);
  assert.equal(hatches.get(0).patternLineCount, 2);
  assert.deepEqual(hatches.readPatternLine(0, {}), {
    index: 0,
    hatchIndex: 0,
    sourceLineIndex: 0,
    angle: 0,
    basePoint: [0, 0],
    offset: [0, 2],
    firstDash: 0,
    dashCount: 2,
  });
  assert.equal(hatches.readPatternDash(0), 3);
  assert.equal(hatches.readPatternDash(1), -1);
  assert.equal(source.requests.length - requestsAfterOpen, 7);
});

test("rejects reserved metadata in a HATCH pattern line", async () => {
  const buffer = makeFixtureCache();
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let patternOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.HatchPatternLines) {
      patternOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(patternOffset, undefined);
  view.setUint32(patternOffset + 68, 1, true);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(reader.readHatchSource(), /invalid metadata/);
});

test("reads bounded POINT and SOLID source lazily", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const primitives = await reader.readPrimitiveSource();

  assert.equal(reader.header.minor, CACHE_VERSION_MINOR);
  assert.equal(primitives.points.length, 1);
  assert.equal(primitives.solids.length, 2);
  assert.equal(primitives.faces.length, 5);
  assert.equal(primitives.polylines.length, 0);
  assert.equal(primitives.polylineVertices.length, 0);
  assert.deepEqual(primitives.points.get(0).location, [11, 2, 0]);
  assert.equal(primitives.points.get(0).displayMode, 66);
  assert.equal(primitives.points.get(0).displaySize, -3);
  assert.equal(primitives.solids.get(0).fillMode, true);
  assert.deepEqual(primitives.solids.get(0).corners[3], [0, 3, 0]);
  assert.equal(primitives.solids.get(1).fillMode, false);
  assert.equal(source.requests.length - requestsAfterOpen, 5);
});

test("reads bounded 3DFACE source lazily", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const primitives = await reader.readPrimitiveSource();

  assert.equal(reader.header.minor, CACHE_VERSION_MINOR);
  assert.equal(primitives.faces.length, 5);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(
      (index) => primitives.faces.get(index).invisibleEdges,
    ),
    [1, 2, 4, 8, 0],
  );
  assert.deepEqual(primitives.faces.get(0).corners[3], [20, 3, 0]);
  assert.deepEqual(
    primitives.faces.get(4).corners[3],
    primitives.faces.get(4).corners[2],
  );
  assert.equal(source.requests.length - requestsAfterOpen, 5);
});

test("reads bounded WIPEOUT source lazily", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const reader = await SceneCacheReader.open(source);
  const wipeoutEntities = reader.getSection(SectionKind.WipeoutEntities);
  const wipeoutClipVertices = reader.getSection(
    SectionKind.WipeoutClipVertices,
  );
  const metadata = await reader.readRenderMetadata();

  assert.equal(metadata.drawing.wipeoutFrame, 1);
  assert.equal(
    source.requests.some(
      (request) =>
        request.offset === wipeoutEntities.offset ||
        request.offset === wipeoutClipVertices.offset,
    ),
    false,
  );

  const requestsBeforePrimitives = source.requests.length;
  const primitives = await reader.readPrimitiveSource();
  assert.equal(primitives.wipeouts.length, 3);
  assert.equal(primitives.wipeouts.clipVertexCount, 9);
  assert.equal(primitives.wipeouts.get(0).clipType, 2);
  assert.equal(primitives.wipeouts.get(0).displayProperties, 5);
  assert.deepEqual(
    primitives.wipeouts.get(0).clipBoundaryVertices,
    [
      [0, 0],
      [2, 0],
      [2, 1],
      [0, 1],
    ],
  );
  assert.equal(primitives.wipeouts.get(1).ownerHandle, 101n);
  assert.deepEqual(primitives.wipeouts.get(1).size, [8, 6]);
  assert.equal(primitives.wipeouts.get(2).clippingEnabled, false);
  assert.equal(source.requests.length - requestsBeforePrimitives, 5);
});

test("rejects invalid metadata in a WIPEOUT record", async () => {
  const buffer = makeFixtureCache();
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let wipeoutOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.WipeoutEntities) {
      wipeoutOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(wipeoutOffset, undefined);
  view.setUint8(wipeoutOffset + 40, 101);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(
    reader.readWipeoutEntities(),
    /invalid metadata/,
  );
});

test("rejects a WIPEOUT source table above its record cap", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        minorVersion: CACHE_VERSION_MINOR,
        wipeoutRecordCount: 65_537,
      }),
    ),
  );

  await assert.rejects(
    reader.readWipeoutEntities(),
    /exceeds the 65536-record limit/,
  );
});

test("reads normalized draw order lazily", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const reader = await SceneCacheReader.open(source);
  const tableSection = reader.getSection(SectionKind.DrawOrderTables);
  const entrySection = reader.getSection(SectionKind.DrawOrderEntries);
  await reader.readRenderMetadata();

  assert.equal(
    source.requests.some(
      (request) =>
        request.offset === tableSection.offset ||
        request.offset === entrySection.offset,
    ),
    false,
  );

  const requestsBeforeDrawOrder = source.requests.length;
  const drawOrder = await reader.readDrawOrder();
  assert.equal(source.requests.length - requestsBeforeDrawOrder, 2);
  assert.equal(drawOrder.length, 2);
  assert.equal(drawOrder.entryCount, 3);
  assert.equal(drawOrder.get(0).ownerHandle, 100n);
  assert.deepEqual(
    drawOrder.get(0).entries.map((entry) => [
      entry.entityHandle,
      entry.sortHandle,
    ]),
    [
      [0x301n, 0x102n],
      [0x302n, 0x101n],
    ],
  );
  assert.equal(drawOrder.readTable(1, {}).firstEntry, 2);
  assert.equal(drawOrder.readEntry(2, {}).entityHandle, 0x401n);
});

test("reads only bounded entity prefixes for the shared display-order index", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const reader = await SceneCacheReader.open(source);
  const kinds = [
    SectionKind.TextEntities,
    SectionKind.HatchEntities,
    SectionKind.PointEntities,
    SectionKind.SolidEntities,
    SectionKind.FaceEntities,
    SectionKind.ImageEntities,
  ];
  const expectedRecords = kinds.reduce(
    (total, kind) => total + reader.getSection(kind).recordCount,
    0,
  );
  const requestsBefore = source.requests.length;

  const identities = await reader.readDisplayOrderIdentities();

  assert.equal(identities.limited, false);
  assert.equal(identities.sourceRecordCount, expectedRecords);
  assert.equal(identities.length, expectedRecords);
  assert.equal(source.requests.length - requestsBefore, kinds.length);
  for (let index = 0; index < identities.length; index += 1) {
    const identity = identities.readEntity(index, {});
    assert.equal(typeof identity.handle, "bigint");
    assert.equal(typeof identity.ownerHandle, "bigint");
  }

  const requestsBeforeLimit = source.requests.length;
  const limited = await reader.readDisplayOrderIdentities({
    maximumRecords: 1,
  });
  assert.equal(limited.limited, true);
  assert.equal(limited.length, 0);
  assert.equal(source.requests.length, requestsBeforeLimit);
});

test("rejects a non-contiguous draw-order range", async () => {
  const buffer = makeFixtureCache();
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let tableOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.DrawOrderTables) {
      tableOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(tableOffset, undefined);
  view.setBigUint64(tableOffset + 16, 1n, true);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(
    reader.readDrawOrder(),
    /invalid metadata/,
  );
});

test("rejects invalid flags in a 3DFACE record", async () => {
  const buffer = makeFixtureCache();
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let faceOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.FaceEntities) {
      faceOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(faceOffset, undefined);
  view.setUint32(faceOffset + 32, 16, true);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(
    reader.readFaceEntities(),
    /invalid flags or reserved metadata/,
  );
});

test("rejects a 3DFACE source table above its record cap", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        minorVersion: CACHE_VERSION_MINOR,
        faceRecordCount: 131_073,
      }),
    ),
  );

  await assert.rejects(
    reader.readFaceEntities(),
    /exceeds the 131072-record limit/,
  );
});

test("rejects reserved metadata in a POINT record", async () => {
  const buffer = makeFixtureCache();
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let pointOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.PointEntities) {
      pointOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(pointOffset, undefined);
  view.setUint32(pointOffset + 108, 1, true);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(
    reader.readPointEntities(),
    /nonzero reserved metadata/,
  );
});

test("rejects invalid flags in a SOLID record", async () => {
  const buffer = makeFixtureCache();
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let solidOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.SolidEntities) {
      solidOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(solidOffset, undefined);
  view.setUint32(solidOffset + 32, 2, true);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(
    reader.readSolidEntities(),
    /invalid flags or reserved metadata/,
  );
});

test("preserves Korean source text, style fonts and MTEXT columns", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const styles = await reader.readTextStyles();
  const texts = await reader.readTextEntities();

  assert.equal(reader.header.minor, CACHE_VERSION_MINOR);
  assert.equal(styles[0].fontFile, "txt.shx");
  assert.equal(styles[0].bigFontFile, "hztxt.shx");
  assert.equal(texts.length, 2);
  assert.equal(texts.get(0).value, "한글");
  assert.equal(texts.get(0).style, styles[0]);
  assert.equal(texts.get(0).lineWeight, -1);
  assert.equal(texts.get(0).linetypeCode, 0);
  assert.equal(texts.get(1).value, "{\\H1.2x;배관}\\P점검");
  assert.deepEqual([...texts.get(1).columnHeights], [10, 11]);
  const displayRecord = {
    insertionPoint: [0, 0, 0],
    normal: [0, 0, 1],
  };
  assert.equal(texts.readDisplayRecord(0, displayRecord), displayRecord);
  assert.equal(displayRecord.valueByteLength, 6);
  assert.equal(displayRecord.style, styles[0]);
  assert.equal(displayRecord.lineWeight, -1);
  assert.equal(displayRecord.linetypeCode, 0);
  assert.equal(texts.readValue(0), "한글");
  assert.equal(texts.readDisplayRecord(1, displayRecord), displayRecord);
  assert.deepEqual(displayRecord.xAxisDirection, [1, 0, 0]);
  assert.equal(displayRecord.flowDirection, 1);
  assert.equal(displayRecord.lineSpacingStyle, 1);
  assert.equal(displayRecord.columnType, 2);
  assert.equal(displayRecord.columnCount, 2);
  assert.equal(displayRecord.columnWidth, 20);
  assert.equal(displayRecord.columnGutter, 2);
  assert.deepEqual(
    [
      ...displayRecord.columnHeightPool.subarray(
        displayRecord.firstColumnHeight,
        displayRecord.firstColumnHeight +
          displayRecord.columnHeightCount,
      ),
    ],
    [10, 11],
  );
  assert.equal(displayRecord.annotationContexts.length, 2);
  assert.equal(displayRecord.annotationContexts[0].scale, 50);
  assert.equal(displayRecord.annotationContexts[0].isDefault, true);
  assert.deepEqual(
    [...displayRecord.annotationContexts[0].columnHeights],
    [10, 11],
  );
  assert.equal(displayRecord.annotationContexts[1].scale, 100);
  assert.equal(displayRecord.annotationContexts[1].flowReversed, true);
  assert.deepEqual(displayRecord.annotationContexts[1].insertionPoint, [
    206,
    402,
    0,
  ]);
  assert.deepEqual(
    [...displayRecord.annotationContexts[1].columnHeights],
    [20, 22],
  );
});

test("rejects an annotation context owned by non-MTEXT text", async () => {
  const buffer = makeFixtureCache();
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let contextOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.TextAnnotationContexts) {
      contextOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(contextOffset, undefined);
  view.setBigUint64(contextOffset, 300n, true);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(
    reader.readTextEntities(),
    /annotation context 0 contains invalid metadata/,
  );
});

test("parses render metadata and reads one contiguous overview prefix", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const reader = await SceneCacheReader.open(source);
  const metadata = await reader.readRenderMetadata();

  assert.equal(metadata.layers[0].name, "0");
  assert.equal(metadata.blocks[1].name, "BLOCK_A");
  assert.deepEqual(metadata.blocks[1].basePoint, [10, 0, 0]);
  assert.equal(metadata.inserts.length, 2);
  assert.equal(metadata.batches.length, 3);
  assert.equal(metadata.batches.overviewVertexCount, 4);

  const beforeOverview = source.snapshot();
  const overview = await reader.readOverviewVertices();
  const vertexSection = reader.getSection(SectionKind.GpuLineVertices);
  assert.equal(
    overview.byteLength,
    4 * GPU_LINE_VERTEX_RECORD_SIZE,
  );
  assert.deepEqual(source.requests.at(-1), {
    offset: vertexSection.offset,
    length: overview.byteLength,
  });
  assert.equal(
    source.bytesRead - beforeOverview.bytesRead,
    overview.byteLength,
  );
});

test("loads a detail batch as an independently bounded range", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const reader = await SceneCacheReader.open(source);
  const batches = await reader.readGpuLineBatches();
  const detail = await reader.readBatchVertices(batches[2]);

  assert.equal(detail.byteLength, 72);
  assert.equal(detail.vertexCount, 2);
  assert.equal(source.requests.at(-1).length, 72);
});

test("rejects cache offsets above JavaScript's exact integer range", async () => {
  const buffer = makeFixtureCache();
  new DataView(buffer).setBigUint64(
    40,
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    true,
  );
  await assert.rejects(
    SceneCacheReader.open(new MemoryRangeSource(buffer)),
    /safe integer limit/,
  );
});

test("rejects an overview that exceeds the caller's memory budget", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  await assert.rejects(
    reader.readOverviewVertices({ maximumBytes: 32 }),
    /above the 32-byte limit/,
  );
});
