import assert from "node:assert/strict";
import test from "node:test";

import {
  layerLinetypeCodes,
  makeLinetypeTextureData,
} from "../src/cad-linetype.mjs";

test("maps layer linetype names to compact CAD codes", () => {
  const definitions = [
    { code: 2, name: "Continuous" },
    { code: 3, name: "CENTER" },
  ];
  assert.deepEqual(
    layerLinetypeCodes(
      [
        { linetype: "continuous" },
        { linetype: "CENTER" },
        { linetype: "missing" },
      ],
      definitions,
    ),
    new Uint16Array([2, 3, 2]),
  );
});

test("packs bounded simple and complex linetype definitions for WebGL", () => {
  const data = makeLinetypeTextureData([
    {
      code: 3,
      patternLength: 1.5,
      alignment: 65,
      flags: 0,
      dashes: [{ length: 1 }, { length: -0.5 }],
    },
    {
      code: 4,
      patternLength: 2,
      flags: 1,
      dashes: [{ length: 0 }, { length: -2 }],
    },
  ]);

  assert.deepEqual([...data.headers.slice(12, 20)], [
    1.5, 0, 2, 2,
    2, 2, 2, 1,
  ]);
  assert.deepEqual([...data.dashes], [1, -0.5, 0, -2]);
  assert.equal(data.complexCount, 1);
});
