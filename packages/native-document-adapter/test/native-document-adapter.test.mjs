import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MemoryRangeSource,
  SceneCacheReader,
} from "@menaje/dwg-scene-source";

import {
  NativeAdapterErrorCode,
  NativeBackendKind,
  NativeChangeKind,
  NativeDocumentAdapterError,
  NativeDocumentAdapterProtocol,
  createNativeDocumentAdapterSession,
  validateNativeAdapterCompatibility,
} from "../src/index.mjs";
import {
  compareNativeWasmCapabilities,
  runNativeDocumentAdapterConformance,
} from "../src/conformance.mjs";
import {
  createSceneCacheNativeDescriptor,
  createSceneCacheNativeIndex,
} from "../src/scene-cache-index.mjs";
import {
  ReferenceEntities,
  ReferenceSourceFingerprint,
  createReferenceDescriptor,
  createReferenceSession,
} from "../src/testing.mjs";
import {
  makeFixtureCache,
} from "../../webview/test/cache-fixture.mjs";

const SCENE_SOURCE_FINGERPRINT =
  `sha256:${"1".repeat(64)}`;

function referenceProposal(entity) {
  return Object.freeze({
    protocol: NativeDocumentAdapterProtocol,
    proposalId: "proposal:mismatch",
    sourceFingerprint: ReferenceSourceFingerprint,
    inputCapabilityId: "capability:input-reference",
    outputCapabilityId: "capability:output-mismatch",
    outputFormat: "dwg",
    outputVersion: "AC1032",
    operations: Object.freeze([
      Object.freeze({
        operationId: "operation:text-replace",
        kind: NativeChangeKind.TEXT_REPLACE,
        target: entity.ref,
        payload: Object.freeze({ value: "변경" }),
      }),
    ]),
  });
}

test("reference contract covers query, stale, overwrite, writer, reopen, and cleanup", async () => {
  for (const writer of [false, true]) {
    let provider;
    const report = await runNativeDocumentAdapterConformance(
      async () => {
        const fixture = createReferenceSession({ writer });
        provider = fixture.provider;
        return {
          session: fixture.session,
          entities: ReferenceEntities,
        };
      },
    );

    assert.equal(report.protocol, NativeDocumentAdapterProtocol);
    assert.equal(report.query.returnedEntities, 2);
    assert.equal(report.query.staleSource.rejected, true);
    assert.equal(report.query.staleEntity.rejected, true);
    assert.equal(report.safety.outputConflict.rejected, true);
    assert.equal(report.safety.cleanup.remainingTemporaryFiles, 0);
    assert.equal(report.writer.admitted, writer);
    assert.equal(provider.state.writeCalls, writer ? 2 : 0);
    assert.equal(provider.state.disposed, true);
  }
});

test("reopened observed diff must exactly match intended operations", async () => {
  const { session, provider } = createReferenceSession({
    writer: true,
    mismatchObserved: true,
  });
  await assert.rejects(
    session.applyProposal(referenceProposal(ReferenceEntities[1])),
    (error) =>
      error?.code ===
      NativeAdapterErrorCode.OBSERVED_DIFF_MISMATCH,
  );
  assert.equal(provider.state.writeCalls, 1);
  await session.dispose();
});

test("Scene Cache builds a packed bounded native query index without an entity graph", async () => {
  const buffer = makeFixtureCache({
    includeReviewCurves: true,
  });
  const source = new MemoryRangeSource(buffer);
  const reader = await SceneCacheReader.open(source);
  const provider = await createSceneCacheNativeIndex(reader, {
    sourceFingerprint: SCENE_SOURCE_FINGERPRINT,
    maximumReadBytes: 4096,
    maximumScanEntries: 4,
  });
  const descriptor = createSceneCacheNativeDescriptor({
    sourceFingerprint: SCENE_SOURCE_FINGERPRINT,
    inputCapabilityId: "capability:fixture-input",
  });
  const session = createNativeDocumentAdapterSession(
    descriptor,
    provider,
  );

  let cursor = null;
  const entities = [];
  let unindexedEntries = 0;
  do {
    const page = await session.queryRegion({
      sourceFingerprint: SCENE_SOURCE_FINGERPRINT,
      bounds: {
        min: [-10_000, -10_000, -10_000],
        max: [10_000, 10_000, 10_000],
      },
      types: [],
      pageSize: 3,
      cursor,
    });
    entities.push(...page.entities);
    unindexedEntries += page.unindexedEntries;
    cursor = page.nextCursor;
  } while (cursor !== null);

  assert.ok(entities.length >= 8);
  assert.ok(unindexedEntries >= 1);
  assert.ok(
    entities.some((entity) => entity.boundsPrecision === "exact"),
  );
  assert.ok(
    entities.some(
      (entity) => entity.boundsPrecision === "conservative",
    ),
  );
  const entity = entities[0];
  assert.deepEqual(
    await session.queryEntity({
      sourceFingerprint: SCENE_SOURCE_FINGERPRINT,
      ref: entity.ref,
    }),
    entity,
  );
  await assert.rejects(
    session.queryEntity({
      sourceFingerprint: SCENE_SOURCE_FINGERPRINT,
      ref: {
        ...entity.ref,
        entityFingerprint: `sha256:${"0".repeat(64)}`,
      },
    }),
    (error) =>
      error?.code === NativeAdapterErrorCode.STALE_ENTITY,
  );

  await assert.rejects(
    session.applyProposal({
      protocol: NativeDocumentAdapterProtocol,
      proposalId: "proposal:blocked-scene-writer",
      sourceFingerprint: SCENE_SOURCE_FINGERPRINT,
      inputCapabilityId: "capability:fixture-input",
      outputCapabilityId: "capability:fixture-output",
      outputFormat: "dwg",
      outputVersion: "AC1032",
      operations: [],
    }),
    (error) =>
      error?.code === NativeAdapterErrorCode.CAPABILITY_BLOCKED,
  );
  assert.ok(provider.state.packedIndexBytes < 64 * 1024);
  assert.ok(provider.state.sourceBytesRead < buffer.byteLength);

  const cleanup = await session.dispose();
  assert.equal(cleanup.remainingTemporaryFiles, 0);
  assert.equal(provider.state.disposed, true);
});

test("Native/WASM differences remain structured and WASM stays unadmitted", () => {
  const native = createSceneCacheNativeDescriptor({
    sourceFingerprint: SCENE_SOURCE_FINGERPRINT,
    inputCapabilityId: "capability:native-input",
  });
  const wasm = createSceneCacheNativeDescriptor({
    sourceFingerprint: SCENE_SOURCE_FINGERPRINT,
    inputCapabilityId: "capability:wasm-input",
    backendId: "backend:libredwg-wasm-memfs",
    backendKind: NativeBackendKind.WASM_WORKER,
  });
  const comparison = compareNativeWasmCapabilities(native, wasm);

  assert.equal(
    comparison.operations["query-entity"].native,
    "mapped",
  );
  assert.equal(
    comparison.operations["write-dwg"].wasm,
    "blocked",
  );
  assert.equal(comparison.wasmProductAdmitted, false);
});

test("adapter descriptor rejects missing operation status", () => {
  const descriptor = structuredClone(
    createReferenceDescriptor(),
  );
  delete descriptor.capabilities["query-region"];
  assert.throws(
    () =>
      createNativeDocumentAdapterSession(descriptor, {
        queryEntity() {},
        queryRegion() {},
        dispose() {
          return {
            remainingTemporaryFiles: 0,
            remainingOutputReservations: 0,
            processExited: true,
            workerTerminated: false,
          };
        },
      }),
    /capability query-region is missing/u,
  );
});

test("progress and errors use bounded versioned schemas", async () => {
  const { session } = createReferenceSession();
  const progress = [];
  await session.queryEntity(
    {
      sourceFingerprint: ReferenceSourceFingerprint,
      ref: ReferenceEntities[0].ref,
    },
    {
      onProgress(event) {
        progress.push(event);
      },
    },
  );
  assert.deepEqual(
    progress.map((event) => event.phase),
    ["validating", "querying", "complete"],
  );
  assert.ok(
    progress.every(
      (event) =>
        event.schema === "dwg-native-adapter-progress/1" &&
        event.protocol === NativeDocumentAdapterProtocol,
    ),
  );

  const error = new NativeDocumentAdapterError(
    NativeAdapterErrorCode.STALE_SOURCE,
    "stale",
    { expected: ReferenceSourceFingerprint },
  );
  assert.deepEqual(error.toJSON(), {
    schema: "dwg-native-adapter-error/1",
    code: NativeAdapterErrorCode.STALE_SOURCE,
    message: "stale",
    details: { expected: ReferenceSourceFingerprint },
  });
  await session.dispose();
});

test("compatibility manifest keeps product writers and WASM fail-closed", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../../../compatibility/native-document-adapter.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const report = validateNativeAdapterCompatibility(manifest);
  assert.deepEqual(report, {
    status: "query-preview",
    nativeBackend: "backend:libredwg-native",
    wasmBackend: "backend:libredwg-wasm-memfs",
    writerAdmitted: false,
    nativeQueryOperations: 3,
  });

  const windowsEvidence = JSON.parse(
    await readFile(
      new URL(
        "../../../compatibility/evidence/windows-qualification-2026-08-04.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    windowsEvidence.execution.workflowRun,
    manifest.distributionBoundary.windowsQualification.workflowRun,
  );
  assert.equal(
    windowsEvidence.execution.commit,
    manifest.distributionBoundary.windowsQualification.commit,
  );
  assert.equal(windowsEvidence.scope.target, "win32-x64");
  assert.equal(windowsEvidence.scope.deploymentPerformed, false);
  assert.equal(
    windowsEvidence.vscodeUiQualification.screenshots.length,
    8,
  );
  assert.equal(
    windowsEvidence.explicitNonclaims.physicalWindows11Executed,
    false,
  );

  const missingWindowsTarget = structuredClone(manifest);
  missingWindowsTarget.distributionBoundary.qualifiedTargets =
    missingWindowsTarget.distributionBoundary.qualifiedTargets.filter(
      (target) => target !== "win32-x64",
    );
  assert.throws(
    () =>
      validateNativeAdapterCompatibility(missingWindowsTarget),
    /distribution qualification/u,
  );

  const missingIntelMacTarget = structuredClone(manifest);
  missingIntelMacTarget.distributionBoundary.qualifiedTargets =
    missingIntelMacTarget.distributionBoundary.qualifiedTargets.filter(
      (target) => target !== "darwin-x64",
    );
  assert.throws(
    () => validateNativeAdapterCompatibility(missingIntelMacTarget),
    /distribution qualification/u,
  );

  const blockedWindows = structuredClone(manifest);
  blockedWindows.distributionBoundary.windows = "blocked";
  assert.throws(
    () => validateNativeAdapterCompatibility(blockedWindows),
    /distribution qualification/u,
  );

  manifest.writerQualification.productAdmitted = true;
  assert.throws(
    () => validateNativeAdapterCompatibility(manifest),
    /writer must remain blocked/u,
  );
});
