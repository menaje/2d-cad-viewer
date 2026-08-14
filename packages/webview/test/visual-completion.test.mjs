import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateVisualCompletion } from "../src/visual-completion.mjs";

function completed(overrides = {}) {
  return evaluateVisualCompletion({
    firstFrame: true,
    rootText: true,
    rootImages: true,
    detailLoading: 0,
    imageDecoding: 0,
    pendingFontRequests: 0,
    pendingEmbeddedImages: 0,
    postprocessBusy: false,
    fonts: [{ state: "loaded" }, { state: "missing" }],
    references: [
      { kind: "xref", status: "ready" },
      { kind: "xref", status: "missing" },
      { kind: "image", status: "error" },
    ],
    ...overrides,
  });
}

test("treats terminal visual failures as complete and reports their counts", () => {
  assert.deepEqual(completed(), {
    complete: true,
    detailLoading: 0,
    xrefCount: 2,
    xrefIssueCount: 1,
    imageCount: 1,
    imageIssueCount: 1,
    fontCount: 2,
    fontIssueCount: 1,
  });
});

test("treats explicitly unloaded and unresolved XREFs as terminal", () => {
  assert.deepEqual(
    completed({
      references: [
        { kind: "xref", status: "unloaded" },
        { kind: "xref", status: "unresolved" },
      ],
    }),
    {
      complete: true,
      detailLoading: 0,
      xrefCount: 2,
      xrefIssueCount: 2,
      imageCount: 0,
      imageIssueCount: 0,
      fontCount: 2,
      fontIssueCount: 1,
    },
  );
});

test("waits for every asynchronous visual dependency", () => {
  for (const override of [
    { firstFrame: false },
    { rootText: false },
    { rootImages: false },
    { imageDecoding: 1 },
    { pendingFontRequests: 1 },
    { pendingEmbeddedImages: 1 },
    { postprocessBusy: true },
    { fonts: [{ state: "loading" }] },
    { references: [{ kind: "xref", status: "searching" }] },
  ]) {
    assert.equal(completed(override).complete, false);
  }
});

test("reports but does not wait for view-dependent detail streaming", () => {
  assert.deepEqual(completed({ detailLoading: 5_536 }), {
    complete: true,
    detailLoading: 5_536,
    xrefCount: 2,
    xrefIssueCount: 1,
    imageCount: 1,
    imageIssueCount: 1,
    fontCount: 2,
    fontIssueCount: 1,
  });
});

test("fails closed for invalid asynchronous counters", () => {
  assert.equal(completed({ detailLoading: -1 }).complete, false);
  assert.equal(completed({ pendingFontRequests: 0.5 }).complete, false);
});

test("coalesces completion checks without starving on continuous updates", async () => {
  const mainSource = await readFile(
    new URL("../src/main.mjs", import.meta.url),
    "utf8",
  );
  const scheduler = mainSource.match(
    /function scheduleVisualCompletionCheck\(\) \{[\s\S]*?\n\}/u,
  );

  assert.ok(scheduler, "visual completion scheduler is missing");
  assert.match(
    scheduler[0],
    /visualCompletionTimer !== undefined[\s\S]*?return;/u,
  );
  assert.doesNotMatch(scheduler[0], /clearTimeout/u);
});

test("keeps saved display layers when full-cache completion starts", async () => {
  const mainSource = await readFile(
    new URL("../src/main.mjs", import.meta.url),
    "utf8",
  );
  const initialization = mainSource.match(
    /activeViewerRuntime = runtime;[\s\S]*?activeTextComposite = new CompositeTextOverlay/u,
  );

  assert.ok(initialization, "full-cache scene initialization is missing");
  assert.match(
    initialization[0],
    /activeScene = scene;\s*activeDisplayLayers = scene\.metadata\.layers;\s*if \(!scene\.metrics\.preview\) \{\s*beginVisualCompletion\(revision, activeHostCacheId\);\s*\}/u,
  );
});
