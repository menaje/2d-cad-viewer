export function identityMat4() {
  return new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

export function multiplyMat4(left, right) {
  return multiplyMat4Into(left, right, new Float64Array(16));
}

export function multiplyMat4Into(left, right, result) {
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let inner = 0; inner < 4; inner += 1) {
        value += left[inner * 4 + row] * right[column * 4 + inner];
      }
      result[column * 4 + row] = value;
    }
  }
  return result;
}

export function invertAffineMat4(matrix, offset = 0) {
  if (
    (!Array.isArray(matrix) && !ArrayBuffer.isView(matrix)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset + 16 > matrix.length
  ) {
    return null;
  }
  const a00 = matrix[offset];
  const a01 = matrix[offset + 4];
  const a02 = matrix[offset + 8];
  const a10 = matrix[offset + 1];
  const a11 = matrix[offset + 5];
  const a12 = matrix[offset + 9];
  const a20 = matrix[offset + 2];
  const a21 = matrix[offset + 6];
  const a22 = matrix[offset + 10];
  const translationX = matrix[offset + 12];
  const translationY = matrix[offset + 13];
  const translationZ = matrix[offset + 14];
  if (
    ![
      a00,
      a01,
      a02,
      a10,
      a11,
      a12,
      a20,
      a21,
      a22,
      translationX,
      translationY,
      translationZ,
    ].every(Number.isFinite) ||
    Math.abs(matrix[offset + 3]) > 1e-12 ||
    Math.abs(matrix[offset + 7]) > 1e-12 ||
    Math.abs(matrix[offset + 11]) > 1e-12 ||
    Math.abs(matrix[offset + 15] - 1) > 1e-12
  ) {
    return null;
  }
  const cofactor00 = a22 * a11 - a12 * a21;
  const cofactor10 = -a22 * a10 + a12 * a20;
  const cofactor20 = a21 * a10 - a11 * a20;
  const determinant =
    a00 * cofactor00 +
    a01 * cofactor10 +
    a02 * cofactor20;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-18) {
    return null;
  }
  const inverseDeterminant = 1 / determinant;
  const result = new Float64Array(16);
  result[0] = cofactor00 * inverseDeterminant;
  result[4] =
    (-a22 * a01 + a02 * a21) * inverseDeterminant;
  result[8] =
    (a12 * a01 - a02 * a11) * inverseDeterminant;
  result[1] = cofactor10 * inverseDeterminant;
  result[5] =
    (a22 * a00 - a02 * a20) * inverseDeterminant;
  result[9] =
    (-a12 * a00 + a02 * a10) * inverseDeterminant;
  result[2] = cofactor20 * inverseDeterminant;
  result[6] =
    (-a21 * a00 + a01 * a20) * inverseDeterminant;
  result[10] =
    (a11 * a00 - a01 * a10) * inverseDeterminant;
  result[12] = -(
    result[0] * translationX +
    result[4] * translationY +
    result[8] * translationZ
  );
  result[13] = -(
    result[1] * translationX +
    result[5] * translationY +
    result[9] * translationZ
  );
  result[14] = -(
    result[2] * translationX +
    result[6] * translationY +
    result[10] * translationZ
  );
  result[15] = 1;
  return result;
}

export function translationMat4(x, y, z) {
  const matrix = identityMat4();
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return matrix;
}

export function scalingMat4(x, y, z) {
  const matrix = new Float64Array(16);
  matrix[0] = x;
  matrix[5] = y;
  matrix[10] = z;
  matrix[15] = 1;
  return matrix;
}

export function rotationZMat4(angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return new Float64Array([
    cosine, sine, 0, 0,
    -sine, cosine, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

function normalize3(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length < 1e-12) {
    return [0, 0, 1];
  }
  return vector.map((value) => value / length);
}

function cross3(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

export function arbitraryAxisMat4(sourceNormal) {
  const normal = normalize3(sourceNormal);
  const reference =
    Math.abs(normal[0]) < 1 / 64 && Math.abs(normal[1]) < 1 / 64
      ? [0, 1, 0]
      : [0, 0, 1];
  const xAxis = normalize3(cross3(reference, normal));
  const yAxis = normalize3(cross3(normal, xAxis));
  return new Float64Array([
    xAxis[0], xAxis[1], xAxis[2], 0,
    yAxis[0], yAxis[1], yAxis[2], 0,
    normal[0], normal[1], normal[2], 0,
    0, 0, 0, 1,
  ]);
}

export function insertCellMatrix(
  insert,
  blockBasePoint,
  column = 0,
  row = 0,
  matrix = new Float64Array(16),
) {
  let normalX = insert.normal[0];
  let normalY = insert.normal[1];
  let normalZ = insert.normal[2];
  const normalLength = Math.hypot(normalX, normalY, normalZ);
  if (!Number.isFinite(normalLength) || normalLength < 1e-12) {
    normalX = 0;
    normalY = 0;
    normalZ = 1;
  } else {
    normalX /= normalLength;
    normalY /= normalLength;
    normalZ /= normalLength;
  }

  let xAxisX;
  let xAxisY;
  let xAxisZ;
  if (Math.abs(normalX) < 1 / 64 && Math.abs(normalY) < 1 / 64) {
    xAxisX = normalZ;
    xAxisY = 0;
    xAxisZ = -normalX;
  } else {
    xAxisX = -normalY;
    xAxisY = normalX;
    xAxisZ = 0;
  }
  const xAxisLength = Math.hypot(xAxisX, xAxisY, xAxisZ);
  xAxisX /= xAxisLength;
  xAxisY /= xAxisLength;
  xAxisZ /= xAxisLength;
  const yAxisX = normalY * xAxisZ - normalZ * xAxisY;
  const yAxisY = normalZ * xAxisX - normalX * xAxisZ;
  const yAxisZ = normalX * xAxisY - normalY * xAxisX;

  const cosine = Math.cos(insert.rotation);
  const sine = Math.sin(insert.rotation);
  const rotatedX0 = xAxisX * cosine + yAxisX * sine;
  const rotatedX1 = xAxisY * cosine + yAxisY * sine;
  const rotatedX2 = xAxisZ * cosine + yAxisZ * sine;
  const rotatedY0 = -xAxisX * sine + yAxisX * cosine;
  const rotatedY1 = -xAxisY * sine + yAxisY * cosine;
  const rotatedY2 = -xAxisZ * sine + yAxisZ * cosine;
  const scaleX = insert.scale[0];
  const scaleY = insert.scale[1];
  const scaleZ = insert.scale[2];
  const column0X = rotatedX0 * scaleX;
  const column0Y = rotatedX1 * scaleX;
  const column0Z = rotatedX2 * scaleX;
  const column1X = rotatedY0 * scaleY;
  const column1Y = rotatedY1 * scaleY;
  const column1Z = rotatedY2 * scaleY;
  const column2X = normalX * scaleZ;
  const column2Y = normalY * scaleZ;
  const column2Z = normalZ * scaleZ;
  const arrayX = column * insert.columnSpacing;
  const arrayY = row * insert.rowSpacing;
  const baseX = blockBasePoint[0];
  const baseY = blockBasePoint[1];
  const baseZ = blockBasePoint[2];
  matrix.fill(0);
  matrix[0] = column0X;
  matrix[1] = column0Y;
  matrix[2] = column0Z;
  matrix[4] = column1X;
  matrix[5] = column1Y;
  matrix[6] = column1Z;
  matrix[8] = column2X;
  matrix[9] = column2Y;
  matrix[10] = column2Z;
  matrix[12] =
    insert.insertPoint[0] +
    rotatedX0 * arrayX +
    rotatedY0 * arrayY -
    column0X * baseX -
    column1X * baseY -
    column2X * baseZ;
  matrix[13] =
    insert.insertPoint[1] +
    rotatedX1 * arrayX +
    rotatedY1 * arrayY -
    column0Y * baseX -
    column1Y * baseY -
    column2Y * baseZ;
  matrix[14] =
    insert.insertPoint[2] +
    rotatedX2 * arrayX +
    rotatedY2 * arrayY -
    column0Z * baseX -
    column1Z * baseY -
    column2Z * baseZ;
  matrix[15] = 1;
  return matrix;
}

export function transformPoint(
  matrix,
  point,
  matrixOffset = 0,
  target = [0, 0, 0],
) {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  const w =
    matrix[matrixOffset + 3] * x +
    matrix[matrixOffset + 7] * y +
    matrix[matrixOffset + 11] * z +
      matrix[matrixOffset + 15];
  const divisor = Math.abs(w) < 1e-12 ? 1 : w;
  target[0] =
    (matrix[matrixOffset] * x +
      matrix[matrixOffset + 4] * y +
      matrix[matrixOffset + 8] * z +
      matrix[matrixOffset + 12]) /
    divisor;
  target[1] =
    (matrix[matrixOffset + 1] * x +
      matrix[matrixOffset + 5] * y +
      matrix[matrixOffset + 9] * z +
      matrix[matrixOffset + 13]) /
    divisor;
  target[2] =
    (matrix[matrixOffset + 2] * x +
      matrix[matrixOffset + 6] * y +
      matrix[matrixOffset + 10] * z +
      matrix[matrixOffset + 14]) /
    divisor;
  return target;
}

export function batchRelativeInstanceMatrix(
  worldMatrix,
  batchOrigin,
  cameraOrigin,
  matrixOffset = 0,
  target = new Float32Array(16),
  targetOffset = 0,
) {
  const transformedOrigin = transformPoint(
    worldMatrix,
    batchOrigin,
    matrixOffset,
  );
  target[targetOffset] = worldMatrix[matrixOffset];
  target[targetOffset + 1] = worldMatrix[matrixOffset + 1];
  target[targetOffset + 2] = worldMatrix[matrixOffset + 2];
  target[targetOffset + 3] = 0;
  target[targetOffset + 4] = worldMatrix[matrixOffset + 4];
  target[targetOffset + 5] = worldMatrix[matrixOffset + 5];
  target[targetOffset + 6] = worldMatrix[matrixOffset + 6];
  target[targetOffset + 7] = 0;
  target[targetOffset + 8] = worldMatrix[matrixOffset + 8];
  target[targetOffset + 9] = worldMatrix[matrixOffset + 9];
  target[targetOffset + 10] = worldMatrix[matrixOffset + 10];
  target[targetOffset + 11] = 0;
  target[targetOffset + 12] = transformedOrigin[0] - cameraOrigin[0];
  target[targetOffset + 13] = transformedOrigin[1] - cameraOrigin[1];
  target[targetOffset + 14] = transformedOrigin[2] - cameraOrigin[2];
  target[targetOffset + 15] = 1;
  return target;
}

export function emptyBounds3() {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

export function includePoint(bounds, point) {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
  return bounds;
}

export function includeTransformedBounds(
  target,
  source,
  matrix,
  matrixOffset = 0,
) {
  for (const x of [source.min[0], source.max[0]]) {
    for (const y of [source.min[1], source.max[1]]) {
      for (const z of [source.min[2], source.max[2]]) {
        includePoint(target, transformPoint(matrix, [x, y, z], matrixOffset));
      }
    }
  }
  return target;
}

export function boundsAreFinite(bounds) {
  return (
    bounds.min.every(Number.isFinite) &&
    bounds.max.every(Number.isFinite) &&
    bounds.min.every((value, axis) => value <= bounds.max[axis])
  );
}

export function orthographic2D(width, height, worldHeight) {
  const safeHeight = Math.max(height, 1);
  const aspect = Math.max(width, 1) / safeHeight;
  const halfHeight = Math.max(worldHeight, Number.EPSILON) * 0.5;
  const halfWidth = halfHeight * aspect;
  const matrix = new Float32Array(16);
  matrix[0] = 1 / halfWidth;
  matrix[5] = 1 / halfHeight;
  matrix[10] = 0;
  matrix[15] = 1;
  return matrix;
}

export function boundsIntersect2D(left, right) {
  return !(
    left.max[0] < right.min[0] ||
    left.min[0] > right.max[0] ||
    left.max[1] < right.min[1] ||
    left.min[1] > right.max[1]
  );
}

export function transformedBounds2D(
  source,
  matrix,
  matrixOffset = 0,
  target = new Float64Array(4),
) {
  const centerX = source.min[0] * 0.5 + source.max[0] * 0.5;
  const centerY = source.min[1] * 0.5 + source.max[1] * 0.5;
  const centerZ = source.min[2] * 0.5 + source.max[2] * 0.5;
  const extentX = (source.max[0] - source.min[0]) * 0.5;
  const extentY = (source.max[1] - source.min[1]) * 0.5;
  const extentZ = (source.max[2] - source.min[2]) * 0.5;
  const worldCenterX =
    matrix[matrixOffset] * centerX +
    matrix[matrixOffset + 4] * centerY +
    matrix[matrixOffset + 8] * centerZ +
    matrix[matrixOffset + 12];
  const worldCenterY =
    matrix[matrixOffset + 1] * centerX +
    matrix[matrixOffset + 5] * centerY +
    matrix[matrixOffset + 9] * centerZ +
    matrix[matrixOffset + 13];
  const worldExtentX =
    Math.abs(matrix[matrixOffset]) * extentX +
    Math.abs(matrix[matrixOffset + 4]) * extentY +
    Math.abs(matrix[matrixOffset + 8]) * extentZ;
  const worldExtentY =
    Math.abs(matrix[matrixOffset + 1]) * extentX +
    Math.abs(matrix[matrixOffset + 5]) * extentY +
    Math.abs(matrix[matrixOffset + 9]) * extentZ;
  target[0] = worldCenterX - worldExtentX;
  target[1] = worldCenterY - worldExtentY;
  target[2] = worldCenterX + worldExtentX;
  target[3] = worldCenterY + worldExtentY;
  return target;
}

export function packedBoundsIntersect2D(packed, bounds) {
  return !(
    packed[2] < bounds.min[0] ||
    packed[0] > bounds.max[0] ||
    packed[3] < bounds.min[1] ||
    packed[1] > bounds.max[1]
  );
}
