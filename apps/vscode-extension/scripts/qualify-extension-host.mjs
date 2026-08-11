#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const REPORT_SCHEMA = "dwg-vscode-product-qualification/1";
const EVENT_SCHEMA = "dwg-vscode-qualification-event/1";
const TARGET_FIRST_FRAME_MS = 5_000;
const HARD_FIRST_FRAME_MS = 8_000;
const TARGET_CONCURRENT_RSS_BYTES = 600_000_000;
const HARD_CONCURRENT_RSS_BYTES = 800_000_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_SAMPLE_MS = 100;
const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_BYTES = 128 * 1024;
const PRODUCT_ROLES = new Set([
  "converter",
  "extension-host",
  "renderer",
]);
const QUALIFICATION_TEMP_ROOT =
  process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
function requireValue(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, option, minimum, maximum) {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${option} requires an integer`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(`${option} is outside the supported range`);
  }
  return parsed;
}

export function parseQualificationArgs(arguments_) {
  const options = {
    scenario: "all",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sampleMs: DEFAULT_SAMPLE_MS,
    progressivePreview: false,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    switch (option) {
      case "--code":
        options.codePath = requireValue(arguments_, index, option);
        index += 1;
        break;
      case "--runtime":
        options.runtimePath = requireValue(arguments_, index, option);
        index += 1;
        break;
      case "--adapter":
        options.adapterPath = requireValue(arguments_, index, option);
        index += 1;
        break;
      case "--drawing":
        options.drawingPath = requireValue(arguments_, index, option);
        index += 1;
        break;
      case "--vsix":
        options.vsixPath = requireValue(arguments_, index, option);
        index += 1;
        break;
      case "--companion-vsix":
        options.companionVsixPath = requireValue(arguments_, index, option);
        index += 1;
        break;
      case "--output":
        options.outputPath = requireValue(arguments_, index, option);
        index += 1;
        break;
      case "--scenario":
        options.scenario = requireValue(arguments_, index, option);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(
          requireValue(arguments_, index, option),
          option,
          5_000,
          180_000,
        );
        index += 1;
        break;
      case "--sample-ms":
        options.sampleMs = parsePositiveInteger(
          requireValue(arguments_, index, option),
          option,
          50,
          1_000,
        );
        index += 1;
        break;
      case "--progressive-preview":
        options.progressivePreview = true;
        break;
      default:
        throw new Error(`unsupported option: ${option}`);
    }
  }
  if (
    !options.codePath ||
    !options.runtimePath ||
    !options.vsixPath ||
    !options.outputPath
  ) {
    throw new Error(
      "--code, --runtime, --vsix and --output are required",
    );
  }
  if (
    !["all", "full", "cancel", "comparison"].includes(
      options.scenario,
    )
  ) {
    throw new Error(
      "--scenario must be all, full, cancel or comparison",
    );
  }
  if (
    options.scenario !== "comparison" &&
    (!options.adapterPath || !options.drawingPath)
  ) {
    throw new Error(
      "--adapter and --drawing are required for drawing qualification",
    );
  }
  for (const key of [
    "codePath",
    "runtimePath",
    "adapterPath",
    "drawingPath",
    "vsixPath",
    "companionVsixPath",
    "outputPath",
  ]) {
    if (options[key]) {
      options[key] = path.resolve(options[key]);
    }
  }
  return Object.freeze(options);
}

export function classifyProcess(
  process_,
  {
    adapterPath,
    extensionHostPid,
    launcherPid,
  },
) {
  const text = process_.command;
  if (
    typeof adapterPath === "string" &&
    text.includes(adapterPath) &&
    /(?:^|\s)convert(?:\s|$)/u.test(text)
  ) {
    return "converter";
  }
  if (
    extensionHostPid !== undefined &&
    extensionHostPid !== null &&
    process_.pid === extensionHostPid
  ) {
    return "extension-host";
  }
  if (
    text.includes("--extension-process") ||
    text.includes("Code Helper (Plugin)")
  ) {
    return "extension-host";
  }
  if (
    text.includes("--type=renderer") ||
    text.includes("Code Helper (Renderer)")
  ) {
    return "renderer";
  }
  if (text.includes("--type=gpu-process")) {
    return "gpu";
  }
  if (text.includes("--type=utility")) {
    return "utility";
  }
  if (process_.pid === launcherPid) {
    return "launcher";
  }
  if (
    text.includes("Visual Studio Code.app/Contents/MacOS/Electron") ||
    text.includes("Visual Studio Code.app/Contents/MacOS/Code") ||
    /(?:^|\/)code(?:\s|$)/u.test(text)
  ) {
    return "main";
  }
  return "other";
}

export function selectProcessTree(processes, rootPids) {
  const selected = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process_ of processes) {
      if (
        !selected.has(process_.pid) &&
        selected.has(process_.ppid)
      ) {
        selected.add(process_.pid);
        changed = true;
      }
    }
  }
  return processes.filter((process_) => selected.has(process_.pid));
}

export function evaluateGate(value, target, hardLimit) {
  if (!Number.isFinite(value) || value < 0) {
    return Object.freeze({ status: "unavailable", value: null });
  }
  if (value > hardLimit) {
    return Object.freeze({ status: "hard_fail", value });
  }
  if (value > target) {
    return Object.freeze({ status: "target_miss", value });
  }
  return Object.freeze({ status: "pass", value });
}

export function parseDarwinFootprint(output) {
  const summary = /Summary Footprint:\s+(\d+) B/u.exec(output);
  const single = /\bFootprint:\s+(\d+) B/u.exec(output);
  const value = Number(summary?.[1] ?? single?.[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensureInputFile(filePath, executable = false) {
  if (!path.isAbsolute(filePath)) {
    throw new Error("qualification inputs must use absolute paths");
  }
  await access(filePath, executable && process.platform !== "win32" ? 1 : 4);
  const metadata = await stat(filePath);
  if (!metadata.isFile()) {
    throw new Error("qualification input is not a file");
  }
  return metadata;
}

function appendBounded(chunks, chunk, state) {
  if (state.bytes >= MAX_CAPTURE_BYTES) {
    return;
  }
  const buffer = Buffer.from(chunk);
  const remaining = MAX_CAPTURE_BYTES - state.bytes;
  chunks.push(buffer.subarray(0, remaining));
  state.bytes += Math.min(buffer.byteLength, remaining);
}

async function readProcessTable() {
  const { stdout } = await execFile(
    "/bin/ps",
    ["-axo", "pid=,ppid=,rss=,command="],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const processes = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match) {
      continue;
    }
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      command: match[4],
    });
  }
  return processes;
}

async function readEvents(eventPath) {
  let contents;
  try {
    contents = await readFile(eventPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const lines = contents.split("\n");
  if (!contents.endsWith("\n")) {
    lines.pop();
  }
  const events = [];
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const event = JSON.parse(line);
    if (
      event.schema !== EVENT_SCHEMA ||
      typeof event.event !== "string" ||
      !Number.isFinite(event.elapsed_ms)
    ) {
      throw new Error("extension returned an invalid qualification event");
    }
    events.push(event);
  }
  return events;
}

async function measureConcurrentPhysicalMemory(processes) {
  if (processes.length === 0) {
    return null;
  }
  if (process.platform === "darwin") {
    try {
      const arguments_ = ["-f", "bytes"];
      for (const process_ of processes) {
        arguments_.push("-p", String(process_.pid));
      }
      const { stdout } = await execFile(
        "/usr/bin/footprint",
        arguments_,
        {
          maxBuffer: 16 * 1024 * 1024,
          timeout: 5_000,
        },
      );
      const bytes = parseDarwinFootprint(stdout);
      return bytes === null
        ? null
        : Object.freeze({
            kind: "deduplicated-footprint",
            bytes,
          });
    } catch {
      return null;
    }
  }
  if (process.platform === "linux") {
    let bytes = 0;
    try {
      for (const process_ of processes) {
        const rollup = await readFile(
          `/proc/${process_.pid}/smaps_rollup`,
          "utf8",
        );
        const match = /^Pss:\s+(\d+)\s+kB$/mu.exec(rollup);
        if (!match) {
          return null;
        }
        bytes += Number(match[1]) * 1024;
      }
      return Number.isSafeInteger(bytes)
        ? Object.freeze({
            kind: "proportional-set-size",
            bytes,
          })
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function measureProductPhysicalSnapshot(
  productProcesses,
  classificationOptions,
  stage,
) {
  const total = await measureConcurrentPhysicalMemory(productProcesses);
  if (total === null) {
    return null;
  }
  const byRole = {};
  for (const role of PRODUCT_ROLES) {
    const roleProcesses = productProcesses.filter(
      (process_) =>
        classifyProcess(process_, classificationOptions) === role,
    );
    const measurement =
      await measureConcurrentPhysicalMemory(roleProcesses);
    byRole[role] = measurement?.bytes ?? null;
  }
  return Object.freeze({
    ...total,
    stage,
    byRole: Object.freeze(byRole),
  });
}

function updateMemory(state, selected, options) {
  const byRole = new Map();
  for (const process_ of selected) {
    const role = classifyProcess(process_, options);
    byRole.set(role, (byRole.get(role) ?? 0) + process_.rssBytes);
    const existing = state.processes.get(process_.pid);
    if (!existing) {
      state.processes.set(process_.pid, {
        pid: process_.pid,
        role,
        peak_rss_bytes: process_.rssBytes,
      });
    } else {
      existing.role =
        role === "extension-host" ? role : existing.role;
      existing.peak_rss_bytes = Math.max(
        existing.peak_rss_bytes,
        process_.rssBytes,
      );
    }
  }
  const instanceRss = selected.reduce(
    (total, process_) => total + process_.rssBytes,
    0,
  );
  const productRss = [...PRODUCT_ROLES].reduce(
    (total, role) => total + (byRole.get(role) ?? 0),
    0,
  );
  state.peakInstanceRss = Math.max(
    state.peakInstanceRss,
    instanceRss,
  );
  state.peakConcurrentRss = Math.max(
    state.peakConcurrentRss,
    productRss,
  );
  if (productRss >= state.peakConcurrentRss) {
    state.concurrentPeakRoles = Object.fromEntries(
      [...PRODUCT_ROLES].map((role) => [
        role,
        byRole.get(role) ?? 0,
      ]),
    );
    state.concurrentPeakProcessCount = selected.filter((process_) =>
      PRODUCT_ROLES.has(classifyProcess(process_, options)),
    ).length;
  }
  for (const [role, value] of byRole) {
    state.rolePeaks.set(
      role,
      Math.max(state.rolePeaks.get(role) ?? 0, value),
    );
  }
  state.converterObserved ||= (byRole.get("converter") ?? 0) > 0;
  return byRole;
}

function eventByName(events, name) {
  return events.find((event) => event.event === name);
}

function qualificationSettings(progressivePreview) {
  return {
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false,
    "security.workspace.trust.enabled": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "window.restoreWindows": "none",
    "dwgViewer.progressivePreview": progressivePreview,
    "workbench.editorAssociations": {
      "*.dwg": "dwgViewer.dwg",
      "*.DWG": "dwgViewer.dwg",
    },
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
  };
}

export async function writeQualificationDriver(driverDirectory) {
  await mkdir(driverDirectory, { recursive: true, mode: 0o700 });
  const manifest = {
    name: "dwg-viewer-qualification-driver",
    displayName: "DWG Viewer Qualification Driver",
    version: "0.0.0",
    publisher: "local",
    private: true,
    engines: { vscode: "^1.85.0" },
    main: "./extension.js",
    activationEvents: ["onStartupFinished"],
  };
  const source = `"use strict";
const path = require("node:path");
const vscode = require("vscode");

exports.activate = async function activate() {
  const drawing = process.env.DWG_VIEWER_QUALIFICATION_DRAWING;
  const token = process.env.DWG_VIEWER_QUALIFICATION_TOKEN;
  const mode = process.env.DWG_VIEWER_QUALIFICATION_MODE;
  if (
    !token ||
    !/^[a-f0-9]{64}$/u.test(token) ||
    (mode !== "comparison" &&
      (!drawing || !path.isAbsolute(drawing)))
  ) {
    return;
  }
  await new Promise((resolve) =>
    setTimeout(resolve, mode === "comparison" ? 1000 : 4000),
  );
  if (mode === "comparison") {
    const extension = vscode.extensions.getExtension(
      "menaje.dwg-viewer-vscode",
    );
    if (!extension) {
      throw new Error("packaged DWG Viewer extension is unavailable");
    }
    await extension.activate();
    return;
  }
  await vscode.commands.executeCommand(
    "vscode.openWith",
    vscode.Uri.file(drawing),
    "dwgViewer.dwg",
  );
};

exports.deactivate = function deactivate() {};
`;
  await Promise.all([
    writeFile(
      path.join(driverDirectory, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    ),
    writeFile(path.join(driverDirectory, "extension.js"), source, {
      flag: "wx",
      mode: 0o600,
    }),
  ]);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await Promise.race([
    new Promise((resolve) => child.once("close", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

async function remainingOwnedProcesses(
  launcherPid,
  privateRoot,
) {
  const processes = await readProcessTable();
  const roots = new Set([launcherPid]);
  for (const process_ of processes) {
    if (process_.command.includes(privateRoot)) {
      roots.add(process_.pid);
    }
  }
  return selectProcessTree(processes, roots).filter(
    (process_) => process_.pid !== process.pid,
  );
}

async function stopOwnedProcesses(
  child,
  privateRoot,
) {
  let owned = await remainingOwnedProcesses(
    child.pid,
    privateRoot,
  );
  for (const process_ of [...owned].reverse()) {
    try {
      process.kill(process_.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  if (!(await waitForExit(child, 2_000))) {
    try {
      child.kill("SIGTERM");
    } catch {
      // The launcher may already have exited after the editor closed.
    }
  }
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  do {
    await delay(100);
    owned = await remainingOwnedProcesses(
      child.pid,
      privateRoot,
    );
    if (owned.length === 0) {
      return 0;
    }
  } while (Date.now() < deadline);
  for (const process_ of [...owned].reverse()) {
    try {
      process.kill(process_.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  await delay(250);
  return (
    await remainingOwnedProcesses(
      child.pid,
      privateRoot,
    )
  ).length;
}

async function runScenario(options, scenario) {
  const privateRoot = await mkdtemp(
    path.join(QUALIFICATION_TEMP_ROOT, "dwg-vscode-qualification-"),
  );
  const userData = path.join(privateRoot, "user-data");
  const extensions = path.join(privateRoot, "extensions");
  const settingsDirectory = path.join(userData, "User");
  const driverDirectory = path.join(privateRoot, "driver");
  const eventPath = path.join(privateRoot, "events.jsonl");
  await mkdir(settingsDirectory, { recursive: true, mode: 0o700 });
  await mkdir(extensions, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(settingsDirectory, "settings.json"),
    `${JSON.stringify(
      qualificationSettings(options.progressivePreview),
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await writeQualificationDriver(driverDirectory);
  const closeAfter =
    scenario === "cancel-during-conversion"
      ? "conversion"
      : "full";
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  if (options.adapterPath) {
    environment.DWG_VIEWER_LIBREDWG_ADAPTER = options.adapterPath;
  }
  environment.DWG_VIEWER_QUALIFICATION_REPORT = eventPath;
  const qualificationToken = randomBytes(32).toString("hex");
  environment.DWG_VIEWER_QUALIFICATION_TOKEN = qualificationToken;
  if (options.drawingPath) {
    environment.DWG_VIEWER_QUALIFICATION_DRAWING =
      options.drawingPath;
  }
  environment.DWG_VIEWER_QUALIFICATION_CLOSE_AFTER = closeAfter;
  environment.DWG_VIEWER_QUALIFICATION_MODE =
    scenario === "webgl-comparison" ? "comparison" : "drawing";
  try {
    if (options.companionVsixPath) {
      await execFile(
        options.codePath,
        [
          "--user-data-dir",
          userData,
          "--extensions-dir",
          extensions,
          "--install-extension",
          options.companionVsixPath,
          "--force",
        ],
        {
          env: environment,
          maxBuffer: MAX_CAPTURE_BYTES,
        },
      );
    }
    await execFile(
      options.codePath,
      [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--install-extension",
        options.vsixPath,
        "--force",
      ],
      {
        env: environment,
        maxBuffer: MAX_CAPTURE_BYTES,
      },
    );
  } catch {
    throw new Error(
      "VSIX installation failed in the isolated VS Code instance",
    );
  }
  const arguments_ = [
    "--new-window",
    "--locale",
    "en",
    "--user-data-dir",
    userData,
    "--extensions-dir",
    extensions,
    `--extensionDevelopmentPath=${driverDirectory}`,
  ];
  const child = spawn(options.runtimePath, arguments_, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  let childError;
  child.once("error", (error) => {
    childError = error;
  });
  child.stdout.on("data", (chunk) =>
    appendBounded(stdout, chunk, stdoutState),
  );
  child.stderr.on("data", (chunk) =>
    appendBounded(stderr, chunk, stderrState),
  );
  const scenarioStartedAt = Date.now();

  const memory = {
    processes: new Map(),
    rolePeaks: new Map(),
    peakConcurrentRss: 0,
    peakInstanceRss: 0,
    converterObserved: false,
    concurrentPeakRoles: {},
    concurrentPeakProcessCount: 0,
    concurrentPhysical: null,
    concurrentPhysicalByRole: null,
    concurrentPhysicalStage: null,
    baselinePhysical: null,
    baselinePhysicalAttempted: false,
    physicalMeasurementStages: new Set(),
  };
  const deadline = Date.now() + options.timeoutMs;
  let events = [];
  let extensionHostPid;
  let cleanupStableSamples = 0;
  let disposedAt;
  let converterGoneAt;
  let cleanupConverterProcesses = null;
  let failure;

  try {
    while (Date.now() < deadline) {
      if (childError) {
        throw new Error("VS Code qualification process failed to start");
      }
      events = await readEvents(eventPath);
      const activated = eventByName(events, "extension-activated");
      if (Number.isSafeInteger(activated?.extension_host_pid)) {
        extensionHostPid = activated.extension_host_pid;
      }
      const processes = await readProcessTable();
      const roots = new Set([child.pid]);
      for (const process_ of processes) {
        if (process_.command.includes(privateRoot)) {
          roots.add(process_.pid);
        }
      }
      const selected = selectProcessTree(processes, roots);
      const classificationOptions = {
        adapterPath: options.adapterPath,
        extensionHostPid,
        launcherPid: child.pid,
      };
      const roleRss = updateMemory(
        memory,
        selected,
        classificationOptions,
      );
      const productProcesses = selected.filter((process_) =>
        PRODUCT_ROLES.has(
          classifyProcess(process_, classificationOptions),
        ),
      );
      if (
        scenario === "cold-full" &&
        !memory.baselinePhysicalAttempted &&
        !memory.converterObserved &&
        Date.now() - scenarioStartedAt >= 3_000 &&
        productProcesses.some(
          (process_) =>
            classifyProcess(process_, classificationOptions) ===
            "extension-host",
        ) &&
        productProcesses.some(
          (process_) =>
            classifyProcess(process_, classificationOptions) ===
            "renderer",
        )
      ) {
        memory.baselinePhysicalAttempted = true;
        memory.baselinePhysical =
          await measureConcurrentPhysicalMemory(productProcesses);
      }
      let physicalStage;
      if (
        eventByName(events, "preview-first-frame") &&
        (roleRss.get("converter") ?? 0) > 0
      ) {
        physicalStage = "preview-first-frame";
      } else if ((roleRss.get("converter") ?? 0) >= 500_000_000) {
        physicalStage = "conversion-peak";
      } else if (
        eventByName(events, "full-first-frame") &&
        (roleRss.get("converter") ?? 0) === 0
      ) {
        physicalStage = "full-first-frame";
      }
      if (
        scenario === "cold-full" &&
        physicalStage &&
        !memory.physicalMeasurementStages.has(physicalStage)
      ) {
        memory.physicalMeasurementStages.add(physicalStage);
        const snapshot = await measureProductPhysicalSnapshot(
          productProcesses,
          classificationOptions,
          physicalStage,
        );
        if (
          snapshot !== null &&
          (memory.concurrentPhysical === null ||
            snapshot.bytes > memory.concurrentPhysical.bytes)
        ) {
          memory.concurrentPhysical = snapshot;
          memory.concurrentPhysicalByRole = snapshot.byRole;
          memory.concurrentPhysicalStage = snapshot.stage;
        }
      }
      const conversionFailure = eventByName(
        events,
        "conversion-failed",
      );
      if (conversionFailure) {
        throw new Error(
          `extension qualification failed: ${conversionFailure.code ?? "unknown"}`,
        );
      }
      const renderFailure = eventByName(events, "render-failed");
      if (renderFailure) {
        throw new Error(
          `extension render qualification failed: ${renderFailure.code ?? "unknown"}`,
        );
      }
      const comparisonFailure = eventByName(
        events,
        "comparison-failed",
      );
      if (comparisonFailure) {
        throw new Error(
          `extension comparison qualification failed: ${comparisonFailure.code ?? "unknown"}`,
        );
      }
      if (
        scenario === "webgl-comparison" &&
        eventByName(events, "comparison-panel-disposed")
      ) {
        break;
      }
      const disposed = eventByName(events, "editor-disposed");
      if (disposed) {
        disposedAt ??= Date.now();
        const converterCount = selected.filter(
          (process_) =>
            classifyProcess(process_, {
              adapterPath: options.adapterPath,
              extensionHostPid,
              launcherPid: child.pid,
            }) === "converter",
        ).length;
        cleanupConverterProcesses = converterCount;
        cleanupStableSamples =
          converterCount === 0 ? cleanupStableSamples + 1 : 0;
        if (cleanupStableSamples >= 3) {
          converterGoneAt ??= Date.now();
          break;
        }
      }
      if (
        child.exitCode !== null &&
        !eventByName(
          events,
          scenario === "webgl-comparison"
            ? "comparison-panel-disposed"
            : "editor-disposed",
        )
      ) {
        throw new Error(
          `VS Code exited before qualification cleanup completed (code=${child.exitCode}, signal=${child.signalCode ?? "none"})`,
        );
      }
      await delay(options.sampleMs);
    }
    if (scenario === "webgl-comparison") {
      const comparison = eventByName(events, "comparison-qualified");
      const panelDisposed = eventByName(
        events,
        "comparison-panel-disposed",
      );
      if (!comparison || panelDisposed?.qualified !== true) {
        throw new Error(
          "qualification timed out before comparison cleanup",
        );
      }
    } else {
      if (!eventByName(events, "editor-disposed")) {
        throw new Error(
          "qualification timed out before editor cleanup",
        );
      }
      if (!memory.converterObserved) {
        throw new Error(
          "LibreDWG converter process was not observed",
        );
      }
      if (
        scenario === "cold-full" &&
        !eventByName(events, "full-first-frame")
      ) {
        throw new Error("full first frame was not observed");
      }
      if (
        scenario === "cancel-during-conversion" &&
        eventByName(events, "full-first-frame")
      ) {
        throw new Error(
          "cancel scenario reached the full frame before cleanup",
        );
      }
    }
  } catch (error) {
    failure = error;
  }

  let processesAfterShutdown = -1;
  try {
    processesAfterShutdown = await stopOwnedProcesses(
      child,
      privateRoot,
    );
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
  if (failure) {
    throw failure;
  }

  const preview = eventByName(events, "preview-first-frame");
  const full = eventByName(events, "full-first-frame");
  const disposeStart = eventByName(events, "editor-dispose-start");
  const disposed = eventByName(events, "editor-disposed");
  const comparison = eventByName(events, "comparison-qualified");
  const comparisonPanelDisposed = eventByName(
    events,
    "comparison-panel-disposed",
  );
  const processPeaks = [...memory.processes.values()]
    .sort((left, right) =>
      left.role === right.role
        ? left.pid - right.pid
        : left.role.localeCompare(right.role),
    );
  return Object.freeze({
    scenario,
    timing: Object.freeze({
      preview_first_usable_frame_ms:
        preview?.host_to_frame_ms ?? null,
      full_first_usable_frame_ms:
        full?.host_to_frame_ms ?? null,
      first_usable_frame_ms:
        preview?.host_to_frame_ms ??
        full?.host_to_frame_ms ??
        null,
      full_webview_frame_ms: full?.webview_frame_ms ?? null,
      editor_cleanup_ms:
        Number.isFinite(disposeStart?.elapsed_ms) &&
        Number.isFinite(disposed?.elapsed_ms)
          ? Math.max(
              0,
              disposed.elapsed_ms - disposeStart.elapsed_ms,
            )
          : null,
      converter_exit_after_dispose_ms:
        disposedAt === undefined || converterGoneAt === undefined
          ? null
          : Math.max(0, converterGoneAt - disposedAt),
    }),
    memory: Object.freeze({
      sample_interval_ms: options.sampleMs,
      peak_concurrent_rss_bytes: memory.peakConcurrentRss,
      concurrent_rss_peak_roles: memory.concurrentPeakRoles,
      concurrent_rss_peak_process_count:
        memory.concurrentPeakProcessCount,
      concurrent_physical_bytes:
        memory.concurrentPhysical?.bytes ?? null,
      concurrent_physical_kind:
        memory.concurrentPhysical?.kind ?? null,
      concurrent_physical_stage:
        memory.concurrentPhysicalStage,
      concurrent_physical_role_bytes:
        memory.concurrentPhysicalByRole,
      baseline_physical_bytes:
        memory.baselinePhysical?.bytes ?? null,
      baseline_physical_kind:
        memory.baselinePhysical?.kind ?? null,
      incremental_physical_bytes:
        memory.concurrentPhysical !== null &&
        memory.baselinePhysical !== null
          ? Math.max(
              0,
              memory.concurrentPhysical.bytes -
                memory.baselinePhysical.bytes,
            )
          : null,
      peak_instance_rss_bytes: memory.peakInstanceRss,
      extension_host_peak_rss_bytes:
        memory.rolePeaks.get("extension-host") ?? 0,
      renderer_peak_rss_bytes:
        memory.rolePeaks.get("renderer") ?? 0,
      converter_peak_rss_bytes:
        memory.rolePeaks.get("converter") ?? 0,
      processes: processPeaks,
    }),
    comparison:
      comparison === undefined
        ? null
        : Object.freeze({
            elapsed_ms: comparison.elapsed_ms,
            strategy: comparison.strategy,
            webgl2: comparison.webgl2,
            before_checksum: comparison.before_checksum,
            after_checksum: comparison.after_checksum,
            before_nonwhite_pixels:
              comparison.before_nonwhite_pixels,
            after_nonwhite_pixels:
              comparison.after_nonwhite_pixels,
            highlighted_before_blue_pixels:
              comparison.highlighted_before_blue_pixels,
            highlighted_after_blue_pixels:
              comparison.highlighted_after_blue_pixels,
            stale_pick_rejected:
              comparison.stale_pick_rejected,
            rollback_preserved_pixels:
              comparison.rollback_preserved_pixels,
            rollback_preserved_pick_revision:
              comparison.rollback_preserved_pick_revision,
            visibility_toggle: comparison.visibility_toggle,
            comparison_first_frame_ms:
              comparison.comparison_first_frame_ms,
            retained_pixel_bytes:
              comparison.retained_pixel_bytes,
            surface_pixel_budget:
              comparison.surface_pixel_budget,
            comparison_disposed:
              comparison.comparison_disposed,
            surfaces_released: comparison.surfaces_released,
            repeat_lifecycle_count:
              comparison.repeat_lifecycle_count,
            repeat_lifecycle_released:
              comparison.repeat_lifecycle_released,
            delta_allocated_bytes_after_dispose:
              comparison.delta_allocated_bytes_after_dispose,
          }),
    cleanup: Object.freeze({
      editor_disposed: disposed !== undefined,
      comparison_panel_disposed:
        comparisonPanelDisposed !== undefined,
      converter_processes_after_dispose:
        cleanupConverterProcesses ?? 0,
      owned_processes_after_shutdown: processesAfterShutdown,
    }),
  });
}

export async function qualifyExtensionHost(options) {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      "extension-host qualification currently supports macOS and Linux",
    );
  }
  const [
    codeMetadata,
    runtimeMetadata,
    adapterMetadata,
    drawingMetadata,
    vsixMetadata,
    companionVsixMetadata,
  ] = await Promise.all([
    ensureInputFile(options.codePath, true),
    ensureInputFile(options.runtimePath, true),
    options.adapterPath
      ? ensureInputFile(options.adapterPath, true)
      : Promise.resolve(null),
    options.drawingPath
      ? ensureInputFile(options.drawingPath)
      : Promise.resolve(null),
    ensureInputFile(options.vsixPath),
    options.companionVsixPath
      ? ensureInputFile(options.companionVsixPath)
      : Promise.resolve(null),
  ]);
  void codeMetadata;
  void runtimeMetadata;
  void adapterMetadata;
  void vsixMetadata;
  void companionVsixMetadata;
  if (
    path.extname(options.vsixPath).toLocaleLowerCase("en-US") !==
      ".vsix" ||
    (options.companionVsixPath &&
      path
        .extname(options.companionVsixPath)
        .toLocaleLowerCase("en-US") !== ".vsix")
  ) {
    throw new Error(
      "qualification requires packaged VSIX files",
    );
  }
  try {
    await access(options.outputPath);
    throw new Error("qualification output already exists");
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
    // Exclusive creation below still protects against a race.
  }
  await mkdir(path.dirname(options.outputPath), {
    recursive: true,
    mode: 0o700,
  });
  const scenarios =
    options.scenario === "all"
      ? [
          "cold-full",
          "cancel-during-conversion",
          "webgl-comparison",
        ]
      : [
          options.scenario === "full"
            ? "cold-full"
            : options.scenario === "cancel"
              ? "cancel-during-conversion"
              : "webgl-comparison",
        ];
  const runs = [];
  for (const scenario of scenarios) {
    runs.push(await runScenario(options, scenario));
  }
  const fullRun = runs.find((run) => run.scenario === "cold-full");
  const comparisonRun = runs.find(
    (run) => run.scenario === "webgl-comparison",
  );
  const report = Object.freeze({
    schema: REPORT_SCHEMA,
    status: "ok",
    platform: process.platform,
    architecture: process.arch,
    progressive_preview: options.progressivePreview,
    source_size_bytes: drawingMetadata?.size ?? null,
    runs,
    gates: Object.freeze({
      first_usable_frame: evaluateGate(
        fullRun?.timing.first_usable_frame_ms ?? Number.NaN,
        TARGET_FIRST_FRAME_MS,
        HARD_FIRST_FRAME_MS,
      ),
      incremental_physical_memory: evaluateGate(
        fullRun?.memory.incremental_physical_bytes ?? Number.NaN,
        TARGET_CONCURRENT_RSS_BYTES,
        HARD_CONCURRENT_RSS_BYTES,
      ),
      revision_comparison:
        comparisonRun === undefined
          ? Object.freeze({ status: "unavailable" })
          : comparisonRun.comparison?.webgl2 === true &&
              comparisonRun.comparison?.stale_pick_rejected === true &&
              comparisonRun.comparison?.rollback_preserved_pixels ===
                true &&
              comparisonRun.comparison
                ?.rollback_preserved_pick_revision === true &&
              comparisonRun.comparison?.comparison_disposed === true &&
              comparisonRun.comparison?.surfaces_released === true &&
              comparisonRun.comparison?.repeat_lifecycle_released ===
                true &&
              comparisonRun.comparison
                ?.delta_allocated_bytes_after_dispose === 0
            ? Object.freeze({ status: "pass" })
            : Object.freeze({ status: "hard_fail" }),
      cleanup:
        runs.every(
          (run) =>
            (run.scenario === "webgl-comparison"
              ? run.cleanup.comparison_panel_disposed
              : run.cleanup.editor_disposed) &&
            run.cleanup.converter_processes_after_dispose === 0 &&
            run.cleanup.owned_processes_after_shutdown === 0,
        )
          ? Object.freeze({ status: "pass" })
          : Object.freeze({ status: "hard_fail" }),
    }),
    diagnostics: Object.freeze({
      aggregate_rss: evaluateGate(
        fullRun?.memory.peak_concurrent_rss_bytes ?? Number.NaN,
        TARGET_CONCURRENT_RSS_BYTES,
        HARD_CONCURRENT_RSS_BYTES,
      ),
      baseline_inclusive_physical_memory: evaluateGate(
        fullRun?.memory.concurrent_physical_bytes ?? Number.NaN,
        TARGET_CONCURRENT_RSS_BYTES,
        HARD_CONCURRENT_RSS_BYTES,
      ),
    }),
  });
  await writeFile(
    options.outputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return report;
}

async function main() {
  const options = parseQualificationArgs(process.argv.slice(2));
  const report = await qualifyExtensionHost(options);
  process.stdout.write(
    `${JSON.stringify({
      schema: report.schema,
      status: report.status,
      source_size_bytes: report.source_size_bytes,
      gates: report.gates,
      diagnostics: report.diagnostics,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `qualification failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
