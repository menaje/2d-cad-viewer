import {
  decodeCadColor,
  decodeCadOpacity,
  DEFAULT_ACI_PALETTE,
} from "./cad-color.mjs";
import { layerLinetypeCodes } from "./cad-linetype.mjs";
import { transformPoint } from "./math.mjs";
import { GpuLineBatchKind } from "./scene-cache.mjs";
import { systemFallbackFont } from "./text-overlay.mjs";
import { maskBucketFor } from "./mask-order.mjs";
import {
  drawOrderSurfaceFor,
  resizeDrawOrderSurface,
} from "./draw-order-overlay.mjs";
import {
  viewportLayerColor,
  viewportLayerLinetype,
  viewportStyleRow,
} from "./viewport-layer-state.mjs";

const VERTEX_STRIDE = 36;
const NO_LAYER_OVERRIDE = 0xffffffff;
const DEFAULT_MAXIMUM_SOURCE_SEGMENTS = 65_536;
const DEFAULT_MAXIMUM_SYMBOLS = 20_000;
const DEFAULT_MAXIMUM_GLYPH_SEGMENTS = 200_000;
const DEFAULT_MINIMUM_PIXEL_HEIGHT = 1.5;
const MAXIMUM_TEXT_CODE_POINTS = 128;
const IDENTITY_INSTANCES = Object.freeze({
  data: new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]),
  colors: new Uint32Array([(2 << 30) | 7]),
  layerIndices: new Uint32Array([NO_LAYER_OVERRIDE]),
  opacities: new Float32Array([1]),
  linetypeCodes: new Uint16Array([2]),
  visibilityRows: new Uint32Array([0]),
  clipIds: new Uint32Array([0]),
  count: 1,
});

function definitionMap(linetypes) {
  return new Map(
    (linetypes ?? [])
      .filter(
        (definition) =>
          Number.isInteger(definition?.code) &&
          (definition.flags & 1) !== 0,
      )
      .map((definition) => [definition.code, definition]),
  );
}

function sourceLinetypeCode(style) {
  return (style >>> 5) & 0x7ff;
}

function canResolveComplex(
  code,
  layerIndex,
  definitions,
  layerCodes,
  layerLinetypeRows,
) {
  if (code === 0) {
    return (
      definitions.has(layerCodes[layerIndex]) ||
      layerLinetypeRows?.some((row) =>
        definitions.has(row?.[layerIndex]),
      )
    );
  }
  return code === 1 || definitions.has(code);
}

export function collectComplexLinetypeSegments({
  vertices,
  batches,
  linetypes,
  layers,
  layerLinetypeRows = null,
  maximumSegments = DEFAULT_MAXIMUM_SOURCE_SEGMENTS,
}) {
  if (
    !vertices ||
    !(vertices.buffer instanceof ArrayBuffer) ||
    vertices.buffer.byteLength !== vertices.byteLength ||
    vertices.recordSize !== VERTEX_STRIDE ||
    !Number.isSafeInteger(maximumSegments) ||
    maximumSegments <= 0
  ) {
    throw new TypeError("complex linetype source is invalid");
  }
  const definitions = definitionMap(linetypes);
  if (definitions.size === 0 || vertices.byteLength === 0) {
    return Object.freeze({
      groups: Object.freeze([]),
      sourceSegments: 0,
      truncated: false,
    });
  }
  const layerCodes = layerLinetypeCodes(layers, linetypes);
  const view = new DataView(vertices.buffer);
  const groups = [];
  let sourceSegments = 0;
  let truncated = false;
  for (const batch of batches ?? []) {
    if (batch.lodLevel !== 0) {
      continue;
    }
    const firstByte = batch.firstVertex * VERTEX_STRIDE;
    const endByte = firstByte + batch.vertexCount * VERTEX_STRIDE;
    if (
      firstByte < 0 ||
      endByte > vertices.byteLength ||
      batch.vertexCount % 2 !== 0
    ) {
      throw new RangeError(
        `complex linetype batch ${batch.id} exceeds the overview buffer`,
      );
    }
    const segments = [];
    for (
      let offset = firstByte;
      offset < endByte;
      offset += VERTEX_STRIDE * 2
    ) {
      const endOffset = offset + VERTEX_STRIDE;
      const startStyle = view.getUint32(offset + 28, true);
      const endStyle = view.getUint32(endOffset + 28, true);
      const layerIndex = view.getUint32(offset + 12, true);
      const code = sourceLinetypeCode(startStyle);
      if (
        startStyle !== endStyle ||
        (startStyle & (1 << 16)) !== 0 ||
        layerIndex >= layers.length ||
        !canResolveComplex(
          code,
          layerIndex,
          definitions,
          layerCodes,
          layerLinetypeRows,
        )
      ) {
        continue;
      }
      if (sourceSegments >= maximumSegments) {
        truncated = true;
        break;
      }
      const start = [
        batch.origin[0] + view.getFloat32(offset, true),
        batch.origin[1] + view.getFloat32(offset + 4, true),
        batch.origin[2] + view.getFloat32(offset + 8, true),
      ];
      const end = [
        batch.origin[0] + view.getFloat32(endOffset, true),
        batch.origin[1] + view.getFloat32(endOffset + 4, true),
        batch.origin[2] + view.getFloat32(endOffset + 8, true),
      ];
      const storedPatternStart = view.getFloat32(offset + 32, true);
      const storedPatternEnd = view.getFloat32(endOffset + 32, true);
      const patternStart =
        storedPatternStart < 0
          ? -storedPatternStart - 1
          : storedPatternStart;
      const patternEnd =
        storedPatternEnd < 0
          ? -storedPatternEnd - 1
          : storedPatternEnd;
      if (
        ![...start, ...end, patternStart, patternEnd].every(
          Number.isFinite,
        ) ||
        patternEnd - patternStart <= 1e-9
      ) {
        continue;
      }
      segments.push(
        Object.freeze({
          start: Object.freeze(start),
          end: Object.freeze(end),
          patternStart,
          patternEnd,
          layerIndex,
          color: view.getUint32(offset + 16, true),
          linetypeCode: code,
          handle:
            BigInt(view.getUint32(offset + 20, true)) |
            (BigInt(view.getUint32(offset + 24, true)) << 32n),
        }),
      );
      sourceSegments += 1;
    }
    if (segments.length > 0) {
      groups.push(
        Object.freeze({
          batch,
          segments: Object.freeze(segments),
        }),
      );
    }
    if (truncated) {
      break;
    }
  }
  return Object.freeze({
    groups: Object.freeze(groups),
    sourceSegments,
    truncated,
  });
}

function instancesForBatch(batch, instanceGraph) {
  if (batch.kind !== GpuLineBatchKind.BlockDefinition) {
    return instanceGraph.modelInstances ?? IDENTITY_INSTANCES;
  }
  return (
    instanceGraph.instancesByBlock?.get(batch.blockIndex) ??
    Object.freeze({ data: new Float64Array(0), count: 0 })
  );
}

function resolvedLayerIndex(
  sourceLayerIndex,
  instances,
  instanceIndex,
  layerZeroIndex,
) {
  const inherited = instances.layerIndices?.[instanceIndex];
  return sourceLayerIndex === layerZeroIndex &&
    inherited !== undefined &&
    inherited !== NO_LAYER_OVERRIDE
    ? inherited
    : sourceLayerIndex;
}

function pointInPolygon(point, vertices) {
  let inside = false;
  let previous = vertices.at(-1);
  for (const current of vertices) {
    if (
      (current[1] > point[1]) !== (previous[1] > point[1]) &&
      point[0] <
        ((previous[0] - current[0]) * (point[1] - current[1])) /
            (previous[1] - current[1]) +
          current[0]
    ) {
      inside = !inside;
    }
    previous = current;
  }
  return inside;
}

function visibleInsideClip(instanceGraph, clipId, point) {
  let current = clipId;
  let depth = 0;
  while (current > 0 && depth < 64) {
    const node = instanceGraph.clipNodes?.[current - 1];
    if (!node || node.id !== current || node.points.length < 3) {
      return false;
    }
    const inside = pointInPolygon(point, node.points);
    if ((!node.inverted && !inside) || (node.inverted && inside)) {
      return false;
    }
    current = node.parentId;
    depth += 1;
  }
  return current === 0;
}

function worldToScreen(point, camera, width, height) {
  return [
    ((point[0] - camera.origin[0]) / camera.worldWidth + 0.5) * width,
    (0.5 - (point[1] - camera.origin[1]) / camera.worldHeight) * height,
  ];
}

function instanceIntersectsCamera(batch, matrix, matrixOffset, camera) {
  const minimum = batch.bounds.min;
  const maximum = batch.bounds.max;
  const viewportMinimumX = camera.origin[0] - camera.worldWidth * 0.5;
  const viewportMaximumX = camera.origin[0] + camera.worldWidth * 0.5;
  const viewportMinimumY = camera.origin[1] - camera.worldHeight * 0.5;
  const viewportMaximumY = camera.origin[1] + camera.worldHeight * 0.5;
  let minimumX = Infinity;
  let minimumY = Infinity;
  let maximumX = -Infinity;
  let maximumY = -Infinity;
  for (const point of [
    [minimum[0], minimum[1], minimum[2]],
    [maximum[0], minimum[1], minimum[2]],
    [maximum[0], maximum[1], maximum[2]],
    [minimum[0], maximum[1], maximum[2]],
  ]) {
    const transformed = transformPoint(matrix, point, matrixOffset);
    minimumX = Math.min(minimumX, transformed[0]);
    minimumY = Math.min(minimumY, transformed[1]);
    maximumX = Math.max(maximumX, transformed[0]);
    maximumY = Math.max(maximumY, transformed[1]);
  }
  return !(
    maximumX < viewportMinimumX ||
    minimumX > viewportMaximumX ||
    maximumY < viewportMinimumY ||
    minimumY > viewportMaximumY
  );
}

function normalizedReadableAngle(angle) {
  let output = angle;
  while (output > Math.PI) output -= Math.PI * 2;
  while (output < -Math.PI) output += Math.PI * 2;
  if (output > Math.PI * 0.5) output -= Math.PI;
  if (output < -Math.PI * 0.5) output += Math.PI;
  return output;
}

function symbolAngle(dash, lineAngle) {
  if (dash.flags & 1) {
    return -dash.rotation;
  }
  const relative = lineAngle - dash.rotation;
  return dash.flags & 8
    ? normalizedReadableAngle(relative)
    : relative;
}

function complexDashPhases(definition, globalScale) {
  let cursor = 0;
  const output = [];
  for (const dash of definition.dashes ?? []) {
    if (dash.flags & 6) {
      output.push({
        dash,
        phase: cursor * globalScale,
      });
    }
    cursor += Math.abs(dash.length);
  }
  return output;
}

function rgba(color, opacity) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${opacity})`;
}

function drawVectorGlyph(
  context,
  glyph,
  x,
  y,
  angle,
  scale,
  widthFactor,
) {
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.scale(scale * widthFactor, -scale);
  context.lineWidth = 1 / Math.max(scale, 1e-6);
  context.beginPath();
  for (let offset = 0; offset < glyph.vertices.length; offset += 4) {
    context.moveTo(glyph.vertices[offset], glyph.vertices[offset + 1]);
    context.lineTo(glyph.vertices[offset + 2], glyph.vertices[offset + 3]);
  }
  context.stroke();
  context.restore();
  return glyph.segmentCount;
}

function drawTextSymbol(
  context,
  glyphCache,
  style,
  text,
  x,
  y,
  angle,
  scale,
  maximumSegments,
) {
  const characters = [...text].slice(0, MAXIMUM_TEXT_CODE_POINTS);
  const glyphs = characters.map((character) =>
    glyphCache.getGlyph(style, character.codePointAt(0)),
  );
  const widthFactor =
    Number.isFinite(style?.widthFactor) && style.widthFactor !== 0
      ? style.widthFactor
      : 1;
  if (glyphs.every(Boolean)) {
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    context.scale(scale * widthFactor, -scale);
    context.lineWidth = 1 / Math.max(scale, 1e-6);
    context.beginPath();
    let cursor = 0;
    let segments = 0;
    for (const glyph of glyphs) {
      if (segments + glyph.segmentCount > maximumSegments) {
        context.restore();
        return { segments, truncated: true, fallbackGlyphs: 0 };
      }
      for (let offset = 0; offset < glyph.vertices.length; offset += 4) {
        context.moveTo(
          cursor + glyph.vertices[offset],
          glyph.vertices[offset + 1],
        );
        context.lineTo(
          cursor + glyph.vertices[offset + 2],
          glyph.vertices[offset + 3],
        );
      }
      cursor += glyph.advance;
      segments += glyph.segmentCount;
    }
    context.stroke();
    context.restore();
    return { segments, truncated: false, fallbackGlyphs: 0 };
  }
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.scale(scale * widthFactor, scale);
  context.font = systemFallbackFont(style);
  context.textBaseline = "alphabetic";
  context.fillText(characters.join(""), 0, 0);
  context.restore();
  return {
    segments: 0,
    truncated: false,
    fallbackGlyphs: characters.length,
  };
}

export class ComplexLinetypeOverlay {
  constructor(
    canvas,
    {
      vertices,
      batches,
      linetypes,
      textStyles,
      layers,
      instanceGraph,
      glyphCache,
      globalLinetypeScale = 1,
      maximumSourceSegments = DEFAULT_MAXIMUM_SOURCE_SEGMENTS,
      maximumSymbols = DEFAULT_MAXIMUM_SYMBOLS,
      maximumGlyphSegments = DEFAULT_MAXIMUM_GLYPH_SEGMENTS,
      minimumPixelHeight = DEFAULT_MINIMUM_PIXEL_HEIGHT,
      palette = DEFAULT_ACI_PALETTE,
      blocks = Object.freeze([]),
      maskOrder = null,
      orderCompositionEnabled = Boolean(maskOrder?.generalOrderEnabled),
      orderDepthBias = 0,
      maskBucketScale = 1,
    },
  ) {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      throw new Error(
        "Canvas2D is required for the complex linetype overlay",
      );
    }
    for (const [label, value] of Object.entries({
      maximumSourceSegments,
      maximumSymbols,
      maximumGlyphSegments,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer`);
      }
    }
    if (!Number.isFinite(minimumPixelHeight) || minimumPixelHeight < 0) {
      throw new RangeError("minimumPixelHeight must be non-negative");
    }
    this.canvas = canvas;
    this.context = context;
    this.orderSurface = orderCompositionEnabled
      ? drawOrderSurfaceFor(canvas)
      : null;
    this.orderCanvas = this.orderSurface?.canvas ?? null;
    this.orderDepthBias = Number.isFinite(orderDepthBias)
      ? Math.max(-0.5, Math.min(0.5, orderDepthBias))
      : 0;
    this.maskBucketScale =
      Number.isFinite(maskBucketScale) &&
      maskBucketScale > 0 &&
      maskBucketScale <= 1
        ? maskBucketScale
        : 1;
    this.maskOrder = maskOrder?.enabled ? maskOrder : null;
    this.blocks = blocks;
    this.modelOwnerHandle =
      blocks.filter(
        (block) => block.name.toUpperCase() === "*MODEL_SPACE",
      ).length === 1
        ? blocks.find(
            (block) => block.name.toUpperCase() === "*MODEL_SPACE",
          ).handle
        : null;
    this.linetypes = linetypes;
    this.textStyles = textStyles;
    this.layers = layers;
    this.instanceGraph = instanceGraph;
    this.glyphCache = glyphCache;
    this.globalLinetypeScale =
      Number.isFinite(globalLinetypeScale) && globalLinetypeScale > 0
        ? globalLinetypeScale
        : 1;
    this.maximumSymbols = maximumSymbols;
    this.maximumGlyphSegments = maximumGlyphSegments;
    this.minimumPixelHeight = minimumPixelHeight;
    this.palette =
      palette instanceof Uint8Array && palette.length === 256 * 4
        ? new Uint8Array(palette)
        : new Uint8Array(DEFAULT_ACI_PALETTE);
    this.definitions = definitionMap(linetypes);
    this.layerCodes = layerLinetypeCodes(layers, linetypes);
    this.source = collectComplexLinetypeSegments({
      vertices,
      batches,
      linetypes,
      layers,
      layerLinetypeRows:
        instanceGraph.layerLinetypesByVisibilityRow,
      maximumSegments: maximumSourceSegments,
    });
    const discoveredLayerZero = layers.findIndex(
      (layer) =>
        layer.name?.normalize("NFC").toLocaleLowerCase("en-US") === "0",
    );
    this.layerZeroIndex =
      instanceGraph.layerZeroIndex !== undefined &&
      instanceGraph.layerZeroIndex !== NO_LAYER_OVERRIDE
        ? instanceGraph.layerZeroIndex
        : discoveredLayerZero;
  }

  setPalette(palette) {
    if (!(palette instanceof Uint8Array) || palette.length !== 256 * 4) {
      throw new TypeError(
        "complex linetype palette must contain 256 RGBA colors",
      );
    }
    this.palette = new Uint8Array(palette);
  }

  redraw(camera, layerVisibility, { clear = false, size = null } = {}) {
    const context = this.context;
    if (
      size &&
      (this.canvas.width !== size.width ||
        this.canvas.height !== size.height)
    ) {
      this.canvas.width = size.width;
      this.canvas.height = size.height;
    }
    const width = this.canvas.width;
    const height = this.canvas.height;
    resizeDrawOrderSurface(this.orderSurface, width, height, { clear });
    if (clear) {
      context.clearRect(0, 0, width, height);
    }
    const metrics = {
      sourceSegments: this.source.sourceSegments,
      visibleSegments: 0,
      symbols: 0,
      vectorGlyphs: 0,
      fallbackGlyphs: 0,
      segments: 0,
      truncated: this.source.truncated,
    };
    if (
      width <= 0 ||
      height <= 0 ||
      this.source.groups.length === 0
    ) {
      return Object.freeze(metrics);
    }
    outer:
    for (const group of this.source.groups) {
      const instances = instancesForBatch(
        group.batch,
        this.instanceGraph,
      );
      const ownerHandle =
        group.batch.kind === GpuLineBatchKind.BlockDefinition
          ? this.blocks[group.batch.blockIndex]?.handle
          : this.modelOwnerHandle;
      for (
        let instanceIndex = 0;
        instanceIndex < instances.count;
        instanceIndex += 1
      ) {
        const matrixOffset = instanceIndex * 16;
        if (
          !instanceIntersectsCamera(
            group.batch,
            instances.data,
            matrixOffset,
            camera,
          )
        ) {
          continue;
        }
        for (const segment of group.segments) {
          const layerIndex = resolvedLayerIndex(
            segment.layerIndex,
            instances,
            instanceIndex,
            this.layerZeroIndex,
          );
          const visibilityRow = viewportStyleRow(
            instances,
            instanceIndex,
          );
          if (
            layerIndex >= this.layers.length ||
            layerVisibility?.[layerIndex] === false ||
            this.instanceGraph.layerVisibilityRows?.[visibilityRow]?.[
              layerIndex
            ] === 0
          ) {
            continue;
          }
          const viewportLinetypeScale =
            this.instanceGraph.linetypeScalesByVisibilityRow?.[
              visibilityRow
            ] ?? 1;
          const effectiveLinetypeScale =
            this.globalLinetypeScale *
            (Number.isFinite(viewportLinetypeScale) &&
            viewportLinetypeScale > 0
              ? viewportLinetypeScale
              : 1);
          const code =
            segment.linetypeCode === 0
              ? viewportLayerLinetype(
                  this.instanceGraph,
                  visibilityRow,
                  layerIndex,
                  this.layerCodes[layerIndex] ?? 2,
                )
              : segment.linetypeCode === 1
                ? instances.linetypeCodes?.[instanceIndex] ?? 2
                : segment.linetypeCode;
          const definition = this.definitions.get(code);
          if (!definition || definition.patternLength <= 0) {
            continue;
          }
          const start = transformPoint(
            instances.data,
            segment.start,
            matrixOffset,
          );
          const end = transformPoint(
            instances.data,
            segment.end,
            matrixOffset,
          );
          const screenStart = worldToScreen(
            start,
            camera,
            width,
            height,
          );
          const screenEnd = worldToScreen(end, camera, width, height);
          const deltaX = screenEnd[0] - screenStart[0];
          const deltaY = screenEnd[1] - screenStart[1];
          const screenLength = Math.hypot(deltaX, deltaY);
          const patternSpan =
            segment.patternEnd - segment.patternStart;
          if (
            !Number.isFinite(screenLength) ||
            screenLength <= 1e-6 ||
            patternSpan <= 1e-9
          ) {
            continue;
          }
          metrics.visibleSegments += 1;
          const unitX = deltaX / screenLength;
          const unitY = deltaY / screenLength;
          const lineAngle = Math.atan2(deltaY, deltaX);
          const pixelsPerPatternUnit = screenLength / patternSpan;
          const period =
            definition.patternLength * effectiveLinetypeScale;
          const layerColor = viewportLayerColor(
            this.instanceGraph,
            visibilityRow,
            layerIndex,
            this.layers[layerIndex]?.color ?? 0,
          );
          const instanceLayerIndex =
            instances.layerIndices?.[instanceIndex] ?? layerIndex;
          const instanceLayerColor = viewportLayerColor(
            this.instanceGraph,
            visibilityRow,
            instanceLayerIndex,
            this.layers[instanceLayerIndex]?.color ?? layerColor,
          );
          const byBlockColor = decodeCadColor(
            instances.colors?.[instanceIndex] ?? ((2 << 30) | 7),
            {
              layer: { color: instanceLayerColor },
              palette: this.palette,
            },
          );
          const color = decodeCadColor(segment.color, {
            layer: { color: layerColor },
            byBlock: byBlockColor,
            palette: this.palette,
          });
          const opacity = decodeCadOpacity(segment.color, {
            layer: decodeCadOpacity(layerColor),
            byBlock: instances.opacities?.[instanceIndex] ?? 1,
          });
          context.strokeStyle = rgba(color, opacity);
          context.fillStyle = rgba(color, opacity);
          for (const { dash, phase } of complexDashPhases(
            definition,
            effectiveLinetypeScale,
          )) {
            const firstRepeat = Math.ceil(
              (segment.patternStart - phase) / period - 1e-9,
            );
            for (
              let repeat = firstRepeat;
              ;
              repeat += 1
            ) {
              const patternPosition = phase + repeat * period;
              if (patternPosition >= segment.patternEnd - 1e-9) {
                break;
              }
              if (patternPosition < segment.patternStart - 1e-9) {
                continue;
              }
              const fraction =
                (patternPosition - segment.patternStart) / patternSpan;
              const offsetScale =
                effectiveLinetypeScale * pixelsPerPatternUnit;
              const x =
                screenStart[0] +
                deltaX * fraction +
                unitX * dash.xOffset * offsetScale -
                unitY * dash.yOffset * offsetScale;
              const y =
                screenStart[1] +
                deltaY * fraction +
                unitY * dash.xOffset * offsetScale +
                unitX * dash.yOffset * offsetScale;
              const style =
                dash.textStyleIndex === null
                  ? null
                  : this.textStyles[dash.textStyleIndex];
              const fixedHeight =
                style?.height > 0 ? style.height : 1;
              const pixelScale =
                Math.abs(dash.scale || 1) *
                fixedHeight *
                offsetScale;
              if (
                !Number.isFinite(pixelScale) ||
                pixelScale < this.minimumPixelHeight ||
                pixelScale > Math.max(width, height) * 4 ||
                x < -pixelScale * 4 ||
                x > width + pixelScale * 4 ||
                y < -pixelScale * 4 ||
                y > height + pixelScale * 4
              ) {
                continue;
              }
              const worldPoint = [
                start[0] + (end[0] - start[0]) * fraction,
                start[1] + (end[1] - start[1]) * fraction,
                start[2] + (end[2] - start[2]) * fraction,
              ];
              if (
                !visibleInsideClip(
                  this.instanceGraph,
                  instances.clipIds?.[instanceIndex] ?? 0,
                  worldPoint,
                )
              ) {
                continue;
              }
              if (metrics.symbols >= this.maximumSymbols) {
                metrics.truncated = true;
                break outer;
              }
              const angle = symbolAngle(dash, lineAngle);
              const absoluteBucket =
                (instances.maskBases?.[instanceIndex] ?? 0) +
                maskBucketFor(
                  this.maskOrder,
                  ownerHandle,
                  segment.handle,
                ) *
                  this.maskBucketScale;
              if ((dash.flags & 4) !== 0) {
                const glyph = this.glyphCache.getGlyph(
                  style,
                  dash.shapeCode,
                );
                if (!glyph) {
                  metrics.fallbackGlyphs += 1;
                  continue;
                }
                if (
                  metrics.segments + glyph.segmentCount >
                  this.maximumGlyphSegments
                ) {
                  metrics.truncated = true;
                  break outer;
                }
                metrics.segments += drawVectorGlyph(
                  context,
                  glyph,
                  x,
                  y,
                  angle,
                  pixelScale,
                  1,
                );
                if (this.orderSurface) {
                  this.orderSurface.setBucket(absoluteBucket);
                  drawVectorGlyph(
                    this.orderSurface.proxy,
                    glyph,
                    x,
                    y,
                    angle,
                    pixelScale,
                    1,
                  );
                }
                metrics.vectorGlyphs += 1;
              } else if ((dash.flags & 2) !== 0 && dash.text) {
                const drawn = drawTextSymbol(
                  context,
                  this.glyphCache,
                  style,
                  dash.text,
                  x,
                  y,
                  angle,
                  pixelScale,
                  this.maximumGlyphSegments - metrics.segments,
                );
                metrics.segments += drawn.segments;
                metrics.vectorGlyphs += drawn.segments > 0 ? 1 : 0;
                metrics.fallbackGlyphs += drawn.fallbackGlyphs;
                if (this.orderSurface) {
                  this.orderSurface.setBucket(absoluteBucket);
                  drawTextSymbol(
                    this.orderSurface.proxy,
                    this.glyphCache,
                    style,
                    dash.text,
                    x,
                    y,
                    angle,
                    pixelScale,
                    this.maximumGlyphSegments,
                  );
                }
                if (drawn.truncated) {
                  metrics.truncated = true;
                  break outer;
                }
              }
              metrics.symbols += 1;
            }
          }
        }
      }
    }
    return Object.freeze(metrics);
  }

  dispose() {}
}

export {
  DEFAULT_MAXIMUM_GLYPH_SEGMENTS,
  DEFAULT_MAXIMUM_SOURCE_SEGMENTS,
  DEFAULT_MAXIMUM_SYMBOLS,
  DEFAULT_MINIMUM_PIXEL_HEIGHT,
  VERTEX_STRIDE,
};
