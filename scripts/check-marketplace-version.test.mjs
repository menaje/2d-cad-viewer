import assert from "node:assert/strict";
import test from "node:test";

import { analyzeMarketplaceVersion } from "./check-marketplace-version.mjs";

function responseFor(versions) {
  return {
    results: [
      {
        extensions: [
          {
            extensionName: "dwg-viewer-libredwg",
            publisher: { publisherName: "menaje" },
            versions,
          },
        ],
      },
    ],
  };
}

function version(versionValue, targetPlatform, prerelease) {
  return {
    properties: prerelease
      ? [
          {
            key: "Microsoft.VisualStudio.Code.PreRelease",
            value: "true",
          },
        ]
      : [],
    targetPlatform,
    version: versionValue,
  };
}

test("allows an unpublished Marketplace version", () => {
  assert.deepEqual(
    analyzeMarketplaceVersion(
      { results: [{ extensions: [] }] },
      "menaje.dwg-viewer-vscode",
      "0.1.3",
      "prerelease",
    ),
    { existingTargets: [], exists: false },
  );
});

test("recognizes idempotent platform prerelease publication", () => {
  assert.deepEqual(
    analyzeMarketplaceVersion(
      responseFor([
        version("0.1.3", "linux-x64", true),
        version("0.1.3", "darwin-arm64", true),
        version("0.1.3", "darwin-x64", true),
        version("0.1.2", "win32-x64", true),
      ]),
      "menaje.dwg-viewer-libredwg",
      "0.1.3",
      "prerelease",
    ),
    {
      existingTargets: ["linux-x64", "darwin-arm64", "darwin-x64"],
      exists: true,
    },
  );
});

test("rejects reuse of a prerelease version for stable publication", () => {
  assert.throws(
    () =>
      analyzeMarketplaceVersion(
        responseFor([version("0.1.3", undefined, true)]),
        "menaje.dwg-viewer-libredwg",
        "0.1.3",
        "stable",
      ),
    /already exists in the prerelease channel/u,
  );
});

test("rejects reuse of a stable version for prerelease publication", () => {
  assert.throws(
    () =>
      analyzeMarketplaceVersion(
        responseFor([version("0.2.0", undefined, false)]),
        "menaje.dwg-viewer-libredwg",
        "0.2.0",
        "prerelease",
      ),
    /already exists in the stable channel/u,
  );
});
