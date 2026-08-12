import {
  AllNativeAdapterOperations,
  AllNativeCapabilityStatuses,
  NativeDocumentAdapterProtocol,
} from "./constants.mjs";

function record(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function validateCapabilities(value, label) {
  const capabilities = record(value, label);
  const keys = Object.keys(capabilities).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify(AllNativeAdapterOperations)
  ) {
    throw new Error(`${label} must report every exact operation`);
  }
  for (const operation of AllNativeAdapterOperations) {
    if (
      !AllNativeCapabilityStatuses.includes(
        capabilities[operation],
      )
    ) {
      throw new Error(`${label}.${operation} has an invalid status`);
    }
  }
  return capabilities;
}

export function validateNativeAdapterCompatibility(value) {
  const manifest = record(
    value,
    "native document adapter compatibility manifest",
  );
  if (
    manifest.schema !==
    "dwg-native-document-adapter-compatibility/1" ||
    manifest.protocol !== NativeDocumentAdapterProtocol ||
    manifest.status !== "query-preview" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(manifest.asOf)
  ) {
    throw new Error(
      "native document adapter compatibility header is invalid",
    );
  }
  const native = record(manifest.native, "native backend");
  const wasm = record(manifest.wasm, "WASM backend");
  const nativeCapabilities = validateCapabilities(
    native.capabilities,
    "native capabilities",
  );
  const wasmCapabilities = validateCapabilities(
    wasm.capabilities,
    "WASM capabilities",
  );
  if (
    native.status !== "query-preview" ||
    nativeCapabilities.read !== "native" ||
    nativeCapabilities["query-entity"] !== "mapped" ||
    nativeCapabilities["query-region"] !== "mapped" ||
    nativeCapabilities["write-dwg"] !== "blocked" ||
    nativeCapabilities["write-dxf"] !== "blocked"
  ) {
    throw new Error(
      "native backend must expose query-only product capabilities",
    );
  }
  if (
    wasm.status !== "rejected" ||
    wasm.productAdmitted !== false ||
    wasm.observedPeakBytes <= wasm.memoryHardLimitBytes ||
    wasm.browserCompleted !== false
  ) {
    throw new Error("WASM rejection evidence is incomplete");
  }
  const writer = record(
    manifest.writerQualification,
    "writer qualification",
  );
  if (
    writer.productAdmitted !== false ||
    writer.blockBeforeOutputReservation !== true ||
    writer.referenceConformance !== "passed" ||
    writer.actualNoopRoundTrip !== "failed"
  ) {
    throw new Error(
      "unqualified writer must remain blocked before output",
    );
  }
  const boundaries = record(
    manifest.distributionBoundary,
    "distribution boundary",
  );
  if (
    boundaries.mplVsixBundlesGplAdapter !== false ||
    boundaries.gplAdapterSeparateArtifact !== true ||
    boundaries.sourceCompletePackage !== true
  ) {
    throw new Error("GPL/MPL distribution boundary is invalid");
  }
  const qualifiedTargets = [
    "linux-x64",
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
  ];
  if (
    JSON.stringify(boundaries.qualifiedTargets) !==
      JSON.stringify(qualifiedTargets) ||
    boundaries.windows !== "qualified"
  ) {
    throw new Error(
      "native distribution qualification is invalid",
    );
  }
  const windowsQualification = record(
    boundaries.windowsQualification,
    "Windows qualification",
  );
  if (
    !/^https:\/\/github\.com\/menaje\/2d-cad-viewer\/actions\/runs\/\d+$/u.test(
      windowsQualification.workflowRun,
    ) ||
    !/^[0-9a-f]{40}$/u.test(windowsQualification.commit) ||
    windowsQualification.evidence !==
      "compatibility/evidence/windows-qualification-2026-08-04.json"
  ) {
    throw new Error(
      "Windows qualification evidence is invalid",
    );
  }
  return Object.freeze({
    status: manifest.status,
    nativeBackend: native.backendId,
    wasmBackend: wasm.backendId,
    writerAdmitted: writer.productAdmitted,
    nativeQueryOperations: [
      "read",
      "query-entity",
      "query-region",
    ].filter(
      (operation) =>
        nativeCapabilities[operation] !== "blocked",
    ).length,
  });
}
