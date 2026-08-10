import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(extensionRoot, "..", "..");
const engineCatalogSource =
  process.env.DWG_VIEWER_ENGINE_CATALOG?.trim();
const engineCatalogDestination = path.join(
  extensionRoot,
  "dist",
  "engine-assets.json",
);

await mkdir(path.dirname(engineCatalogDestination), {
  recursive: true,
  mode: 0o700,
});
if (engineCatalogSource) {
  if (!path.isAbsolute(engineCatalogSource)) {
    throw new Error("DWG_VIEWER_ENGINE_CATALOG must be an absolute path");
  }
  await copyFile(engineCatalogSource, engineCatalogDestination);
} else {
  await rm(engineCatalogDestination, { force: true });
}

await Promise.all([
  copyFile(
    path.join(repositoryRoot, "LICENSE"),
    path.join(extensionRoot, "LICENSE"),
  ),
  copyFile(
    path.join(repositoryRoot, "NOTICE"),
    path.join(extensionRoot, "NOTICE"),
  ),
  copyFile(
    path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"),
    path.join(extensionRoot, "THIRD_PARTY_NOTICES.md"),
  ),
]);
