import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

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

export function determineReleaseChannel({
  eventName,
  payload,
  repository,
  version,
  priorVersions = [],
  existingVersionSha,
  manualMode = "dry-run",
  fallbackSha,
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
  const result = determineReleaseChannel({
    eventName: process.env.GITHUB_EVENT_NAME,
    existingVersionSha: readTagCommit(version),
    fallbackSha: process.env.GITHUB_SHA,
    manualMode: process.env.RELEASE_MANUAL_MODE || "dry-run",
    payload,
    priorVersions: readProductTagVersions(),
    repository: process.env.GITHUB_REPOSITORY,
    version,
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
