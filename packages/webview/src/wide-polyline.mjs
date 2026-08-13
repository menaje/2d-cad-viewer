import { arbitraryAxisMat4, transformPoint } from "./math.mjs";
import { readPolylineDisplayVertices } from "./polyline-source.mjs";

const WIDTH_EPSILON = 1e-12;
const MAX_ARC_ANGLE = Math.PI / 36;
export const MAX_WIDE_POLYLINE_SEGMENTS = 32_768;

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function segmentWidths(entity, vertex) {
  const constantWidth = finiteNonnegative(entity.constantWidth ?? 0);
  const startWidth = finiteNonnegative(vertex.startWidth ?? 0);
  const endWidth = finiteNonnegative(vertex.endWidth ?? 0);
  const defaultStartWidth = finiteNonnegative(
    entity.defaultStartWidth ?? 0,
  );
  const defaultEndWidth = finiteNonnegative(entity.defaultEndWidth ?? 0);
  if (
    constantWidth === null ||
    startWidth === null ||
    endWidth === null ||
    defaultStartWidth === null ||
    defaultEndWidth === null
  ) {
    return null;
  }
  if (constantWidth > WIDTH_EPSILON) {
    return [constantWidth, constantWidth];
  }
  if (startWidth > WIDTH_EPSILON || endWidth > WIDTH_EPSILON) {
    return [startWidth, endWidth];
  }
  return [defaultStartWidth, defaultEndWidth];
}

function usableTriangle(points) {
  const firstX = points[1][0] - points[0][0];
  const firstY = points[1][1] - points[0][1];
  const secondX = points[2][0] - points[0][0];
  const secondY = points[2][1] - points[0][1];
  return Math.abs(firstX * secondY - firstY * secondX) > WIDTH_EPSILON;
}

function usableLine(points) {
  return (
    Math.hypot(
      points[1][0] - points[0][0],
      points[1][1] - points[0][1],
      points[1][2] - points[0][2],
    ) > WIDTH_EPSILON
  );
}

function sampledEdge(start, end, elevation, widths, maximumSegments) {
  const deltaX = end.position[0] - start.position[0];
  const deltaY = end.position[1] - start.position[1];
  const chord = Math.hypot(deltaX, deltaY);
  if (!Number.isFinite(chord) || chord <= WIDTH_EPSILON) {
    return { degenerate: true, points: [], widths: [] };
  }
  const bulge = start.bulge ?? 0;
  if (!Number.isFinite(bulge)) {
    return null;
  }
  let subdivisions = 1;
  let center = null;
  let radius = 0;
  let startAngle = 0;
  let sweep = 0;
  if (Math.abs(bulge) > WIDTH_EPSILON) {
    const centerOffset = (chord * (1 - bulge * bulge)) / (4 * bulge);
    center = [
      (start.position[0] + end.position[0]) * 0.5 -
        (deltaY / chord) * centerOffset,
      (start.position[1] + end.position[1]) * 0.5 +
        (deltaX / chord) * centerOffset,
    ];
    radius = Math.hypot(
      start.position[0] - center[0],
      start.position[1] - center[1],
    );
    sweep = 4 * Math.atan(bulge);
    startAngle = Math.atan2(
      start.position[1] - center[1],
      start.position[0] - center[0],
    );
    subdivisions = Math.max(1, Math.ceil(Math.abs(sweep) / MAX_ARC_ANGLE));
  }
  if (
    !Number.isSafeInteger(subdivisions) ||
    subdivisions > maximumSegments ||
    (center && (!Number.isFinite(radius) || radius <= WIDTH_EPSILON))
  ) {
    return null;
  }
  const points = new Array(subdivisions + 1);
  const sampledWidths = new Array(subdivisions + 1);
  for (let index = 0; index <= subdivisions; index += 1) {
    const parameter = index / subdivisions;
    points[index] = center
      ? [
          center[0] + radius * Math.cos(startAngle + sweep * parameter),
          center[1] + radius * Math.sin(startAngle + sweep * parameter),
          elevation,
        ]
      : [
          start.position[0] + deltaX * parameter,
          start.position[1] + deltaY * parameter,
          elevation,
        ];
    sampledWidths[index] =
      widths[0] + (widths[1] - widths[0]) * parameter;
  }
  return { degenerate: false, points, widths: sampledWidths };
}

function crossSections(sampled) {
  const normals = new Array(sampled.points.length - 1);
  for (let index = 0; index < normals.length; index += 1) {
    const deltaX = sampled.points[index + 1][0] - sampled.points[index][0];
    const deltaY = sampled.points[index + 1][1] - sampled.points[index][1];
    const length = Math.hypot(deltaX, deltaY);
    if (!Number.isFinite(length) || length <= WIDTH_EPSILON) {
      return null;
    }
    normals[index] = [-deltaY / length, deltaX / length];
  }
  const left = new Array(sampled.points.length);
  const right = new Array(sampled.points.length);
  for (let index = 0; index < sampled.points.length; index += 1) {
    let normal;
    let scale = sampled.widths[index] * 0.5;
    if (index === 0) {
      normal = normals[0];
    } else if (index === sampled.points.length - 1) {
      normal = normals.at(-1);
    } else {
      const sumX = normals[index - 1][0] + normals[index][0];
      const sumY = normals[index - 1][1] + normals[index][1];
      const sumLength = Math.hypot(sumX, sumY);
      if (sumLength <= WIDTH_EPSILON) {
        normal = normals[index];
      } else {
        normal = [sumX / sumLength, sumY / sumLength];
        const denominator =
          normal[0] * normals[index][0] + normal[1] * normals[index][1];
        if (denominator > 0.25) {
          scale /= denominator;
        } else {
          normal = normals[index];
        }
      }
    }
    const point = sampled.points[index];
    left[index] = [
      point[0] + normal[0] * scale,
      point[1] + normal[1] * scale,
      point[2],
    ];
    right[index] = [
      point[0] - normal[0] * scale,
      point[1] - normal[1] * scale,
      point[2],
    ];
  }
  return { left, right, center: sampled.points };
}

function appendTriangle(output, matrix, triangle) {
  if (!usableTriangle(triangle)) {
    return;
  }
  for (const point of triangle) {
    output.push(transformPoint(matrix, point));
  }
}

function appendLine(output, matrix, line) {
  if (!usableLine(line)) {
    return;
  }
  for (const point of line) {
    output.push(transformPoint(matrix, point));
  }
}

export function buildWidePolylineGeometry(
  source,
  entity,
  {
    fillMode = true,
    maximumSegments = MAX_WIDE_POLYLINE_SEGMENTS,
  } = {},
) {
  if (
    (entity?.polylineKind !== 1 && entity?.polylineKind !== 2) ||
    !Array.isArray(entity.normal) ||
    entity.normal.length < 3 ||
    !entity.normal.every(Number.isFinite) ||
    Math.hypot(...entity.normal) <= WIDTH_EPSILON ||
    !Number.isFinite(entity.elevation) ||
    typeof fillMode !== "boolean" ||
    !Number.isSafeInteger(maximumSegments) ||
    maximumSegments <= 0
  ) {
    return null;
  }
  const vertices = readPolylineDisplayVertices(
    source?.polylineVertices,
    entity,
  );
  if (!vertices) {
    return null;
  }
  if (
    !vertices.every(
      (vertex) =>
        Array.isArray(vertex.position) &&
        vertex.position.length >= 2 &&
        Number.isFinite(vertex.position[0]) &&
        Number.isFinite(vertex.position[1]),
    )
  ) {
    return null;
  }
  const closed = Boolean(entity.polylineFlags & 1);
  const edgeCount = vertices.length - 1 + Number(closed);
  const edges = new Array(edgeCount);
  let sampledSegments = 0;
  let drawableEdges = 0;
  let wideEdges = 0;
  let maximumDrawableWidth = 0;
  let invalidWidths = false;
  for (let index = 0; index < edgeCount; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const widths = segmentWidths(entity, start);
    if (!widths) {
      invalidWidths = true;
      edges[index] = { wide: false, degenerate: false };
      continue;
    }
    const wide = Math.max(...widths) > WIDTH_EPSILON;
    const chord = Math.hypot(
      end.position[0] - start.position[0],
      end.position[1] - start.position[1],
    );
    if (!Number.isFinite(chord)) {
      return null;
    }
    if (chord <= WIDTH_EPSILON) {
      edges[index] = { wide: false, degenerate: true };
      continue;
    }
    drawableEdges += 1;
    maximumDrawableWidth = Math.max(maximumDrawableWidth, ...widths);
    if (!wide) {
      edges[index] = { wide: false, degenerate: false };
      continue;
    }
    const sampled = sampledEdge(
      start,
      end,
      entity.elevation,
      widths,
      maximumSegments - sampledSegments,
    );
    if (!sampled) {
      return null;
    }
    if (sampled.degenerate) {
      edges[index] = { wide: false, degenerate: true };
      continue;
    }
    sampledSegments += sampled.points.length - 1;
    if (sampledSegments > maximumSegments) {
      return null;
    }
    const sections = crossSections(sampled);
    if (!sections) {
      return null;
    }
    wideEdges += 1;
    edges[index] = { wide: true, degenerate: false, sections };
  }
  if (wideEdges === 0) {
    return Object.freeze({
      fillVertices: Object.freeze([]),
      outlineVertices: Object.freeze([]),
      allDrawableEdgesWide: false,
      maximumDrawableWidth,
      mixedWidth: false,
      sampledSegments,
    });
  }
  const matrix = arbitraryAxisMat4(entity.normal);
  const fillVertices = [];
  const outlineVertices = [];
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    if (!edge.wide) {
      continue;
    }
    const { left, right, center } = edge.sections;
    for (let segment = 0; segment < left.length - 1; segment += 1) {
      if (fillMode) {
        appendTriangle(fillVertices, matrix, [
          left[segment],
          right[segment],
          right[segment + 1],
        ]);
        appendTriangle(fillVertices, matrix, [
          left[segment],
          right[segment + 1],
          left[segment + 1],
        ]);
      } else {
        appendLine(outlineVertices, matrix, [
          left[segment],
          left[segment + 1],
        ]);
        appendLine(outlineVertices, matrix, [
          right[segment],
          right[segment + 1],
        ]);
      }
    }
    const previous = edges[(index - 1 + edges.length) % edges.length];
    const next = edges[(index + 1) % edges.length];
    const connectsPrevious = previous?.wide && (closed || index > 0);
    if (connectsPrevious) {
      const previousLeft = previous.sections.left.at(-1);
      const previousRight = previous.sections.right.at(-1);
      if (fillMode) {
        appendTriangle(fillVertices, matrix, [
          center[0],
          previousLeft,
          left[0],
        ]);
        appendTriangle(fillVertices, matrix, [
          center[0],
          right[0],
          previousRight,
        ]);
      } else {
        appendLine(outlineVertices, matrix, [previousLeft, left[0]]);
        appendLine(outlineVertices, matrix, [previousRight, right[0]]);
      }
    } else if (!fillMode) {
      appendLine(outlineVertices, matrix, [left[0], right[0]]);
    }
    const connectsNext = next?.wide && (closed || index < edges.length - 1);
    if (!connectsNext && !fillMode) {
      appendLine(outlineVertices, matrix, [left.at(-1), right.at(-1)]);
    }
  }
  return Object.freeze({
    fillVertices: Object.freeze(fillVertices),
    outlineVertices: Object.freeze(outlineVertices),
    allDrawableEdgesWide:
      !invalidWidths && drawableEdges > 0 && wideEdges === drawableEdges,
    maximumDrawableWidth,
    mixedWidth: wideEdges > 0 && wideEdges < drawableEdges,
    sampledSegments,
  });
}
