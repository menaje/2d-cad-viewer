import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ViewerWebGlComparisonStrategy,
  mountWebGlRevisionComparison,
} from "../src/public-api.mjs";

const repositoryRoot = new URL("../../../", import.meta.url);

async function json(relativePath) {
  return JSON.parse(
    await readFile(new URL(relativePath, repositoryRoot), "utf8"),
  );
}

test("binds path-free Browser and packaged comparison evidence to the public API", async () => {
  const manifest = await json("compatibility/viewer-webgl.json");
  const evidence = await json(
    manifest.developmentQualification.evidence,
  );
  const serialized = JSON.stringify(evidence);

  assert.equal(typeof mountWebGlRevisionComparison, "function");
  assert.equal(manifest.embedding.revisionComparisonMount, true);
  assert.equal(
    manifest.embedding.revisionComparisonStrategy,
    ViewerWebGlComparisonStrategy.SINGLE_RENDERER_SERIAL_SNAPSHOT,
  );
  assert.equal(manifest.distribution.published, true);
  assert.equal(
    manifest.developmentQualification.publishedInDistribution,
    false,
  );
  assert.equal(evidence.status, "pass");
  assert.equal(
    evidence.strategyDecision.selected,
    ViewerWebGlComparisonStrategy.SINGLE_RENDERER_SERIAL_SNAPSHOT,
  );
  assert.equal(evidence.actualWebGlFixture.browser.status, "pass");
  assert.equal(
    evidence.actualWebGlFixture.packagedVscode.status,
    "pass",
  );
  assert.equal(
    evidence.actualWebGlFixture.packagedVscode
      .deltaAllocatedBytesAfterDispose,
    0,
  );
  assert.equal(
    evidence.actualWebGlFixture.packagedVscode
      .rollbackPreservedPickRevision,
    true,
  );
  assert.equal(evidence.publicDwgFixture.license, "KOGL-Type-1");
  assert.equal(
    evidence.largeDrawingGate.runs.every(
      (run) => run.status === "pass",
    ),
    true,
  );
  assert.doesNotMatch(
    serialized,
    /\/(?:Users|Volumes|private|tmp)\//u,
  );
});
