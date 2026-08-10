import assert from "node:assert/strict";
import test from "node:test";

import {
  compareVersions,
  determineReleaseChannel,
  latestVersion,
  parseVersion,
  validateAlignedVersions,
} from "./release-channel.mjs";

function pullRequestPayload({
  action = "synchronize",
  base,
  head,
  headRepository = "menaje/dwg-viewer",
  merged = false,
}) {
  return {
    action,
    pull_request: {
      base: { ref: base },
      head: {
        ref: head,
        repo: { full_name: headRepository },
        sha: "1111111111111111111111111111111111111111",
      },
      merge_commit_sha: "2222222222222222222222222222222222222222",
      merged,
    },
  };
}

const common = {
  eventName: "pull_request",
  priorVersions: ["0.1.2"],
  repository: "menaje/dwg-viewer",
};

test("parses and orders numeric Marketplace versions", () => {
  assert.deepEqual(parseVersion("1.23.4"), {
    major: 1,
    minor: 23,
    patch: 4,
    value: "1.23.4",
  });
  assert.equal(compareVersions("0.9.9", "0.10.0") < 0, true);
  assert.equal(latestVersion(["0.2.0", "0.1.9", "1.0.0"]), "1.0.0");
  assert.throws(() => parseVersion("0.2.0-beta.1"), /major\.minor\.patch/u);
});

test("requires aligned repository and extension versions", () => {
  assert.equal(
    validateAlignedVersions({ repository: "0.1.3", viewer: "0.1.3" }),
    "0.1.3",
  );
  assert.throws(
    () =>
      validateAlignedVersions({
        companion: "0.1.2",
        repository: "0.1.3",
        viewer: "0.1.3",
      }),
    /versions differ/u,
  );
});

test("routes an odd-minor dev merge to prerelease publication", () => {
  const result = determineReleaseChannel({
    ...common,
    payload: pullRequestPayload({ base: "prerelease", head: "dev" }),
    version: "0.1.3",
  });
  assert.equal(result.channel, "prerelease");
  assert.equal(result.publish, true);
  assert.equal(result.prerelease, true);
});

test("routes an even-minor dev merge to stable preparation only", () => {
  const result = determineReleaseChannel({
    ...common,
    payload: pullRequestPayload({ base: "prerelease", head: "dev" }),
    version: "0.2.0",
  });
  assert.equal(result.channel, "stable-preparation");
  assert.equal(result.publish, false);
});

test("routes an even-minor prerelease merge to a stable release", () => {
  const result = determineReleaseChannel({
    ...common,
    payload: pullRequestPayload({
      action: "closed",
      base: "main",
      head: "prerelease",
      merged: true,
    }),
    version: "0.2.0",
  });
  assert.equal(result.channel, "stable");
  assert.equal(result.publish, true);
  assert.equal(
    result.releaseSha,
    "2222222222222222222222222222222222222222",
  );
});

test("rejects odd-minor stable releases and invalid branch routes", () => {
  assert.throws(
    () =>
      determineReleaseChannel({
        ...common,
        payload: pullRequestPayload({ base: "main", head: "prerelease" }),
        version: "0.3.0",
      }),
    /even minor/u,
  );
  assert.throws(
    () =>
      determineReleaseChannel({
        ...common,
        payload: pullRequestPayload({ base: "main", head: "dev" }),
        version: "0.2.0",
      }),
    /invalid release route/u,
  );
});

test("rejects fork routes, unmerged release events, and reused versions", () => {
  assert.throws(
    () =>
      determineReleaseChannel({
        ...common,
        payload: pullRequestPayload({
          base: "prerelease",
          head: "dev",
          headRepository: "outside/fork",
        }),
        version: "0.1.3",
      }),
    /this repository/u,
  );
  assert.throws(
    () =>
      determineReleaseChannel({
        ...common,
        payload: pullRequestPayload({
          action: "closed",
          base: "prerelease",
          head: "dev",
        }),
        version: "0.1.3",
      }),
    /must be merged/u,
  );
  assert.throws(
    () =>
      determineReleaseChannel({
        ...common,
        payload: pullRequestPayload({ base: "prerelease", head: "dev" }),
        version: "0.1.2",
      }),
    /must be greater/u,
  );
});

test("allows a closed-event retry only when its existing tag targets the merge", () => {
  const payload = pullRequestPayload({
    action: "closed",
    base: "prerelease",
    head: "dev",
    merged: true,
  });
  const result = determineReleaseChannel({
    ...common,
    existingVersionSha: "2222222222222222222222222222222222222222",
    payload,
    priorVersions: ["0.1.3"],
    version: "0.1.3",
  });
  assert.equal(result.publish, true);
  assert.throws(
    () =>
      determineReleaseChannel({
        ...common,
        existingVersionSha: "4444444444444444444444444444444444444444",
        payload,
        priorVersions: ["0.1.3"],
        version: "0.1.3",
      }),
    /must be greater/u,
  );
});

test("manual authentication verification does not build or publish", () => {
  const result = determineReleaseChannel({
    eventName: "workflow_dispatch",
    fallbackSha: "3333333333333333333333333333333333333333",
    manualMode: "verify-auth",
    payload: {},
    repository: "menaje/dwg-viewer",
    version: "0.1.2",
  });
  assert.equal(result.build, false);
  assert.equal(result.channel, "verify-auth");
  assert.equal(result.publish, false);
});
