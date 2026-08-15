// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRangeSource,
  SceneCacheReader,
} from "../../dwg-scene-source/src/index.mjs";
import {
  observePackagedDisplayState,
  PACKAGED_DISPLAY_STATE_OBSERVATION_SCHEMA,
} from "../src/display-state-qualification.mjs";
import { makeFixtureCache } from "./cache-fixture.mjs";

test("observes the packaged saved-state decisions from an open scene", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        annotationAllVisible: false,
        attributeDisplayMode: 2,
        fillMode: false,
        frame: 3,
        imageFrame: 2,
        layoutAnnotationAllVisible: true,
        modelSpaceActive: false,
        paperBlockName: "*PAPER_SPACE",
        xrefLoaded: true,
        xrefResolved: false,
      }),
    ),
  );
  const observation = observePackagedDisplayState({
    reader,
    metadata: await reader.readRenderMetadata(),
  });

  assert.equal(
    observation.schema,
    PACKAGED_DISPLAY_STATE_OBSERVATION_SCHEMA,
  );
  assert.equal(observation.cacheSchema, "dwg-scene-cache/1.26");
  assert.ok(observation.inventory.sourceEntities > 0);
  assert.equal(observation.inventory.deferredEntities, 0);
  assert.deepEqual(observation.display.FILLMODE, {
    hatchFillVisible: false,
  });
  assert.deepEqual(observation.display.ATTMODE, {
    normal: true,
    invisible: true,
  });
  assert.deepEqual(observation.display.annotation, {
    model: { missingScaleRepresentationVisible: false },
    layout: { missingScaleRepresentationVisible: true },
  });
  assert.deepEqual(observation.display.FRAME, {
    effective: 2,
    screenVisible: true,
    plotVisible: false,
  });
  assert.deepEqual(observation.display.layout, {
    activeKind: "layout",
    restoration: "restored-paper",
  });
  assert.deepEqual(observation.display.XREF, {
    state: "unresolved",
    displayable: false,
  });
});
