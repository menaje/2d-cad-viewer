// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  GPL_3_0_SHA256,
} from "../../../adapters/libredwg/package.mjs";

const extensionRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(extensionRoot, "..", "..");

test("declares a separate GPL workspace companion required by the MPL viewer", async () => {
  const [
    manifestText,
    mainManifestText,
    repositoryManifestText,
    license,
    readme,
    ignoreRules,
  ] = await Promise.all([
    readFile(path.join(extensionRoot, "package.json"), "utf8"),
    readFile(
      path.join(repositoryRoot, "apps", "vscode-extension", "package.json"),
      "utf8",
    ),
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    readFile(path.join(extensionRoot, "LICENSE.txt")),
    readFile(path.join(extensionRoot, "README.md"), "utf8"),
    readFile(path.join(extensionRoot, ".vscodeignore"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const mainManifest = JSON.parse(mainManifestText);
  const repositoryManifest = JSON.parse(repositoryManifestText);

  assert.equal(manifest.name, "dwg-viewer-libredwg");
  assert.equal(manifest.publisher, mainManifest.publisher);
  assert.equal(manifest.version, repositoryManifest.version);
  assert.equal(manifest.version, mainManifest.version);
  assert.equal(manifest.license, "GPL-3.0-or-later");
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.deepEqual(mainManifest.extensionDependencies, [
    `${manifest.publisher}.${manifest.name}`,
  ]);
  assert.equal(
    createHash("sha256").update(license).digest("hex"),
    GPL_3_0_SHA256,
  );
  assert.match(readme, /installs the matching engine automatically/iu);
  assert.match(readme, /complete corresponding source is under `source\/`/u);
  assert.match(readme, /separately from the MPL-2\.0 DWG Viewer VSIX/u);
  assert.doesNotMatch(readme, /무료/u);
  assert.doesNotMatch(readme, /(?:^|[^A-Za-z])free(?:[^A-Za-z]|$)/iu);
  assert.match(ignoreRules, /(?:^|\n)scripts\/\*\*(?:\n|$)/u);
});

test("staging pins source and both unmodified license texts", async () => {
  const source = await readFile(
    path.join(extensionRoot, "scripts", "prepare-package.mjs"),
    "utf8",
  );
  assert.match(source, /GPL_3_0_SHA256/u);
  assert.match(source, /LIBREDWG_SOURCE_SHA256/u);
  assert.match(source, /MPL_2_0_SHA256/u);
  assert.match(source, /corresponding_source: "included"/u);
  assert.match(source, /source package checksum mismatch/u);
  assert.match(source, /native\/\$\{target\}/u);
});

test("release automation publishes every GPL target before the MPL viewer", async () => {
  const [releaseWorkflow, qualificationWorkflow] = await Promise.all([
    readFile(
      path.join(repositoryRoot, ".github", "workflows", "release.yml"),
      "utf8",
    ),
    readFile(
      path.join(
        repositoryRoot,
        ".github",
        "workflows",
        "libredwg-adapter.yml",
      ),
      "utf8",
    ),
  ]);
  for (const target of ["linux-x64", "darwin-arm64", "win32-x64"]) {
    assert.match(releaseWorkflow, new RegExp(`target: ${target}`, "u"));
    assert.match(
      releaseWorkflow,
      new RegExp(`dwg-viewer-libredwg-\\$release_version-${target}\\.vsix`, "u"),
    );
  }
  assert.match(releaseWorkflow, /publish_marketplace:/u);
  assert.match(releaseWorkflow, /--pre-release/u);
  assert.ok(
    releaseWorkflow.indexOf("for target in linux-x64 darwin-arm64 win32-x64") <
      releaseWorkflow.indexOf(
        "pnpm --dir apps/vscode-extension exec vsce publish",
      ),
  );
  assert.match(
    qualificationWorkflow,
    /--companion-vsix \$companionVsixPath/u,
  );
});
