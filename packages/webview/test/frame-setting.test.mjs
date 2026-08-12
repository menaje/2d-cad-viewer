// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveFrameSetting,
} from "../src/frame-setting.mjs";

test("FRAME 0/1/2 overrides every individual frame setting", () => {
  assert.equal(effectiveFrameSetting(0, 2), 0);
  assert.equal(effectiveFrameSetting(1, 0), 1);
  assert.equal(effectiveFrameSetting(2, 1), 2);
});

test("FRAME 3 or an unavailable FRAME uses the individual setting", () => {
  assert.equal(effectiveFrameSetting(3, 0), 0);
  assert.equal(effectiveFrameSetting(3, 2), 2);
  assert.equal(effectiveFrameSetting(null, 1), 1);
  assert.equal(effectiveFrameSetting(undefined, null), null);
});

test("rejects values outside the saved FRAME contracts", () => {
  assert.throws(() => effectiveFrameSetting(4, 1), /FRAME/u);
  assert.throws(() => effectiveFrameSetting(3, 3), /individual/u);
});
