import assert from "node:assert/strict";
import test from "node:test";

import {
  arbitraryAxisMat4,
  insertCellMatrix,
  multiplyMat4,
  rotationZMat4,
  scalingMat4,
  translationMat4,
} from "../src/math.mjs";

function referenceInsertCellMatrix(insert, blockBasePoint, column, row) {
  return [
    translationMat4(...insert.insertPoint),
    arbitraryAxisMat4(insert.normal),
    rotationZMat4(insert.rotation),
    translationMat4(
      column * insert.columnSpacing,
      row * insert.rowSpacing,
      0,
    ),
    scalingMat4(...insert.scale),
    translationMat4(
      -blockBasePoint[0],
      -blockBasePoint[1],
      -blockBasePoint[2],
    ),
  ].reduce(multiplyMat4);
}

function assertMatrixClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    const tolerance = 1e-11 * Math.max(1, Math.abs(expected[index]));
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= tolerance,
      `matrix value ${index}: ${actual[index]} != ${expected[index]}`,
    );
  }
}

test("builds INSERT cell matrices without intermediate matrix allocation", () => {
  const cases = [
    {
      insertPoint: [100, -25, 3],
      normal: [0, 0, 1],
      rotation: Math.PI / 7,
      scale: [2, 0.5, 1.25],
      columnSpacing: 12,
      rowSpacing: 8,
    },
    {
      insertPoint: [-4, 8, 12],
      normal: [0.3, -0.8, 0.4],
      rotation: -1.2,
      scale: [-1.5, 2.25, 0.75],
      columnSpacing: -6,
      rowSpacing: 10,
    },
    {
      insertPoint: [1, 2, 3],
      normal: [0, 0, 0],
      rotation: 0,
      scale: [1, 1, 1],
      columnSpacing: 0,
      rowSpacing: 0,
    },
  ];
  const basePoints = [
    [0, 0, 0],
    [15, -9, 2],
    [-7.5, 11.25, -4],
  ];
  for (const insert of cases) {
    for (const basePoint of basePoints) {
      for (const [column, row] of [[0, 0], [2, 3]]) {
        assertMatrixClose(
          insertCellMatrix(insert, basePoint, column, row),
          referenceInsertCellMatrix(insert, basePoint, column, row),
        );
      }
    }
  }
});
