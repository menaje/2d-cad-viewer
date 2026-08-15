// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createAutoCadXrefScript,
  parseAutoCadXrefArguments,
  parseAutoCadXrefLog,
} from "./qualify-reference-xref-matrix.mjs";

function argumentsFor(overrides = {}) {
  const values = {
    adapter: "adapter.exe",
    autocad: "acad.exe",
    caseId: "xref-state-matrix",
    child: "child.dwg",
    host: "host.dwg",
    observedAt: "2026-08-12T12:00:00Z",
    output: "xref-output",
    xrefName: "DWGV_XREF",
    ...overrides,
  };
  return [
    "--adapter",
    values.adapter,
    "--autocad",
    values.autocad,
    "--case-id",
    values.caseId,
    "--child",
    values.child,
    "--host",
    values.host,
    "--observed-at",
    values.observedAt,
    "--output-dir",
    values.output,
    "--xref-name",
    values.xrefName,
  ];
}

test("parses bounded AutoCAD XREF matrix inputs", () => {
  const result = parseAutoCadXrefArguments(argumentsFor());
  assert.equal(result.adapterPath, path.resolve("adapter.exe"));
  assert.equal(result.autoCadPath, path.resolve("acad.exe"));
  assert.equal(result.hostPath, path.resolve("host.dwg"));
  assert.equal(result.childPath, path.resolve("child.dwg"));
  assert.equal(result.caseId, "xref-state-matrix");
  assert.equal(result.xrefName, "DWGV_XREF");
  assert.throws(
    () => parseAutoCadXrefArguments(argumentsFor({ caseId: "../escape" })),
    /kebab-case/u,
  );
  assert.throws(
    () => parseAutoCadXrefArguments(argumentsFor({ xrefName: "bad|name" })),
    /identifier/u,
  );
  assert.throws(
    () => parseAutoCadXrefArguments(argumentsFor({ observedAt: "today" })),
    /whole-second UTC/u,
  );
});

test("generates one fixed camera and loaded, unloaded and unresolved states", () => {
  const script = createAutoCadXrefScript({
    caseId: "xref-state-matrix",
    childFile: "xref-state-matrix-source-child.dwg",
    outputDirectory: "C:\\qualification output",
    xrefName: "DWGV_XREF",
  });
  assert.equal(script.match(/_\.ZOOM/gu)?.length, 1);
  assert.equal(script.match(/_\.PNGOUT/gu)?.length, 3);
  assert.equal(script.match(/vla-SaveAs/gu)?.length, 3);
  assert.match(script, /vla-AttachExternalReference/u);
  assert.match(script, /vla-Unload/u);
  assert.match(script, /intentionally-missing\.dwg/u);
  assert.match(script, /vl-catch-all-apply 'vla-Reload/u);
  assert.match(script, /\.\/xref-state-matrix-source-child\.dwg/u);
  assert.match(script, /C:\/qualification output/u);
  assert.doesNotMatch(script, /C:\\qualification/u);
  assert.match(script, /xref-state-matrix\.ready/u);
});

test("parses an exact path-free AutoCAD XREF state log", () => {
  const log = [
    "ACADVER\t25.1s",
    "PLATFORM\tMicrosoft Windows 11",
    "STATE\tloaded\tModel\t1\t.\\child.dwg\t1",
    "STATE\tunloaded\tModel\t1\t.\\child.dwg\t0",
    "UNRESOLVED_RELOAD_FAILED\t1",
    "STATE\tunresolved\tModel\t1\t.\\missing.dwg\t0",
  ].join("\r\n");
  const result = parseAutoCadXrefLog(log);
  assert.equal(result.acadVersion, "25.1s");
  assert.deepEqual(
    result.states.map(({ id }) => id),
    ["loaded", "unloaded", "unresolved"],
  );
  assert.throws(
    () => parseAutoCadXrefLog(log.replace("\t1\r\nSTATE\tunresolved", "\t0\r\nSTATE\tunresolved")),
    /Expected values to be strictly equal/u,
  );
});
