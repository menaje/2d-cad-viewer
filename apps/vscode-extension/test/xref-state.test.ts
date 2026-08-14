import assert from "node:assert/strict";
import test from "node:test";

import {
  xrefSavedState,
  xrefShouldLoadAutomatically,
} from "../src/xref-state";

test("only automatically loads an enabled saved XREF", () => {
  for (const [fields, state, automatic] of [
    [{}, "enabled", true],
    [{ xrefLoaded: true, xrefResolved: true }, "enabled", true],
    [{ xrefLoaded: false, xrefResolved: true }, "unloaded", false],
    [{ xrefLoaded: false, xrefResolved: false }, "unloaded", false],
    [{ xrefLoaded: true, xrefResolved: false }, "unresolved", false],
  ] as const) {
    const actual = xrefSavedState(fields);
    assert.equal(actual, state);
    assert.equal(xrefShouldLoadAutomatically(actual), automatic);
  }
});
