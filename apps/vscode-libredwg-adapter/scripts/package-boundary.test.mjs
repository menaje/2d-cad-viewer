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

test("keeps the historical GPL package only as a qualification fixture", async () => {
  const [
    manifestText,
    mainManifestText,
    license,
    readme,
    ignoreRules,
  ] = await Promise.all([
    readFile(path.join(extensionRoot, "package.json"), "utf8"),
    readFile(
      path.join(repositoryRoot, "apps", "vscode-extension", "package.json"),
      "utf8",
    ),
    readFile(path.join(extensionRoot, "LICENSE.txt")),
    readFile(path.join(extensionRoot, "README.md"), "utf8"),
    readFile(path.join(extensionRoot, ".vscodeignore"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const mainManifest = JSON.parse(mainManifestText);

  assert.equal(manifest.name, "dwg-viewer-libredwg");
  assert.equal(manifest.publisher, mainManifest.publisher);
  assert.equal(manifest.version, mainManifest.version);
  assert.equal(manifest.license, "GPL-3.0-or-later");
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(mainManifest.extensionDependencies, undefined);
  assert.equal(
    createHash("sha256").update(license).digest("hex"),
    GPL_3_0_SHA256,
  );
  assert.match(readme, /retained for offline and extension-host qualification/iu);
  assert.match(readme, /not a current Marketplace\s+product/iu);
  assert.match(readme, /complete corresponding source is under `source\/`/iu);
  assert.match(readme, /separate from the MPL-2\.0 DWG Viewer VSIX/u);
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

test("release automation publishes raw GPL targets before the single Marketplace viewer", async () => {
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
  for (const target of [
    "linux-x64",
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
  ]) {
    assert.match(releaseWorkflow, new RegExp(`target: ${target}`, "u"));
    assert.match(
      releaseWorkflow,
      new RegExp(
        `dwg-viewer-native-converter-\\$release_version-${target}${
          target === "win32-x64" ? "\\.exe" : ""
        }`,
        "u",
      ),
    );
    assert.match(
      releaseWorkflow,
      new RegExp(`dwg-viewer-libredwg-0\\.14-${target}\\.tar\\.gz`, "u"),
    );
  }
  assert.match(releaseWorkflow, /^  marketplace:/mu);
  assert.match(releaseWorkflow, /needs\.context\.outputs\.publish == 'true'/u);
  assert.match(releaseWorkflow, /node scripts\/create-engine-catalog\.mjs/u);
  assert.match(releaseWorkflow, /DWG_VIEWER_ENGINE_CATALOG="\$catalog_path"/u);
  assert.match(
    releaseWorkflow,
    /marketplace:[\s\S]*needs:[\s\S]*- github-release[\s\S]*Publish the MPL viewer/u,
  );
  assert.match(
    releaseWorkflow,
    /github-release:[\s\S]*"dist\/SHA256SUMS"/u,
  );
  assert.doesNotMatch(
    releaseWorkflow,
    /apps\/vscode-libredwg-adapter exec vsce publish/u,
  );
  assert.doesNotMatch(releaseWorkflow, /--clobber/u);
  assert.match(
    releaseWorkflow,
    /asset \$name is immutable and has different bytes/u,
  );
  assert.equal(
    (releaseWorkflow.match(/exec vsce publish/gu) ?? []).length,
    1,
  );
  assert.match(
    qualificationWorkflow,
    /--companion-vsix \$companionVsixPath/u,
  );
});
