import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const MODULE_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

async function collectModulePaths(rootPath) {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await collectModulePaths(entryPath)));
    } else if (entry.isFile() && MODULE_EXTENSIONS.has(path.extname(entry.name))) {
      paths.push(entryPath);
    }
  }
  return paths;
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  process.stderr.write("usage: node check-module-syntax.mjs DIRECTORY...\n");
  process.exitCode = 2;
} else {
  const modulePaths = [];
  for (const root of roots) {
    modulePaths.push(...(await collectModulePaths(path.resolve(root))));
  }
  if (modulePaths.length === 0) {
    throw new Error("no JavaScript modules found for syntax checking");
  }
  for (const modulePath of modulePaths) {
    const result = spawnSync(process.execPath, ["--check", modulePath], {
      stdio: "inherit",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
