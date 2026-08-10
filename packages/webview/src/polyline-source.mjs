export const POLYLINE_FLAG_SPLINE_FIT = 1 << 2;
export const POLYLINE_FLAG_CONTINUOUS_LINETYPE = 1 << 7;

const VERTEX_FLAG_CURVE_FIT_EXTRA = 1 << 0;
const VERTEX_FLAG_SPLINE_FIT_EXTRA = 1 << 3;
const VERTEX_FLAG_SPLINE_FRAME_CONTROL = 1 << 4;

function splineDisplayVertex(vertex) {
  return (
    (vertex.flags &
      (VERTEX_FLAG_CURVE_FIT_EXTRA | VERTEX_FLAG_SPLINE_FIT_EXTRA)) !==
      0 &&
    (vertex.flags & VERTEX_FLAG_SPLINE_FRAME_CONTROL) === 0
  );
}

export function readPolylineDisplayVertices(
  table,
  entity,
  { maximumVertices = 1_048_576 } = {},
) {
  if (
    !table ||
    typeof table.readVertex !== "function" ||
    !Number.isSafeInteger(entity?.firstVertex) ||
    !Number.isSafeInteger(entity?.vertexCount) ||
    entity.vertexCount < 2 ||
    entity.vertexCount > maximumVertices ||
    entity.firstVertex < 0 ||
    entity.firstVertex + entity.vertexCount > table.length
  ) {
    return null;
  }
  const target = { position: [0, 0, 0] };
  const vertices = new Array(entity.vertexCount);
  for (let index = 0; index < entity.vertexCount; index += 1) {
    table.readVertex(entity.firstVertex + index, target);
    vertices[index] = {
      position: [...target.position],
      bulge: target.bulge ?? 0,
      startWidth: target.startWidth ?? 0,
      endWidth: target.endWidth ?? 0,
      curveTangent: target.curveTangent ?? 0,
      flags: target.flags ?? 0,
      id: target.id ?? 0,
    };
  }
  if (
    entity.polylineKind === 2 &&
    (entity.polylineFlags & POLYLINE_FLAG_SPLINE_FIT) !== 0
  ) {
    const generated = vertices.filter(splineDisplayVertex);
    if (generated.length >= 2) {
      return generated;
    }
  }
  return vertices;
}
