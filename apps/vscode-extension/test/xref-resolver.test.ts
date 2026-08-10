import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizePortablePath,
  resolveXrefPath,
  xrefBasename,
  xrefExactMappingKey,
} from "../src/xref-resolver";

async function withFixture(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-xref-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("normalizes Windows, UNC, and relative paths without host assumptions", () => {
  assert.equal(
    normalizePortablePath(String.raw`C:\project\drawings\..\xref\a.dwg`),
    "C:/project/xref/a.dwg",
  );
  assert.equal(
    normalizePortablePath(String.raw`\\server\share\한글\a.dwg`),
    "//server/share/한글/a.dwg",
  );
  assert.equal(normalizePortablePath(String.raw`.\xref\a.dwg`), "xref/a.dwg");
  assert.equal(
    normalizePortablePath(String.raw`..\shared\..\xref\a.dwg`),
    "../xref/a.dwg",
  );
  assert.equal(normalizePortablePath("C:project/a.dwg"), "C:project/a.dwg");
  assert.equal(xrefBasename(String.raw`.\xref\A`), "a.dwg");
});

test("uses the drawing-relative path before searching", async () => {
  await withFixture(async (root) => {
    const drawing = path.join(root, "A-112.dwg");
    const target = path.join(root, "xref", "1F.dwg");
    await mkdir(path.dirname(target), { recursive: true });
    await Promise.all([writeFile(drawing, ""), writeFile(target, "")]);

    const result = await resolveXrefPath({
      drawingPath: drawing,
      storedPath: String.raw`.\xref\1F.dwg`,
    });

    assert.equal(result.status, "resolved");
    assert.equal(result.status === "resolved" && result.method, "relative");
    assert.equal(result.status === "resolved" && result.path, target);
  });
});

test("preserves a leading parent segment in a drawing-relative path", async () => {
  await withFixture(async (root) => {
    const drawing = path.join(root, "drawings", "A-112.dwg");
    const target = path.join(root, "xref", "1F.dwg");
    await Promise.all([
      mkdir(path.dirname(drawing), { recursive: true }),
      mkdir(path.dirname(target), { recursive: true }),
    ]);
    await Promise.all([writeFile(drawing, ""), writeFile(target, "")]);

    const result = await resolveXrefPath({
      drawingPath: drawing,
      storedPath: String.raw`..\xref\1F.dwg`,
    });

    assert.equal(result.status, "resolved");
    assert.equal(result.status === "resolved" && result.method, "relative");
    assert.equal(result.status === "resolved" && result.path, target);
  });
});

test("uses an adjacent xref folder before a recursive workspace scan", async () => {
  await withFixture(async (root) => {
    const drawing = path.join(root, "drawings", "A-112.dwg");
    const target = path.join(root, "drawings", "xref", "2F.dwg");
    await Promise.all([
      mkdir(path.dirname(drawing), { recursive: true }),
      mkdir(path.dirname(target), { recursive: true }),
    ]);
    await Promise.all([writeFile(drawing, ""), writeFile(target, "")]);

    const result = await resolveXrefPath({
      drawingPath: drawing,
      storedPath: String.raw`\\old-server\share\project\2F.dwg`,
      searchRoots: [root],
      maximumEntries: 1,
    });

    assert.equal(result.status, "resolved");
    assert.equal(result.status === "resolved" && result.method, "search");
    assert.equal(result.status === "resolved" && result.path, target);
    assert.equal(result.searchTruncated, false);
  });
});

test("ranks filename, parent, then grandparent matches", async () => {
  await withFixture(async (root) => {
    const drawing = path.join(root, "drawings", "A-112.dwg");
    const weak = path.join(root, "other", "2F.dwg");
    const strong = path.join(root, "project", "xref", "2F.dwg");
    await Promise.all([
      mkdir(path.dirname(drawing), { recursive: true }),
      mkdir(path.dirname(weak), { recursive: true }),
      mkdir(path.dirname(strong), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(drawing, ""),
      writeFile(weak, ""),
      writeFile(strong, ""),
    ]);

    const result = await resolveXrefPath({
      drawingPath: drawing,
      storedPath: String.raw`\\old-server\share\project\xref\2F.dwg`,
      searchRoots: [root],
    });

    assert.equal(result.status, "resolved");
    assert.equal(result.status === "resolved" && result.method, "search");
    assert.equal(result.status === "resolved" && result.path, strong);
  });
});

test("does not silently choose equally ranked files", async () => {
  await withFixture(async (root) => {
    const drawing = path.join(root, "A-112.dwg");
    const first = path.join(root, "a", "xref", "RF.dwg");
    const second = path.join(root, "b", "xref", "RF.dwg");
    await Promise.all([
      mkdir(path.dirname(first), { recursive: true }),
      mkdir(path.dirname(second), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(drawing, ""),
      writeFile(first, ""),
      writeFile(second, ""),
    ]);

    const result = await resolveXrefPath({
      drawingPath: drawing,
      storedPath: String.raw`\\old\share\xref\RF.dwg`,
      searchRoots: [root],
    });

    assert.equal(result.status, "ambiguous");
    assert.equal(result.candidates.length, 2);
  });
});

test("deduplicates aliases of the same physical search directory", async () => {
  await withFixture(async (root) => {
    const drawing = path.join(root, "drawings", "A-112.dwg");
    const physicalRoot = path.join(root, "physical");
    const aliasRoot = path.join(root, "alias");
    const target = path.join(
      physicalRoot,
      "nested",
      "HARDWARE",
      "hinge.jpg",
    );
    await Promise.all([
      mkdir(path.dirname(drawing), { recursive: true }),
      mkdir(path.dirname(target), { recursive: true }),
    ]);
    await Promise.all([writeFile(drawing, ""), writeFile(target, "")]);
    await symlink(
      physicalRoot,
      aliasRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await resolveXrefPath({
      drawingPath: drawing,
      storedPath: "hinge.jpg",
      searchRoots: [aliasRoot, physicalRoot],
    });

    assert.equal(result.status, "resolved");
    assert.equal(result.status === "resolved" && result.method, "search");
    assert.equal(
      result.status === "resolved" && (await realpath(result.path)),
      await realpath(target),
    );
    assert.equal(result.candidates.length, 1);
  });
});

test("an explicit per-reference mapping overrides automatic matches", async () => {
  await withFixture(async (root) => {
    const drawing = path.join(root, "A-112.dwg");
    const mapped = path.join(root, "manual", "2F.dwg");
    await mkdir(path.dirname(mapped), { recursive: true });
    await Promise.all([writeFile(drawing, ""), writeFile(mapped, "")]);
    const storedPath = String.raw`\\old\share\xref\2F.dwg`;

    const result = await resolveXrefPath({
      drawingPath: drawing,
      storedPath,
      mappings: {
        exact: {
          [xrefExactMappingKey(drawing, storedPath)]: mapped,
        },
      },
    });

    assert.equal(result.status, "resolved");
    assert.equal(
      result.status === "resolved" && result.method,
      "manual-exact",
    );
    assert.equal(result.status === "resolved" && result.path, mapped);
  });
});

test("an explicit per-reference mapping can recover an empty stored path", async () => {
  await withFixture(async (root) => {
    const drawing = path.join(root, "A-112.dwg");
    const mapped = path.join(root, "manual", "scan.png");
    await mkdir(path.dirname(mapped), { recursive: true });
    await Promise.all([writeFile(drawing, ""), writeFile(mapped, "")]);

    const result = await resolveXrefPath({
      drawingPath: drawing,
      storedPath: "",
      mappings: {
        exact: {
          [xrefExactMappingKey(drawing, "")]: mapped,
        },
      },
    });

    assert.equal(result.status, "resolved");
    assert.equal(
      result.status === "resolved" && result.method,
      "manual-exact",
    );
    assert.equal(result.status === "resolved" && result.path, mapped);
  });
});
