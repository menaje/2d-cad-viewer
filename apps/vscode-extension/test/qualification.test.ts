import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createQualificationReporter,
  QUALIFICATION_CLOSE_AFTER_ENV,
  QUALIFICATION_DRAWING_ENV,
  QUALIFICATION_EVENT_SCHEMA,
  QUALIFICATION_MODE_ENV,
  QUALIFICATION_REPORT_ENV,
  QUALIFICATION_TOKEN_ENV,
  QualificationReporter,
} from "../src/qualification";

const TOKEN = "a".repeat(64);

test("enables qualification only for a private absolute target and token", () => {
  assert.equal(createQualificationReporter({}, 42), undefined);
  assert.equal(
    createQualificationReporter(
      {
        [QUALIFICATION_REPORT_ENV]: "relative.jsonl",
        [QUALIFICATION_TOKEN_ENV]: TOKEN,
        [QUALIFICATION_CLOSE_AFTER_ENV]: "full",
      },
      42,
    ),
    undefined,
  );
  assert.equal(
    createQualificationReporter(
      {
        [QUALIFICATION_REPORT_ENV]: "/tmp/report.jsonl",
        [QUALIFICATION_TOKEN_ENV]: "short",
        [QUALIFICATION_CLOSE_AFTER_ENV]: "full",
      },
      42,
    ),
    undefined,
  );
});

test("allows comparison-only qualification without a drawing path", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-comparison-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const reporter = createQualificationReporter(
    {
      [QUALIFICATION_REPORT_ENV]: path.join(root, "events.jsonl"),
      [QUALIFICATION_TOKEN_ENV]: TOKEN,
      [QUALIFICATION_CLOSE_AFTER_ENV]: "full",
      [QUALIFICATION_MODE_ENV]: "comparison",
    },
    42,
  );

  assert.ok(reporter);
  await reporter.close();
});

test("writes bounded path-free events and claims one close stage", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-qualification-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "events.jsonl");
  const reporter = createQualificationReporter(
    {
      [QUALIFICATION_REPORT_ENV]: reportPath,
      [QUALIFICATION_TOKEN_ENV]: TOKEN,
      [QUALIFICATION_DRAWING_ENV]: path.join(root, "drawing.dwg"),
      [QUALIFICATION_CLOSE_AFTER_ENV]: "preview",
    },
    4321,
  );
  assert.ok(reporter);
  assert.equal(reporter.claimClose("full"), false);
  assert.equal(reporter.claimClose("preview"), true);
  assert.equal(reporter.claimClose("preview"), false);
  await reporter.emit("editor-open", {
    extension_host_pid: 4321,
    session_id: "abc123",
  });
  assert.throws(
    () => reporter.emit("invalid/event"),
    /invalid qualification event/u,
  );
  assert.throws(
    () => reporter.emit("invalid-field", { value: "/private/path" }),
    /invalid qualification field value/u,
  );
  await reporter.close();

  const records = (await readFile(reportPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    records.map((record) => record.event),
    ["extension-activated", "editor-open", "extension-deactivated"],
  );
  assert.equal(records[0].schema, QUALIFICATION_EVENT_SCHEMA);
  assert.equal(records[0].extension_host_pid, 4321);
  if (process.platform !== "win32") {
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
  }
});

test("accepts visual completion as a terminal qualification stage", async (context) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dwg-qualification-visual-"),
  );
  context.after(() => rm(root, { recursive: true, force: true }));
  const reporter = createQualificationReporter(
    {
      [QUALIFICATION_REPORT_ENV]: path.join(root, "events.jsonl"),
      [QUALIFICATION_TOKEN_ENV]: TOKEN,
      [QUALIFICATION_DRAWING_ENV]: path.join(root, "drawing.dwg"),
      [QUALIFICATION_CLOSE_AFTER_ENV]: "visual",
    },
    4321,
  );

  assert.ok(reporter);
  assert.equal(reporter.claimClose("full"), false);
  assert.equal(reporter.claimClose("visual"), true);
  assert.equal(reporter.claimClose("visual"), false);
  await reporter.close();
});

test("never overwrites an existing qualification report", async (context) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dwg-qualification-existing-"),
  );
  context.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "events.jsonl");
  await writeFile(reportPath, "existing\n");
  const reporter = new QualificationReporter(
    reportPath,
    "full",
    4321,
  );
  await reporter.emit("extension-activated");
  await assert.rejects(reporter.flush(), /EEXIST/u);
  assert.equal(await readFile(reportPath, "utf8"), "existing\n");
  await reporter.close();
});
