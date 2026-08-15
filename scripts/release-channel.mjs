import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const VIEWER_PACKAGE_PROMOTION_PATHS = Object.freeze([
  /^compatibility\/README\.md$/u,
  /^compatibility\/viewer-core\.json$/u,
  /^compatibility\/evidence\/viewer-boundary-\d+\.\d+\.\d+-\d{4}-\d{2}-\d{2}\.json$/u,
  /^docs\/architecture\.md$/u,
  /^docs\/distribution\.md$/u,
  /^docs\/licensing\.md$/u,
  /^docs\/adr\/ADR-0001-viewer-core-boundary\.md$/u,
  /^packages\/(?:render-protocol|viewer-core|viewer-ui)\//u,
  /^packages\/(?:dwg-scene-source|webview)\/package\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^scripts\/qualify-viewer-boundary\.mjs$/u,
  /^scripts\/release-channel(?:\.test)?\.mjs$/u,
]);

export function parseVersion(value) {
  const match = VERSION_PATTERN.exec(value ?? "");
  if (!match) {
    throw new Error(`release version must use major.minor.patch: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    value,
  };
}

export function compareVersions(left, right) {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function validateAlignedVersions(versions) {
  const entries = Object.entries(versions);
  if (entries.length === 0) {
    throw new Error("no release versions were provided");
  }
  for (const [, version] of entries) {
    parseVersion(version);
  }
  const expected = entries[0][1];
  const mismatch = entries.find(([, version]) => version !== expected);
  if (mismatch) {
    throw new Error(
      `repository and product extension versions differ: ${entries
        .map(([name, version]) => `${name}=${version}`)
        .join(", ")}`,
    );
  }
  return expected;
}

export function latestVersion(versions) {
  if (versions.length === 0) {
    return undefined;
  }
  return [...versions].sort(compareVersions).at(-1);
}

export function validateViewerPackagePromotion({
  changedPaths,
  compatibility,
  packageVersions,
  priorPackageVersions = [],
}) {
  if (
    changedPaths.length === 0 ||
    changedPaths.some(
      (changedPath) =>
        !VIEWER_PACKAGE_PROMOTION_PATHS.some((pattern) =>
          pattern.test(changedPath),
        ),
    )
  ) {
    return false;
  }

  const version = validateAlignedVersions(packageVersions);
  const expectedVersions = {
    viewerCore: version,
    renderProtocol: version,
    viewerUi: version,
  };
  assertExactVersions(
    compatibility.distribution?.packageVersions,
    expectedVersions,
    "Viewer package distribution versions must match package manifests",
  );
  assertExactVersions(
    {
      viewerCore: compatibility.viewerCore?.version,
      renderProtocol: compatibility.renderProtocol?.version,
      viewerUi: compatibility.viewerUi?.version,
    },
    expectedVersions,
    "Viewer package compatibility versions must match package manifests",
  );
  if (compatibility.distribution?.published !== true) {
    throw new Error(
      "Viewer package promotion must target a published distribution",
    );
  }
  if (compatibility.distribution?.releaseStage !== "prerelease") {
    throw new Error("Viewer package promotion must target the prerelease stage");
  }
  if (compatibility.distribution?.tagPublicationApproved !== true) {
    throw new Error(
      "Viewer package promotion requires explicit tag publication approval",
    );
  }
  if (
    compatibility.distribution?.tag !== `viewer-core-v${version}`
  ) {
    throw new Error(
      `Viewer package tag must be viewer-core-v${version}`,
    );
  }
  for (const [artifactName, artifact] of Object.entries(
    compatibility.distribution?.artifacts ?? {},
  )) {
    if (!artifact.file?.endsWith(`-${version}.tgz`)) {
      throw new Error(
        `Viewer package artifact ${artifactName} does not match ${version}`,
      );
    }
  }
  if (
    Object.keys(compatibility.distribution?.artifacts ?? {}).length !== 3
  ) {
    throw new Error(
      "Viewer package promotion requires exactly three artifacts",
    );
  }

  const previous = latestVersion(priorPackageVersions);
  if (previous && compareVersions(version, previous) <= 0) {
    throw new Error(
      `Viewer package version ${version} must be greater than existing tag viewer-core-v${previous}`,
    );
  }
  return true;
}

function assertExactVersions(actual, expected, message) {
  const expectedEntries = Object.entries(expected);
  if (
    !actual ||
    Object.keys(actual).length !== expectedEntries.length ||
    expectedEntries.some(([key, value]) => actual[key] !== value)
  ) {
    throw new Error(message);
  }
}

export function determineReleaseChannel({
  eventName,
  payload,
  repository,
  version,
  priorVersions = [],
  existingVersionSha,
  manualMode = "dry-run",
  fallbackSha,
  viewerPackagePromotion = false,
}) {
  const parsedVersion = parseVersion(version);

  if (eventName === "workflow_dispatch") {
    if (!new Set(["dry-run", "verify-auth"]).has(manualMode)) {
      throw new Error(`unsupported manual release mode: ${manualMode}`);
    }
    return {
      build: manualMode === "dry-run",
      channel: manualMode,
      prerelease: false,
      publish: false,
      releaseSha: fallbackSha,
      version,
    };
  }

  if (eventName !== "pull_request") {
    throw new Error(`unsupported release event: ${eventName}`);
  }

  const pullRequest = payload.pull_request;
  if (!pullRequest) {
    throw new Error("pull_request payload is required");
  }
  if (payload.action === "closed" && pullRequest.merged !== true) {
    throw new Error("a closed pull request must be merged before release");
  }
  if (pullRequest.head?.repo?.full_name !== repository) {
    throw new Error("release pull requests must originate in this repository");
  }

  const base = pullRequest.base?.ref;
  const head = pullRequest.head?.ref;
  let channel;
  let publish;

  if (base === "prerelease" && head === "dev") {
    if (parsedVersion.minor % 2 === 1) {
      channel = "prerelease";
      publish = true;
    } else {
      channel = "stable-preparation";
      publish = false;
    }
  } else if (base === "main" && head === "prerelease") {
    if (parsedVersion.minor % 2 !== 0) {
      throw new Error(
        `stable releases require an even minor version, received ${version}`,
      );
    }
    channel = "stable";
    publish = true;
  } else {
    throw new Error(
      `invalid release route: ${head ?? "unknown"} -> ${base ?? "unknown"}`,
    );
  }

  const releaseSha =
    payload.action === "closed"
      ? pullRequest.merge_commit_sha
      : pullRequest.head?.sha;
  if (!releaseSha) {
    throw new Error("release commit SHA is missing from the pull request");
  }

  const previous = latestVersion(priorVersions);
  const comparison = previous ? compareVersions(version, previous) : 1;
  if (
    base === "prerelease" &&
    head === "dev" &&
    comparison === 0 &&
    viewerPackagePromotion
  ) {
    return {
      build: false,
      channel: "viewer-package-promotion",
      prerelease: false,
      publish: false,
      releaseSha,
      version,
    };
  }
  const isSafeRetry =
    comparison === 0 &&
    payload.action === "closed" &&
    existingVersionSha === releaseSha;
  if (comparison < 0 || (comparison === 0 && !isSafeRetry)) {
    throw new Error(
      `release version ${version} must be greater than existing product tag v${previous}`,
    );
  }

  return {
    build: true,
    channel,
    prerelease: channel === "prerelease",
    publish,
    releaseSha,
    version,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readRepositoryVersions(root) {
  return {
    repository: readJson(resolve(root, "package.json")).version,
    viewer: readJson(resolve(root, "apps/vscode-extension/package.json")).version,
  };
}

function readViewerPackageVersions(root) {
  return {
    viewerCore: readJson(
      resolve(root, "packages/viewer-core/package.json"),
    ).version,
    renderProtocol: readJson(
      resolve(root, "packages/render-protocol/package.json"),
    ).version,
    viewerUi: readJson(
      resolve(root, "packages/viewer-ui/package.json"),
    ).version,
  };
}

function readProductTagVersions() {
  const tags = execFileSync("git", ["tag", "--list", "v[0-9]*"], {
    encoding: "utf8",
  });
  return tags
    .split(/\r?\n/u)
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/u.test(tag))
    .map((tag) => tag.slice(1));
}

function readViewerPackageTagVersions() {
  const tags = execFileSync(
    "git",
    ["tag", "--list", "viewer-core-v[0-9]*"],
    { encoding: "utf8" },
  );
  return tags
    .split(/\r?\n/u)
    .map((tag) => tag.trim())
    .filter((tag) => /^viewer-core-v\d+\.\d+\.\d+$/u.test(tag))
    .map((tag) => tag.slice("viewer-core-v".length));
}

function readPullRequestChangedPaths(payload) {
  const pullRequest = payload.pull_request;
  if (!pullRequest) {
    return [];
  }
  const releaseSha =
    payload.action === "closed"
      ? pullRequest.merge_commit_sha
      : pullRequest.head?.sha;
  const baseSha = pullRequest.base?.sha;
  if (!baseSha || !releaseSha) {
    throw new Error("pull request base and release commit SHAs are required");
  }
  return execFileSync(
    "git",
    ["diff", "--name-only", baseSha, releaseSha],
    { encoding: "utf8" },
  )
    .split(/\r?\n/u)
    .map((changedPath) => changedPath.trim())
    .filter(Boolean);
}

function readTagCommit(version) {
  try {
    return execFileSync("git", ["rev-list", "-n", "1", `v${version}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function writeOutputs(path, result) {
  const output = [
    `build=${result.build}`,
    `channel=${result.channel}`,
    `prerelease=${result.prerelease}`,
    `publish=${result.publish}`,
    `release_sha=${result.releaseSha ?? ""}`,
    `version=${result.version}`,
  ].join("\n");
  appendFileSync(path, `${output}\n`);
}

function writeSummary(path, result) {
  if (!path) {
    return;
  }
  appendFileSync(
    path,
    [
      "## Release route",
      "",
      `- Channel: \`${result.channel}\``,
      `- Version: \`${result.version}\``,
      `- Build release artifacts: \`${result.build}\``,
      `- Publish: \`${result.publish}\``,
      "",
    ].join("\n"),
  );
}

function main() {
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const version = validateAlignedVersions(readRepositoryVersions(process.cwd()));
  const viewerPackagePromotion =
    process.env.GITHUB_EVENT_NAME === "pull_request" &&
    validateViewerPackagePromotion({
      changedPaths: readPullRequestChangedPaths(payload),
      compatibility: readJson(
        resolve(process.cwd(), "compatibility/viewer-core.json"),
      ),
      packageVersions: readViewerPackageVersions(process.cwd()),
      priorPackageVersions: readViewerPackageTagVersions(),
    });
  const result = determineReleaseChannel({
    eventName: process.env.GITHUB_EVENT_NAME,
    existingVersionSha: readTagCommit(version),
    fallbackSha: process.env.GITHUB_SHA,
    manualMode: process.env.RELEASE_MANUAL_MODE || "dry-run",
    payload,
    priorVersions: readProductTagVersions(),
    repository: process.env.GITHUB_REPOSITORY,
    version,
    viewerPackagePromotion,
  });
  writeOutputs(process.env.GITHUB_OUTPUT, result);
  writeSummary(process.env.GITHUB_STEP_SUMMARY, result);
  process.stdout.write(
    `release route: ${result.channel} ${result.version} publish=${result.publish}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
