import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(extensionRoot, "..", "..");
const webviewRoot = path.join(repositoryRoot, "packages", "webview");
const mediaRoot = path.join(extensionRoot, "media", "webview");
const sourceOutput = path.join(mediaRoot, "src");

await rm(mediaRoot, { recursive: true, force: true });
await mkdir(sourceOutput, { recursive: true });

const shared = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: false,
  minify: false,
  logLevel: "warning",
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [path.join(webviewRoot, "src", "main.mjs")],
    outfile: path.join(sourceOutput, "main.mjs"),
  }),
  build({
    ...shared,
    entryPoints: [
      path.join(webviewRoot, "src", "emf-converter-runtime.mjs"),
    ],
    outfile: path.join(sourceOutput, "emf-converter-runtime.mjs"),
  }),
  build({
    ...shared,
    entryPoints: [
      path.join(
        webviewRoot,
        "qualification",
        "revision-comparison.mjs",
      ),
    ],
    outfile: path.join(
      sourceOutput,
      "revision-comparison-qualification.mjs",
    ),
  }),
  build({
    ...shared,
    entryPoints: [path.join(webviewRoot, "src", "hatch-worker.mjs")],
    outfile: path.join(sourceOutput, "hatch-worker.mjs"),
  }),
  build({
    ...shared,
    entryPoints: [path.join(webviewRoot, "src", "primitive-worker.mjs")],
    outfile: path.join(sourceOutput, "primitive-worker.mjs"),
  }),
  build({
    ...shared,
    entryPoints: [path.join(webviewRoot, "src", "curve-worker.mjs")],
    outfile: path.join(sourceOutput, "curve-worker.mjs"),
  }),
  build({
    ...shared,
    entryPoints: [
      path.join(webviewRoot, "src", "review-entity-worker.mjs"),
    ],
    outfile: path.join(sourceOutput, "review-entity-worker.mjs"),
  }),
  copyFile(
    path.join(webviewRoot, "styles.css"),
    path.join(mediaRoot, "styles.css"),
  ),
]);

const template = await readFile(path.join(webviewRoot, "index.html"), "utf8");
await writeFile(path.join(mediaRoot, "index.html"), template, "utf8");

for (const workerName of [
  "hatch-worker.mjs",
  "primitive-worker.mjs",
  "curve-worker.mjs",
  "review-entity-worker.mjs",
]) {
  const bundledWorker = await readFile(
    path.join(sourceOutput, workerName),
    "utf8",
  );
  if (/^\s*import\s/imu.test(bundledWorker)) {
    throw new Error(`${workerName} contains an unsupported static import`);
  }
}
