import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  normalizeNpmPackageArchive,
} from "./normalize-npm-package-archive.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifestPath = path.join(
  repositoryRoot,
  "compatibility",
  "viewer-core.json",
);
const evidencePath = path.join(
  repositoryRoot,
  "compatibility",
  "evidence",
  "viewer-boundary-0.1.2-2026-08-04.json",
);
const emitOnly = process.argv.slice(2).includes("--emit");
const unexpectedArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--emit");
if (unexpectedArguments.length > 0) {
  throw new Error(
    `unsupported viewer boundary arguments: ${unexpectedArguments.join(", ")}`,
  );
}

const packageDefinitions = Object.freeze([
  Object.freeze({
    manifestKey: "viewerCore",
    artifactKey: "viewerCore",
    directory: "packages/viewer-core",
    allowedExternalImports: Object.freeze([
      "@menaje/viewer-render-protocol",
    ]),
  }),
  Object.freeze({
    manifestKey: "renderProtocol",
    artifactKey: "renderProtocol",
    directory: "packages/render-protocol",
    allowedExternalImports: Object.freeze([]),
  }),
  Object.freeze({
    manifestKey: "viewerUi",
    artifactKey: "viewerUi",
    directory: "packages/viewer-ui",
    allowedExternalImports: Object.freeze([]),
  }),
]);

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command, arguments_, { cwd = repositoryRoot } = {}) {
  const commandExtension = path.extname(command).toLowerCase();
  const windowsCommandShim =
    process.platform === "win32" && commandExtension === ".cmd";
  const childCommand = windowsCommandShim
    ? (process.env.ComSpec ?? "cmd.exe")
    : command;
  const childArguments = windowsCommandShim
    ? ["/d", "/s", "/c", command, ...arguments_]
    : arguments_;
  const result = spawnSync(childCommand, childArguments, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${arguments_.join(" ")} failed with ${result.status}` +
        (output ? `\n${output}` : ""),
    );
  }
  return result.stdout.trim();
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, {
    withFileTypes: true,
  })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function externalImports(source) {
  const imports = new Set();
  const expression =
    /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/gu;
  for (const match of source.matchAll(expression)) {
    if (
      !match[1].startsWith(".") &&
      !match[1].startsWith("/") &&
      !match[1].startsWith("#")
    ) {
      imports.add(match[1]);
    }
  }
  return [...imports].sort();
}

async function validatePublicPackageBoundary(
  definition,
  manifest,
) {
  const packageRoot = path.join(
    repositoryRoot,
    definition.directory,
  );
  const packageManifest = await readJson(
    path.join(packageRoot, "package.json"),
  );
  const expected = manifest[definition.manifestKey];
  assert.equal(packageManifest.name, expected.package);
  assert.equal(packageManifest.version, expected.version);
  assert.equal(packageManifest.private, false);
  assert.equal(packageManifest.license, "MPL-2.0");
  assert.deepEqual(packageManifest.files, [
    "LICENSE",
    "NOTICE",
    "README.md",
    "src",
  ]);

  const [packageLicense, packageNotice] = await Promise.all([
    readFile(path.join(packageRoot, "LICENSE")),
    readFile(path.join(packageRoot, "NOTICE"), "utf8"),
  ]);
  assert.equal(
    createHash("sha256").update(packageLicense).digest("hex"),
    "3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04",
  );
  assert.match(
    packageNotice,
    /Copyright 2026 dwg-viewer contributors/u,
  );

  const files = (await filesBelow(path.join(packageRoot, "src")))
    .filter((file) => file.endsWith(".mjs"));
  const imports = new Set();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /acquireVsCodeApi/u);
    for (const specifier of externalImports(source)) {
      imports.add(specifier);
    }
  }
  assert.deepEqual(
    [...imports].sort(),
    [...definition.allowedExternalImports],
  );
  assert.deepEqual(
    Object.keys(packageManifest.dependencies ?? {}).sort(),
    [...definition.allowedExternalImports],
  );

  return Object.freeze({
    package: packageManifest.name,
    version: packageManifest.version,
    license: packageManifest.license,
    sourceModules: files.length,
    externalImports: Object.freeze([...imports].sort()),
    productBootstrapImports: 0,
  });
}

async function packageContentSha256(
  artifactPath,
  extractionDirectory,
) {
  await mkdir(extractionDirectory, { recursive: true });
  run("tar", [
    "-xzf",
    artifactPath,
    "-C",
    extractionDirectory,
  ]);
  const packageRoot = path.join(extractionDirectory, "package");
  const files = await filesBelow(packageRoot);
  const digest = createHash("sha256");
  for (const file of files) {
    const relativePath = path
      .relative(packageRoot, file)
      .split(path.sep)
      .join("/");
    const bytes = await readFile(file);
    digest.update(relativePath);
    digest.update("\0");
    digest.update(String(bytes.byteLength));
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function packArtifacts(destination, manifest) {
  await mkdir(destination, { recursive: true });
  for (const definition of packageDefinitions) {
    run(executable("pnpm"), [
      "--dir",
      path.join(repositoryRoot, definition.directory),
      "pack",
      "--pack-destination",
      destination,
    ]);
  }

  const artifacts = {};
  for (const definition of packageDefinitions) {
    const expected =
      manifest.distribution.artifacts[definition.artifactKey];
    const artifactPath = path.join(destination, expected.file);
    await normalizeNpmPackageArchive(artifactPath);
    assert.match(expected.sha256, /^[a-f0-9]{64}$/u);
    assert.match(expected.contentSha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(expected.bytes));
    assert.ok(expected.bytes > 0);
    const archiveBytes = await readFile(artifactPath);
    const archiveDigest = createHash("sha256")
      .update(archiveBytes)
      .digest("hex");
    assert.equal(archiveDigest, expected.sha256);
    assert.equal(archiveBytes.byteLength, expected.bytes);

    const entries = run("tar", ["-tzf", artifactPath])
      .split(/\r?\n/u)
      .filter(Boolean);
    assert.ok(entries.length > 0);
    assert.ok(
      entries.every((entry) => entry.startsWith("package/")),
    );
    assert.ok(
      entries.every(
        (entry) =>
          !entry.includes("/test/") &&
          !entry.includes("/node_modules/") &&
          !entry.includes("/apps/") &&
          !entry.includes("/adapters/"),
      ),
    );
    const contentDigest = await packageContentSha256(
      artifactPath,
      path.join(
        destination,
        `content-${definition.artifactKey}`,
      ),
    );
    assert.equal(contentDigest, expected.contentSha256);

    artifacts[definition.artifactKey] = Object.freeze({
      file: expected.file,
      publishedSha256: archiveDigest,
      publishedBytes: archiveBytes.byteLength,
      contentSha256: contentDigest,
      entries: entries.length,
      runnerRepackByteIdentical: true,
    });
  }
  return Object.freeze(artifacts);
}

async function assertReproducible(first, second, manifest) {
  for (const definition of packageDefinitions) {
    const file =
      manifest.distribution.artifacts[
        definition.artifactKey
      ].file;
    const [left, right] = await Promise.all([
      readFile(path.join(first, file)),
      readFile(path.join(second, file)),
    ]);
    assert.equal(Buffer.compare(left, right), 0);
  }
}

const consumerProbe = String.raw`
import {
  ViewerCoreApi,
  openViewerRuntime,
} from "@menaje/viewer-core";
import {
  runRenderSourceConformance,
  runServiceEventConformance,
  runServiceRenderSourceConformance,
} from "@menaje/viewer-core/conformance";
import {
  createMockServiceEventHarness,
  MockRenderSource,
  MockServicePickFixture,
  MockServiceRenderSource,
} from "@menaje/viewer-core/testing";
import {
  RenderProtocolId,
} from "@menaje/viewer-render-protocol";
import {
  ViewerUiApi,
} from "@menaje/viewer-ui";

const renderSource = await runRenderSourceConformance(
  () => new MockRenderSource(),
);
const serviceSource = await runServiceRenderSourceConformance(
  () => new MockServiceRenderSource(),
  MockServicePickFixture,
);
const serviceEvents = await runServiceEventConformance(
  () => createMockServiceEventHarness(),
);
let hostDisposals = 0;
let presentationDisposals = 0;
const runtime = await openViewerRuntime(new MockRenderSource(), {
  host: {
    handleEvent() {},
    dispose() {
      hostDisposals += 1;
    },
  },
  mount() {
    return {
      dispose() {
        presentationDisposals += 1;
      },
    };
  },
});
await runtime.dispose();
await runtime.dispose();
if (
  hostDisposals !== 1 ||
  presentationDisposals !== 1 ||
  !runtime.disposed
) {
  throw new Error("standalone runtime lifecycle did not close exactly once");
}

console.log(JSON.stringify({
  identities: {
    viewerCore: ViewerCoreApi,
    renderProtocol: RenderProtocolId,
    viewerUi: ViewerUiApi,
  },
  conformance: {
    renderSourceProtocol: renderSource.protocolVersion,
    renderSourceDisposed: renderSource.disposed,
    serviceExternalIdentity: serviceSource.hasExternalIdentity,
    serviceLayerKinds: serviceSource.layerKinds,
    serviceRevisionEvents: serviceEvents.revisionEvents,
    serviceDiagnosticBatches: serviceEvents.diagnosticBatches,
    serviceDiagnostics: serviceEvents.diagnostics,
    serviceReplayRejected: serviceEvents.replayRejected,
  },
  standalone: {
    openedWithoutExternalProduct: true,
    optionalIntegrationAbsent: true,
    hostDisposals,
    presentationDisposals,
  },
}));
`;

async function qualifyArtifactConsumer(
  directory,
  artifactsDirectory,
  manifest,
) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify({
      name: "viewer-boundary-qualification-consumer",
      private: true,
      type: "module",
    }, null, 2)}\n`,
    "utf8",
  );
  const artifactPaths = packageDefinitions.map((definition) =>
    path.join(
      artifactsDirectory,
      manifest.distribution.artifacts[
        definition.artifactKey
      ].file,
    ),
  );
  run(
    executable("npm"),
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...artifactPaths,
    ],
    { cwd: directory },
  );
  return JSON.parse(
    run(
      process.execPath,
      ["--input-type=module", "--eval", consumerProbe],
      { cwd: directory },
    ),
  );
}

async function validateProductEntrypoints() {
  const [
    browserHtml,
    webviewMain,
    extensionBuilder,
    extensionHtml,
    webviewPackage,
  ] = await Promise.all([
    readFile(
      path.join(repositoryRoot, "packages/webview/index.html"),
      "utf8",
    ),
    readFile(
      path.join(repositoryRoot, "packages/webview/src/main.mjs"),
      "utf8",
    ),
    readFile(
      path.join(
        repositoryRoot,
        "apps/vscode-extension/scripts/build-webview.mjs",
      ),
      "utf8",
    ),
    readFile(
      path.join(
        repositoryRoot,
        "apps/vscode-extension/src/extension.ts",
      ),
      "utf8",
    ),
    readJson(
      path.join(repositoryRoot, "packages/webview/package.json"),
    ),
  ]);
  assert.match(browserHtml, /src\/main\.mjs/u);
  assert.match(
    webviewMain,
    /DwgSceneCacheSource[\s\S]*@menaje\/dwg-scene-source/u,
  );
  assert.match(
    webviewMain,
    /openViewerRuntime[\s\S]*@menaje\/viewer-core/u,
  );
  assert.match(
    webviewMain,
    /mountDwgWebGlPresentation[\s\S]*@menaje\/viewer-webgl/u,
  );
  assert.match(
    extensionBuilder,
    /packages["'], ["']webview["'][\s\S]*src["'], ["']main\.mjs/u,
  );
  assert.match(
    extensionHtml,
    /joinPath\(mediaRoot, ["']src["'], ["']main\.mjs["']\)/u,
  );
  for (const dependency of [
    "@menaje/dwg-scene-source",
    "@menaje/viewer-render-protocol",
    "@menaje/viewer-core",
    "@menaje/viewer-ui",
    "emf-converter",
  ]) {
    assert.ok(dependency in webviewPackage.dependencies);
  }
  return Object.freeze({
    browser: "packages/webview/src/main.mjs",
    vscodeBundle: "packages/webview/src/main.mjs",
    runtime: "openViewerRuntime",
    source: "DwgSceneCacheSource",
    sharedEntrypoint: true,
  });
}

const manifest = await readJson(manifestPath);
assert.equal(manifest.schema, "menaje-viewer-core-compatibility/1");
assert.equal(manifest.status, "public-preview");
assert.equal(manifest.distribution.published, true);
assert.equal(manifest.distribution.releaseStage, "prerelease");
assert.equal(
  typeof manifest.distribution.tagPublicationApproved,
  "boolean",
);
assert.equal(
  manifest.distribution.automaticStablePromotion,
  false,
);
assert.equal(
  manifest.qualification.viewerOwnedBoundary,
  "passed",
);
assert.equal(
  manifest.qualification.externalConsumers,
  "consumer-owned",
);

const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "dwg-viewer-boundary-"),
);
try {
  const firstArtifacts = path.join(temporaryRoot, "artifacts");
  const repeatedArtifacts = path.join(
    temporaryRoot,
    "artifacts-repeat",
  );
  const publicPackages = {};
  for (const definition of packageDefinitions) {
    publicPackages[definition.manifestKey] =
      await validatePublicPackageBoundary(definition, manifest);
  }
  const artifacts = await packArtifacts(
    firstArtifacts,
    manifest,
  );
  await packArtifacts(repeatedArtifacts, manifest);
  await assertReproducible(
    firstArtifacts,
    repeatedArtifacts,
    manifest,
  );
  const artifactOnlyConsumer = await qualifyArtifactConsumer(
    path.join(temporaryRoot, "consumer"),
    firstArtifacts,
    manifest,
  );
  const productEntrypoints = await validateProductEntrypoints();

  const report = Object.freeze({
    schema: "dwg-viewer-boundary-qualification/1",
    status: "passed-viewer-owned-boundary",
    asOf: manifest.asOf,
    scope: Object.freeze({
      repository: "menaje/2d-cad-viewer",
      externalConsumerQualification: "consumer-owned-not-executed",
      deploymentPerformed: false,
    }),
    releaseControl: Object.freeze({
      stage: manifest.distribution.releaseStage,
      tag: manifest.distribution.tag,
      tagPublicationApproved:
        manifest.distribution.tagPublicationApproved,
      automaticStablePromotion:
        manifest.distribution.automaticStablePromotion,
    }),
    publicPackages: Object.freeze(publicPackages),
    artifacts: Object.freeze(artifacts),
    artifactOnlyConsumer: Object.freeze(artifactOnlyConsumer),
    productEntrypoints,
  });

  if (!emitOnly) {
    assert.deepEqual(await readJson(evidencePath), report);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
