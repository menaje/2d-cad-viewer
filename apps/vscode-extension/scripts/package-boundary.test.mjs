// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const extensionRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(extensionRoot, "..", "..");
const MPL_2_0_SHA256 =
  "3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04";

test("keeps the MPL VSIX and GPL adapter distribution boundaries explicit", async () => {
  const [
    manifestText,
    repositoryManifestText,
    ignoreRules,
    readme,
    repositoryReadme,
    packagedLicense,
    repositoryLicense,
    packagedNotice,
    repositoryNotice,
    packagedNotices,
    repositoryNotices,
    shxLicense,
    earcutLicense,
    marketplaceIcon,
  ] = await Promise.all([
    readFile(path.join(extensionRoot, "package.json"), "utf8"),
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    readFile(path.join(extensionRoot, ".vscodeignore"), "utf8"),
    readFile(path.join(extensionRoot, "README.md"), "utf8"),
    readFile(path.join(repositoryRoot, "README.md"), "utf8"),
    readFile(path.join(extensionRoot, "LICENSE")),
    readFile(path.join(repositoryRoot, "LICENSE")),
    readFile(path.join(extensionRoot, "NOTICE"), "utf8"),
    readFile(path.join(repositoryRoot, "NOTICE"), "utf8"),
    readFile(
      path.join(extensionRoot, "THIRD_PARTY_NOTICES.md"),
      "utf8",
    ),
    readFile(path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8"),
    readFile(
      path.join(
        repositoryRoot,
        "packages",
        "webview",
        "node_modules",
        "@mlightcad",
        "shx-parser",
        "LICENSE",
      ),
      "utf8",
    ),
    readFile(
      path.join(
        repositoryRoot,
        "packages",
        "webview",
        "node_modules",
        "earcut",
        "LICENSE",
      ),
      "utf8",
    ),
    readFile(path.join(extensionRoot, "images", "icon.png")),
  ]);
  const manifest = JSON.parse(manifestText);
  const repositoryManifest = JSON.parse(repositoryManifestText);

  assert.equal(manifest.displayName, "Coni DWG Viewer");
  assert.equal(manifest.license, "MPL-2.0");
  assert.equal(manifest.icon, "images/icon.png");
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.deepEqual(manifest.extensionDependencies, [
    "menaje.dwg-viewer-libredwg",
  ]);
  assert.deepEqual(
    [...marketplaceIcon.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.equal(marketplaceIcon.readUInt32BE(16), 256);
  assert.equal(marketplaceIcon.readUInt32BE(20), 256);
  assert.equal(
    manifest.repository?.url,
    "https://github.com/menaje/dwg-viewer.git",
  );
  assert.match(ignoreRules, /(?:^|\n)native\/\*\*(?:\n|$)/u);
  assert.match(
    readme,
    /complete source form[\s\S]*menaje\/dwg-viewer repository/u,
  );
  assert.match(
    readme,
    /GPL-3\.0-or-later LibreDWG adapter is never included in the MPL VSIX/u,
  );
  assert.deepEqual(packagedLicense, repositoryLicense);
  assert.equal(
    createHash("sha256").update(repositoryLicense).digest("hex"),
    MPL_2_0_SHA256,
  );
  assert.equal(packagedNotice, repositoryNotice);
  assert.match(
    repositoryNotice,
    /Copyright 2026 dwg-viewer contributors/u,
  );
  assert.equal(packagedNotices, repositoryNotices);
  assert.equal(
    packagedNotices.split(shxLicense.trimEnd()).length,
    2,
  );
  assert.equal(
    packagedNotices.split(earcutLicense.trimEnd()).length,
    2,
  );
  assert.match(repositoryReadme, /오픈소스/u);
  assert.match(readme, /open-source/iu);
  assert.match(repositoryManifest.description, /open-source/iu);
  assert.match(manifest.description, /open-source/iu);
  for (const marketingText of [
    repositoryReadme,
    readme,
    repositoryManifest.description,
    manifest.description,
  ]) {
    assert.doesNotMatch(marketingText, /무료/u);
    assert.doesNotMatch(marketingText, /(?:^|[^A-Za-z])free(?:[^A-Za-z]|$)/iu);
  }
  assert.match(packagedNotices, /Copyright \(c\) 2024 mlight-lee/u);
  assert.match(
    packagedNotices,
    /Permission is hereby granted, free of charge/u,
  );
  assert.match(packagedNotices, /Copyright \(c\) 2026, Mapbox/u);
  assert.match(
    packagedNotices,
    /Permission to use, copy, modify, and\/or distribute/u,
  );
});
