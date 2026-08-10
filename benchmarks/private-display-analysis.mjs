#!/usr/bin/env node

import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  GpuLineBatchKind,
  SceneCacheReader,
  TextEntityKind,
} from "../packages/dwg-scene-source/src/scene-cache.mjs";
import { layerLinetypeCodes } from "../packages/webview/src/cad-linetype.mjs";
import { buildInstanceGraph } from "../packages/webview/src/instance-graph.mjs";
import {
  buildLayoutInstanceGraph,
  paperViewportForLayout,
  paperViewportIdentityError,
} from "../packages/webview/src/layout-scene.mjs";
import { plainCadMTextLines } from "../packages/webview/src/mtext-format.mjs";
import {
  calculateOverviewBounds,
  validatedPreferredView,
} from "../packages/webview/src/renderer.mjs";

const REPORT_SCHEMA = "dwg-private-display-analysis/1";
const DISPLAY_ASPECT = 16 / 9;

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = optionValue(argv, index, option);
    index += 1;
    if (option === "--cases") {
      options.casePath = value;
    } else if (option === "--caches") {
      options.cachePath = value;
    } else if (option === "--report") {
      options.reportPath = value;
    } else {
      throw new TypeError(`unknown option: ${option}`);
    }
  }
  for (const key of ["casePath", "cachePath", "reportPath"]) {
    if (!options[key] || !path.isAbsolute(options[key])) {
      throw new TypeError(`${key} must be an absolute path`);
    }
  }
  return Object.freeze(options);
}

class FileRangeSource {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
  }

  static async open(filePath) {
    const [handle, metadata] = await Promise.all([
      open(filePath, "r"),
      stat(filePath),
    ]);
    return new FileRangeSource(handle, metadata.size);
  }

  async read(offset, length) {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size
    ) {
      throw new RangeError("file range is outside the scene cache");
    }
    const bytes = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const result = await this.handle.read(
        bytes,
        read,
        length - read,
        offset + read,
      );
      if (result.bytesRead === 0) {
        throw new Error("scene cache ended inside a requested range");
      }
      read += result.bytesRead;
    }
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  }

  async close() {
    await this.handle.close();
  }
}

function finiteBounds(bounds) {
  return (
    bounds?.min?.length === 3 &&
    bounds?.max?.length === 3 &&
    bounds.min.every(Number.isFinite) &&
    bounds.max.every(Number.isFinite) &&
    bounds.min.every((value, axis) => value <= bounds.max[axis])
  );
}

function viewAssessment(view, bounds) {
  if (!view || !finiteBounds(bounds)) {
    return null;
  }
  const intendedWidth =
    Number.isFinite(view.width) && view.width > 0
      ? view.width
      : view.height * DISPLAY_ASPECT;
  const renderedHeight = Math.max(
    view.height,
    intendedWidth / DISPLAY_ASPECT,
  );
  const renderedWidth = renderedHeight * DISPLAY_ASPECT;
  const rendered = {
    min: [
      view.center[0] - renderedWidth * 0.5,
      view.center[1] - renderedHeight * 0.5,
    ],
    max: [
      view.center[0] + renderedWidth * 0.5,
      view.center[1] + renderedHeight * 0.5,
    ],
  };
  const overlapWidth = Math.max(
    0,
    Math.min(rendered.max[0], bounds.max[0]) -
      Math.max(rendered.min[0], bounds.min[0]),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(rendered.max[1], bounds.max[1]) -
      Math.max(rendered.min[1], bounds.min[1]),
  );
  const geometryWidth = Math.max(bounds.max[0] - bounds.min[0], 1e-12);
  const geometryHeight = Math.max(bounds.max[1] - bounds.min[1], 1e-12);
  const geometryArea = geometryWidth * geometryHeight;
  const geometryCenter = [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
  ];
  const centerDistance = Math.hypot(
    view.center[0] - geometryCenter[0],
    view.center[1] - geometryCenter[1],
  );
  const geometryDiagonal = Math.max(
    Math.hypot(geometryWidth, geometryHeight),
    1e-12,
  );
  const renderedArea = Math.max(
    renderedWidth * renderedHeight,
    1e-24,
  );
  return Object.freeze({
    noOverlap: overlapWidth === 0 || overlapHeight === 0,
    geometryCoverage:
      (overlapWidth * overlapHeight) / geometryArea,
    viewToGeometryArea: renderedArea / geometryArea,
    centerDistanceRatio: centerDistance / geometryDiagonal,
    intendedAspect: intendedWidth / view.height,
    renderedAspect: DISPLAY_ASPECT,
    twist: Number.isFinite(view.twist) ? view.twist : 0,
  });
}

function fittedView(bounds) {
  if (!finiteBounds(bounds)) {
    return null;
  }
  const width = Math.max(bounds.max[0] - bounds.min[0], 1e-6);
  const height = Math.max(bounds.max[1] - bounds.min[1], 1e-6);
  const worldHeight = Math.max(height, width / DISPLAY_ASPECT) * 1.08;
  return Object.freeze({
    center: Object.freeze([
      bounds.min[0] * 0.5 + bounds.max[0] * 0.5,
      bounds.min[1] * 0.5 + bounds.max[1] * 0.5,
      bounds.min[2] * 0.5 + bounds.max[2] * 0.5,
    ]),
    height: worldHeight,
    width: worldHeight * DISPLAY_ASPECT,
    twist: 0,
  });
}

function effectiveView(preferredView, drawableBounds, fitBounds) {
  if (!finiteBounds(drawableBounds)) {
    return Object.freeze({
      preferredViewAccepted: false,
      view: null,
      assessment: null,
      anomalies: Object.freeze([]),
    });
  }
  const preferred = validatedPreferredView(
    preferredView,
    drawableBounds,
    1_600,
    900,
  );
  const view = preferred
    ? Object.freeze({
        center: preferred.origin,
        height: preferred.worldHeight,
        width: preferred.worldHeight * DISPLAY_ASPECT,
        twist: 0,
      })
    : fittedView(finiteBounds(fitBounds) ? fitBounds : drawableBounds);
  const assessment = viewAssessment(view, drawableBounds);
  return Object.freeze({
    preferredViewAccepted: Boolean(preferred),
    view,
    assessment,
    anomalies: viewAnomalies(assessment),
  });
}

function layoutBounds(layout) {
  if (finiteBounds(layout.extents)) {
    return layout.extents;
  }
  const limits = {
    min: [layout.limits.min[0], layout.limits.min[1], 0],
    max: [layout.limits.max[0], layout.limits.max[1], 0],
  };
  return finiteBounds(limits) ? limits : null;
}

function layoutView(layout) {
  const viewport = paperViewportForLayout(layout);
  if (
    !viewport ||
    !viewport.viewCenter?.every(Number.isFinite) ||
    !Number.isFinite(viewport.viewHeight) ||
    viewport.viewHeight <= 0
  ) {
    return null;
  }
  return {
    center: [
      viewport.viewCenter[0],
      viewport.viewCenter[1],
      viewport.center[2] ?? 0,
    ],
    height: viewport.viewHeight,
    width:
      Number.isFinite(viewport.width) && viewport.width > 0
        ? viewport.width
        : viewport.viewHeight,
    twist: Number.isFinite(viewport.viewTwist)
      ? viewport.viewTwist
      : 0,
  };
}

function layoutViewportSelection(layout) {
  const viewport = paperViewportForLayout(layout);
  if (!viewport) {
    return Object.freeze({ mode: "none" });
  }
  const scored = layout.viewports
    .map((candidate, index) => ({
      index,
      error: paperViewportIdentityError(candidate),
    }))
    .filter(({ error }) => Number.isFinite(error))
    .sort((left, right) => left.error - right.error);
  const explicit = layout.viewports.find(
    (candidate) => candidate.id === 1,
  );
  let mode = "first_fallback";
  if (explicit === viewport) {
    mode = "explicit_id";
  } else if (scored.length > 0) {
    mode = "identity_inference";
  } else if (viewport.handle === layout.activeViewportHandle) {
    mode = "active_handle_fallback";
  }
  return Object.freeze({
    mode,
    selectedHandle: String(viewport.handle),
    selectedIndex: layout.viewports.indexOf(viewport),
    selectedIdentityError: paperViewportIdentityError(viewport),
    activeHandleDisagrees:
      viewport.handle !== layout.activeViewportHandle,
    allIdsZero: layout.viewports.every((candidate) => candidate.id === 0),
    ambiguousIdentity:
      scored.length > 1 &&
      Math.abs(scored[1].error - scored[0].error) <= 1e-9,
  });
}

function viewAnomalies(view) {
  if (!view) {
    return Object.freeze([]);
  }
  const output = [];
  if (view.noOverlap) {
    output.push("no_overlap");
  }
  if (view.viewToGeometryArea > 1_000_000) {
    output.push("geometry_tiny_in_view");
  }
  if (view.viewToGeometryArea > 1 && view.geometryCoverage < 0.9) {
    output.push("zoomed_out_partial_view");
  }
  if (view.centerDistanceRatio > 100) {
    output.push("distant_view_center");
  }
  if (Math.abs(view.twist) > 1e-7) {
    output.push("view_twist");
  }
  if (
    view.intendedAspect / view.renderedAspect > 2 ||
    view.renderedAspect / view.intendedAspect > 2
  ) {
    output.push("view_aspect_mismatch");
  }
  return Object.freeze(output);
}

function addCount(target, key, count = 1) {
  target[key] = (target[key] ?? 0) + count;
}

function analyzeText(table) {
  const result = {
    entities: table.length,
    mtextEntities: 0,
    literalNewlineEntities: 0,
    paragraphMarkerEntities: 0,
    uppercaseParagraphBreakEntities: 0,
    paragraphFormatEntities: 0,
    caretBreakEntities: 0,
    parsedMultilineEntities: 0,
    unparsedLineBreakEntities: 0,
    commands: {},
  };
  const record = {};
  for (let index = 0; index < table.length; index += 1) {
    table.readDisplayRecord(index, record);
    if (record.kind !== TextEntityKind.MText) {
      continue;
    }
    result.mtextEntities += 1;
    const value = table.readValue(index);
    const literalNewline = /\r|\n/u.test(value);
    const uppercaseParagraphBreak = /\\P/u.test(value);
    const paragraphFormat = /\\p[^;]{0,512};/u.test(value);
    const caretBreak = /\^J/u.test(value);
    if (literalNewline) {
      result.literalNewlineEntities += 1;
    }
    if (/\\[Pp]/u.test(value)) {
      result.paragraphMarkerEntities += 1;
    }
    if (uppercaseParagraphBreak) {
      result.uppercaseParagraphBreakEntities += 1;
    }
    if (paragraphFormat) {
      result.paragraphFormatEntities += 1;
    }
    if (caretBreak) {
      result.caretBreakEntities += 1;
    }
    const parsedLines = plainCadMTextLines(value, {
      baseHeight: record.height,
    });
    if (parsedLines.length > 1) {
      result.parsedMultilineEntities += 1;
    }
    if (
      (literalNewline || uppercaseParagraphBreak || caretBreak) &&
      parsedLines.length <= 1
    ) {
      result.unparsedLineBreakEntities += 1;
    }
    for (const match of value.matchAll(/\\([A-Za-z~{}\\])/gu)) {
      addCount(result.commands, match[1]);
    }
  }
  return Object.freeze(result);
}

function ownerOccurrences(
  ownerHandle,
  blocks,
  instanceGraph,
  blockIndexByHandle,
) {
  const blockIndex = blockIndexByHandle.get(ownerHandle);
  if (blockIndex === undefined) {
    return ownerHandle === 0n
      ? (instanceGraph.modelInstances?.count ?? 1)
      : 0;
  }
  if (instanceGraph.modelBlockIndices.has(blockIndex)) {
    return instanceGraph.modelInstances?.count ?? 1;
  }
  if (blocks[blockIndex]?.name.toUpperCase().startsWith("*PAPER_SPACE")) {
    return 0;
  }
  return instanceGraph.instancesByBlock.get(blockIndex)?.count ?? 0;
}

function countOwnedSource(
  source,
  blocks,
  instanceGraph,
  blockIndexByHandle,
) {
  let records = 0;
  let occurrences = 0;
  const record = {};
  for (let index = 0; index < source.length; index += 1) {
    source.readEntity(index, record);
    if ((record.commonFlags & 1) !== 0) {
      continue;
    }
    const count = ownerOccurrences(
      record.ownerHandle,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (count === 0) {
      continue;
    }
    records += 1;
    occurrences += count;
  }
  return Object.freeze({ records, occurrences });
}

function analyzeViewContent(
  metadata,
  instanceGraph,
  {
    textEntities,
    hatchSource,
    pointEntities,
    solidEntities,
    faceEntities,
    wipeoutEntities,
    imageEntities,
  },
) {
  let lineBatches = 0;
  let lineSegments = 0;
  let lineOccurrences = 0;
  for (const batch of metadata.batches) {
    if (batch.lodLevel !== 0) {
      break;
    }
    const instances =
      batch.kind === GpuLineBatchKind.BlockDefinition
        ? instanceGraph.instancesByBlock.get(batch.blockIndex)
        : instanceGraph.modelInstances;
    const count = instances?.count ?? 0;
    if (count === 0 || batch.segmentCount === 0) {
      continue;
    }
    lineBatches += 1;
    lineSegments += batch.segmentCount;
    lineOccurrences += batch.segmentCount * count;
  }
  const blockIndexByHandle = new Map(
    metadata.blocks.map((block, index) => [block.handle, index]),
  );
  const textRecord = {};
  let textRecords = 0;
  let textOccurrences = 0;
  for (let index = 0; index < textEntities.length; index += 1) {
    textEntities.readDisplayRecord(index, textRecord);
    if ((textRecord.commonFlags & 1) !== 0) {
      continue;
    }
    const count = ownerOccurrences(
      textRecord.ownerHandle,
      metadata.blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (count === 0) {
      continue;
    }
    textRecords += 1;
    textOccurrences += count;
  }
  const hatchRecord = {};
  let hatchRecords = 0;
  let hatchOccurrences = 0;
  for (let index = 0; index < hatchSource.length; index += 1) {
    hatchSource.readEntity(index, hatchRecord);
    if ((hatchRecord.commonFlags & 1) !== 0 || hatchRecord.loopCount === 0) {
      continue;
    }
    const count = ownerOccurrences(
      hatchRecord.ownerHandle,
      metadata.blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (count === 0) {
      continue;
    }
    hatchRecords += 1;
    hatchOccurrences += count;
  }
  const primitives = Object.freeze({
    points: countOwnedSource(
      pointEntities,
      metadata.blocks,
      instanceGraph,
      blockIndexByHandle,
    ),
    solids: countOwnedSource(
      solidEntities,
      metadata.blocks,
      instanceGraph,
      blockIndexByHandle,
    ),
    faces: countOwnedSource(
      faceEntities,
      metadata.blocks,
      instanceGraph,
      blockIndexByHandle,
    ),
    wipeouts: countOwnedSource(
      wipeoutEntities,
      metadata.blocks,
      instanceGraph,
      blockIndexByHandle,
    ),
    images: countOwnedSource(
      imageEntities,
      metadata.blocks,
      instanceGraph,
      blockIndexByHandle,
    ),
  });
  const xrefs = metadata.blocks
    .map((block, blockIndex) => ({
      blockIndex,
      name: block.name,
      path: block.xrefPath,
      occurrences:
        instanceGraph.instancesByBlock.get(blockIndex)?.count ?? 0,
    }))
    .filter(
      (entry) =>
        entry.path &&
        entry.occurrences > 0 &&
        (metadata.blocks[entry.blockIndex].flags & (1 << 2)) !== 0,
    );
  const drawableRecords =
    lineBatches +
    textRecords +
    hatchRecords +
    Object.values(primitives).reduce(
      (total, entry) => total + entry.records,
      0,
    );
  return Object.freeze({
    drawableRecords,
    lineBatches,
    lineSegments,
    lineOccurrences,
    textRecords,
    textOccurrences,
    hatchRecords,
    hatchOccurrences,
    primitives,
    xrefs,
  });
}

function modelLayout(metadata) {
  return (
    metadata.layouts.find(
      (layout) =>
        metadata.blocks[layout.blockIndex]?.name.toUpperCase() ===
        "*MODEL_SPACE",
    ) ?? null
  );
}

function analyzeEmbeddedImages(imageEntities, embeddedImages) {
  let placements = 0;
  for (let index = 0; index < imageEntities.length; index += 1) {
    if (imageEntities.readPath(index).startsWith("@embedded/ole-")) {
      placements += 1;
    }
  }
  const records = embeddedImages.records ?? [];
  const bmp = records.filter(
    (record) => record.mimeType === "image/bmp",
  ).length;
  const emf = records.filter(
    (record) => record.mimeType === "application/x-emf",
  ).length;
  return Object.freeze({
    placements,
    available: embeddedImages.length,
    unavailable: Math.max(0, placements - embeddedImages.length),
    bmp,
    emf,
    bytes: records.reduce(
      (total, record) => total + record.payloadLength,
      0,
    ),
  });
}

async function analyzeCase(cachePath, privateCase) {
  const source = await FileRangeSource.open(cachePath);
  try {
    const reader = await SceneCacheReader.open(source);
    const metadata = await reader.readRenderMetadata();
    const layerCodes = layerLinetypeCodes(
      metadata.layers,
      metadata.linetypes,
    );
    const common = {
      layers: metadata.layers,
      insertClips: metadata.insertClips,
      layerLinetypeCodes: layerCodes,
      paperSpaceLinetypeScale:
        metadata.drawing.paperSpaceLinetypeScale,
    };
    const [
      textEntities,
      hatchSource,
      pointEntities,
      solidEntities,
      faceEntities,
      wipeoutEntities,
      imageEntities,
      embeddedImages,
    ] = await Promise.all([
      reader.readTextEntities(),
      reader.readHatchSource(),
      reader.readPointEntities(),
      reader.readSolidEntities(),
      reader.readFaceEntities(),
      reader.readWipeoutEntities(),
      reader.readImageEntities(),
      reader.readEmbeddedImages(),
    ]);
    const sources = {
      textEntities,
      hatchSource,
      pointEntities,
      solidEntities,
      faceEntities,
      wipeoutEntities,
      imageEntities,
    };
    const graph = buildInstanceGraph(
      metadata.blocks,
      metadata.inserts,
      common,
    );
    const modelBounds = calculateOverviewBounds(metadata.batches, graph);
    const modelView = viewAssessment(
      metadata.drawing.savedModelView,
      modelBounds,
    );
    const effectiveModelView = effectiveView(
      metadata.drawing.savedModelView,
      modelBounds,
      modelBounds,
    );
    const baseModelLayout = modelLayout(metadata);
    const layouts = [];
    for (const layout of metadata.layouts) {
      if (layout === baseModelLayout) {
        continue;
      }
      const layoutGraph = buildLayoutInstanceGraph(
        metadata.blocks,
        metadata.inserts,
        metadata.layers,
        layout,
        common,
      );
      const actualBounds = calculateOverviewBounds(
        metadata.batches,
        layoutGraph,
      );
      const preferredBounds = layoutBounds(layout);
      const preferredView = layoutView(layout);
      const assessment = viewAssessment(preferredView, actualBounds);
      const effective = effectiveView(
        preferredView,
        actualBounds,
        preferredBounds,
      );
      layouts.push({
        index: layout.index,
        tabOrder: layout.tabOrder,
        viewportSelection: layoutViewportSelection(layout),
        actualBounds: finiteBounds(actualBounds) ? actualBounds : null,
        preferredBounds,
        preferredView,
        assessment,
        anomalies: viewAnomalies(assessment),
        effective,
        content: analyzeViewContent(metadata, layoutGraph, sources),
      });
    }
    const text = analyzeText(textEntities);
    const activeKind =
      metadata.drawing.modelSpaceActive || layouts.length === 0
        ? "model"
        : "layout";
    return Object.freeze({
      id: privateCase.id,
      relativePath: privateCase.relativePath,
      cacheBytes: source.size,
      activeKind,
      model: {
        actualBounds: finiteBounds(modelBounds) ? modelBounds : null,
        preferredView: metadata.drawing.savedModelView,
        assessment: modelView,
        anomalies: viewAnomalies(modelView),
        effective: effectiveModelView,
        content: analyzeViewContent(metadata, graph, sources),
      },
      layouts,
      text,
      embeddedImages: analyzeEmbeddedImages(
        imageEntities,
        embeddedImages,
      ),
    });
  } finally {
    await source.close();
  }
}

async function loadCases(casePath) {
  const entries = await readdir(casePath, { withFileTypes: true });
  const cases = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const value = JSON.parse(
      await readFile(path.join(casePath, entry.name), "utf8"),
    );
    cases.set(value.id, value);
  }
  return cases;
}

function summarize(cases) {
  const summary = {
    drawings: cases.length,
    activeModel: 0,
    activeLayout: 0,
    modelAnomalies: {},
    layoutAnomalies: {},
    effectiveModelAnomalies: {},
    effectiveLayoutAnomalies: {},
    layoutViewportSelection: {},
    layoutsWithAmbiguousViewportIdentity: 0,
    drawingsWithModelAnomalies: 0,
    drawingsWithLayoutAnomalies: 0,
    drawingsWithEffectiveModelAnomalies: 0,
    drawingsWithEffectiveLayoutAnomalies: 0,
    activeViewsWithoutDrawableContent: 0,
    text: {
      entities: 0,
      mtextEntities: 0,
      literalNewlineEntities: 0,
      paragraphMarkerEntities: 0,
      uppercaseParagraphBreakEntities: 0,
      paragraphFormatEntities: 0,
      caretBreakEntities: 0,
      parsedMultilineEntities: 0,
      unparsedLineBreakEntities: 0,
      commands: {},
    },
    embeddedImages: {
      placements: 0,
      available: 0,
      unavailable: 0,
      bmp: 0,
      emf: 0,
      bytes: 0,
    },
  };
  for (const result of cases) {
    addCount(summary, result.activeKind === "model" ? "activeModel" : "activeLayout");
    if (result.model.anomalies.length > 0) {
      summary.drawingsWithModelAnomalies += 1;
      for (const anomaly of result.model.anomalies) {
        addCount(summary.modelAnomalies, anomaly);
      }
    }
    if (result.model.effective.anomalies.length > 0) {
      summary.drawingsWithEffectiveModelAnomalies += 1;
      for (const anomaly of result.model.effective.anomalies) {
        addCount(summary.effectiveModelAnomalies, anomaly);
      }
    }
    if (result.layouts.some((layout) => layout.anomalies.length > 0)) {
      summary.drawingsWithLayoutAnomalies += 1;
    }
    if (
      result.layouts.some(
        (layout) => layout.effective.anomalies.length > 0,
      )
    ) {
      summary.drawingsWithEffectiveLayoutAnomalies += 1;
    }
    const activeView =
      result.activeKind === "model" ? result.model : result.layouts[0];
    if (!activeView || activeView.content.drawableRecords === 0) {
      summary.activeViewsWithoutDrawableContent += 1;
    }
    for (const layout of result.layouts) {
      addCount(
        summary.layoutViewportSelection,
        layout.viewportSelection.mode,
      );
      if (layout.viewportSelection.ambiguousIdentity) {
        summary.layoutsWithAmbiguousViewportIdentity += 1;
      }
      for (const anomaly of layout.anomalies) {
        addCount(summary.layoutAnomalies, anomaly);
      }
      for (const anomaly of layout.effective.anomalies) {
        addCount(summary.effectiveLayoutAnomalies, anomaly);
      }
    }
    for (const key of [
      "entities",
      "mtextEntities",
      "literalNewlineEntities",
      "paragraphMarkerEntities",
      "uppercaseParagraphBreakEntities",
      "paragraphFormatEntities",
      "caretBreakEntities",
      "parsedMultilineEntities",
      "unparsedLineBreakEntities",
    ]) {
      summary.text[key] += result.text[key];
    }
    for (const [command, count] of Object.entries(result.text.commands)) {
      addCount(summary.text.commands, command, count);
    }
    for (const key of [
      "placements",
      "available",
      "unavailable",
      "bmp",
      "emf",
      "bytes",
    ]) {
      summary.embeddedImages[key] += result.embeddedImages[key];
    }
  }
  return Object.freeze(summary);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const privateCases = await loadCases(options.casePath);
  const cacheEntries = (await readdir(options.cachePath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".cache"))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const results = [];
  for (let index = 0; index < cacheEntries.length; index += 1) {
    const entry = cacheEntries[index];
    const id = entry.name.slice(0, -".cache".length);
    const privateCase = privateCases.get(id);
    if (!privateCase) {
      throw new Error(`missing private case metadata for ${id}`);
    }
    process.stderr.write(`[${index + 1}/${cacheEntries.length}] ${id}\n`);
    results.push(
      await analyzeCase(path.join(options.cachePath, entry.name), privateCase),
    );
  }
  const report = Object.freeze({
    schema: REPORT_SCHEMA,
    private: true,
    summary: summarize(results),
    cases: results,
  });
  await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
