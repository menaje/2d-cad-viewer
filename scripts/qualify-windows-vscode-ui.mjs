#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import vscodeTestElectron from "@vscode/test-electron";
import { chromium } from "playwright-core";

import { writeQualificationDriver } from "../apps/vscode-extension/scripts/qualify-extension-host.mjs";

const execFile = promisify(execFileCallback);
const {
  downloadAndUnzipVSCode,
  runVSCodeCommand,
} = vscodeTestElectron;
const REPORT_SCHEMA = "dwg-windows-vscode-ui-qualification/1";
export const WINDOWS_UI_EXTENSION_ID = "menaje.dwg-viewer-vscode";
export const WINDOWS_UI_COMPANION_EXTENSION_ID =
  "menaje.dwg-viewer-libredwg";
export const WINDOWS_UI_CLEANUP_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: 20,
  retryDelay: 250,
});
const SCALE_FACTORS = Object.freeze([1, 1.25, 1.5, 2]);
const WIDTHS = Object.freeze([
  Object.freeze({ label: "normal", editorWidth: 1_050 }),
  Object.freeze({ label: "narrow", editorWidth: 520 }),
]);
const FRAME_TIMEOUT_MS = 120_000;
const MEASUREMENT_UNITS = new Set([
  "도면 단위",
  "in",
  "ft",
  "mi",
  "mm",
  "cm",
  "m",
  "km",
  "µin",
  "mil",
  "yd",
  "Å",
  "nm",
  "µm",
  "dm",
  "dam",
  "hm",
  "Gm",
  "AU",
  "ly",
  "pc",
  "US ft",
  "US in",
  "US yd",
  "US mi",
]);
const MEASUREMENT_NUMBER =
  "-?(?:\\d{1,3}(?:,\\d{3})*|\\d+)(?:\\.\\d+)?";
const MEASUREMENT_LENGTH_PATTERN = new RegExp(
  `^(${MEASUREMENT_NUMBER}) (.+)$`,
  "u",
);
const MEASUREMENT_ANGLE_PATTERN = new RegExp(
  `^${MEASUREMENT_NUMBER}°$`,
  "u",
);

function requireValue(values, index, option) {
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseWindowsUiArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (
      ![
        "--drawing",
        "--companion-vsix",
        "--vsix",
        "--output-dir",
      ].includes(option)
    ) {
      throw new Error(`unsupported option: ${option}`);
    }
    options[
      {
        "--drawing": "drawingPath",
        "--companion-vsix": "companionVsixPath",
        "--vsix": "vsixPath",
        "--output-dir": "outputDirectory",
      }[option]
    ] = path.resolve(requireValue(values, index, option));
    index += 1;
  }
  for (const key of [
    "drawingPath",
    "companionVsixPath",
    "vsixPath",
    "outputDirectory",
  ]) {
    if (!options[key] || !path.isAbsolute(options[key])) {
      throw new Error(`${key} must be an absolute path`);
    }
  }
  return Object.freeze(options);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensureFile(filePath) {
  await access(filePath, 4);
  const metadata = await stat(filePath);
  if (!metadata.isFile()) {
    throw new Error("qualification input is not a file");
  }
  return metadata;
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function writeJsonExclusive(filePath, value) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

function qualificationSettings() {
  return {
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false,
    "security.workspace.trust.enabled": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "window.restoreWindows": "none",
    "window.zoomLevel": 0,
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.editorAssociations": {
      "*.dwg": "dwgViewer.dwg",
      "*.DWG": "dwgViewer.dwg",
    },
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
  };
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForDevtools(port, child, output) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `VS Code exited before DevTools became ready: ${output().slice(-2_000)}`,
      );
    }
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return endpoint;
      }
    } catch {
      // The debugging endpoint is not listening yet.
    }
    await delay(200);
  }
  throw new Error("VS Code DevTools endpoint did not become ready");
}

async function findViewerFrame(browser, child) {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  let lastStatus = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("VS Code exited before the DWG Webview loaded");
    }
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          const dropZone = frame.locator("#drop-zone");
          if ((await dropZone.count()) === 0) {
            continue;
          }
          lastStatus =
            (await frame.locator("#status").textContent().catch(() => "")) ??
            "";
          if (await dropZone.evaluate((element) =>
            element.classList.contains("loaded"),
          )) {
            return { frame, page };
          }
        }
      }
    }
    await delay(250);
  }
  throw new Error(
    `DWG Webview did not load before timeout (status=${lastStatus.slice(0, 160)})`,
  );
}

export function rectIsContained(rect, viewport, tolerance = 1) {
  return (
    rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left >= -tolerance &&
    rect.top >= -tolerance &&
    rect.right <= viewport.width + tolerance &&
    rect.bottom <= viewport.height + tolerance
  );
}

export function canvasPointIsUnobstructed(
  element,
  candidate,
  hitTest = (x, y) => document.elementFromPoint(x, y),
) {
  const rect = element.getBoundingClientRect();
  return (
    hitTest(rect.left + candidate.x, rect.top + candidate.y) ===
    element
  );
}

export function adjustedHostViewportSize(
  hostViewport,
  currentEditorWidth,
  targetEditorWidth,
) {
  if (
    !Number.isFinite(hostViewport?.width) ||
    !Number.isFinite(hostViewport?.height) ||
    !Number.isFinite(currentEditorWidth) ||
    !Number.isFinite(targetEditorWidth)
  ) {
    throw new TypeError("viewport widths must be finite");
  }
  return Object.freeze({
    width: Math.max(
      560,
      Math.round(
        hostViewport.width +
          targetEditorWidth -
          currentEditorWidth,
      ),
    ),
    height: Math.max(820, Math.round(hostViewport.height)),
  });
}

function exactRows(rows, requiredLabels, label) {
  if (!Array.isArray(rows)) {
    throw new Error(`${label} rows are missing`);
  }
  const result = new Map();
  for (const row of rows) {
    if (
      !Array.isArray(row) ||
      row.length !== 2 ||
      typeof row[0] !== "string" ||
      typeof row[1] !== "string" ||
      result.has(row[0])
    ) {
      throw new Error(`${label} has invalid rows`);
    }
    result.set(row[0], row[1]);
  }
  for (const required of requiredLabels) {
    if (!result.has(required)) {
      throw new Error(`${label} is missing ${required}`);
    }
  }
  return result;
}

function measurementLength(value, label) {
  const match = MEASUREMENT_LENGTH_PATTERN.exec(value);
  if (!match || !MEASUREMENT_UNITS.has(match[2])) {
    throw new Error(`${label} is not a numeric measurement with a DWG unit`);
  }
  return Object.freeze({ value: match[1], unit: match[2] });
}

export function parseCoordinateMeasurementRows(rows) {
  const values = exactRows(rows, ["X", "Y", "Z", "스냅"], "coordinate");
  const coordinates = ["X", "Y", "Z"].map((axis) =>
    measurementLength(values.get(axis), axis),
  );
  if (
    coordinates.some(
      (coordinate) => coordinate.unit !== coordinates[0].unit,
    )
  ) {
    throw new Error("coordinate measurement units are inconsistent");
  }
  const snap = values.get("스냅").trim();
  if (!snap) {
    throw new Error("coordinate snap label is empty");
  }
  return Object.freeze({
    unit: coordinates[0].unit,
    values: Object.freeze({
      x: values.get("X"),
      y: values.get("Y"),
      z: values.get("Z"),
      snap,
    }),
  });
}

export function parseDistanceMeasurementRows(rows) {
  const values = exactRows(
    rows,
    ["거리", "ΔX", "ΔY", "ΔZ", "각도"],
    "distance",
  );
  const lengths = ["거리", "ΔX", "ΔY", "ΔZ"].map((field) =>
    measurementLength(values.get(field), field),
  );
  if (lengths.some((length) => length.unit !== lengths[0].unit)) {
    throw new Error("distance measurement units are inconsistent");
  }
  if (!MEASUREMENT_ANGLE_PATTERN.test(values.get("각도"))) {
    throw new Error("distance angle is not numeric");
  }
  return Object.freeze({
    unit: lengths[0].unit,
    values: Object.freeze({
      distance: values.get("거리"),
      deltaX: values.get("ΔX"),
      deltaY: values.get("ΔY"),
      deltaZ: values.get("ΔZ"),
      angle: values.get("각도"),
    }),
  });
}

export function viewportZoomFromStatus(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d+(?:\.\d+)?)×(?:\s|$)/u.exec(value.trim());
  if (!match) {
    return null;
  }
  const zoom = Number(match[1]);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : null;
}

async function surfaceSnapshot(frame) {
  return frame.evaluate(() => {
    const snapshot = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        hidden:
          element.hidden ||
          style.display === "none" ||
          style.visibility === "hidden",
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      host: document.body.dataset.host ?? "",
      header: snapshot("header"),
      trigger: snapshot("#viewer-tools-trigger"),
      toolbar: snapshot("#viewer-toolbar"),
      reviewToolbar: snapshot("#review-toolbar"),
      canvas: snapshot("#drawing"),
    };
  });
}

async function setEditorWidth(page, frame, editorWidth) {
  const session = await page.context().newCDPSession(page);
  try {
    const deviceScaleFactor = await frame.evaluate(
      () => devicePixelRatio,
    );
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await frame.evaluate(() => innerWidth);
      if (Math.abs(current - editorWidth) <= 16) {
        break;
      }
      const hostViewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      const target = adjustedHostViewportSize(
        hostViewport,
        current,
        editorWidth,
      );
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: target.width,
        height: target.height,
        deviceScaleFactor,
        mobile: false,
        screenWidth: target.width,
        screenHeight: target.height,
      });
      await delay(350);
    }
  } finally {
    await session.detach();
  }
  return frame.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
}

async function openViewerTools(frame) {
  const trigger = frame.locator("#viewer-tools-trigger");
  assert.equal(await trigger.isVisible(), true);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  await frame.evaluate(async () => {
    const header = document.querySelector("header");
    if (!(header instanceof HTMLElement)) {
      throw new Error("viewer header is missing");
    }
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    await Promise.allSettled(
      header
        .getAnimations()
        .map((animation) => animation.finished),
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  await frame.waitForFunction(
    () => {
      const header = document.querySelector("header");
      const toolbar = document.querySelector("#viewer-toolbar");
      return (
        header instanceof HTMLElement &&
        header.classList.contains("tools-open") &&
        toolbar instanceof HTMLElement &&
        getComputedStyle(toolbar).visibility === "visible" &&
        toolbar.getBoundingClientRect().width > 0
      );
    },
    undefined,
    { timeout: 5_000 },
  );
}

export function candidatePositions(width, height) {
  const leftMargin = Math.min(176, width * 0.35);
  const rightMargin = Math.min(24, width * 0.08);
  const marginY = Math.min(24, height * 0.08);
  const usableWidth = Math.max(
    1,
    width - leftMargin - rightMargin,
  );
  const result = [];
  const fractions = [
    0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875, 0.2, 0.4, 0.6,
    0.8, 0.1, 0.3, 0.7, 0.9,
  ];
  for (const fraction of fractions) {
    result.push({
      x: leftMargin + usableWidth * fraction,
      y: height / 2,
    });
    result.push({
      x: width / 2,
      y: marginY + (height - marginY * 2) * fraction,
    });
    result.push({
      x: leftMargin + usableWidth * fraction,
      y: marginY + (height - marginY * 2) * fraction,
    });
    result.push({
      x: leftMargin + usableWidth * fraction,
      y: marginY + (height - marginY * 2) * (1 - fraction),
    });
  }
  return result;
}

async function activateTool(frame, tool) {
  const button = frame.locator(`[data-review-tool="${tool}"]`);
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
  }
  assert.equal(await button.getAttribute("aria-pressed"), "true");
}

async function clearReview(frame) {
  await frame.locator('[data-review-action="clear"]').click();
  assert.equal(await frame.locator("#review-result").isVisible(), false);
}

async function resultSnapshot(frame) {
  const result = frame.locator("#review-result");
  if (!(await result.isVisible())) {
    return null;
  }
  return {
    title:
      (await frame.locator("[data-review-title]").textContent())?.trim() ??
      "",
    content:
      (await frame.locator("[data-review-content]").innerText()).trim(),
    rows: await frame
      .locator("[data-review-content] > div")
      .evaluateAll((elements) =>
        elements.map((element) => [
          element.children[0]?.textContent?.trim() ?? "",
          element.children[1]?.textContent?.trim() ?? "",
        ]),
      ),
  };
}

async function findTwoMeasurementPoints(frame) {
  await activateTool(frame, "coordinate");
  const canvas = frame.locator("#drawing");
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 100 && box.height > 100);
  const points = [];
  for (const position of candidatePositions(box.width, box.height)) {
    const canvasIsTopmost = await canvas.evaluate(
      canvasPointIsUnobstructed,
      position,
    );
    if (!canvasIsTopmost) {
      continue;
    }
    await canvas.click({ position });
    const result = await resultSnapshot(frame);
    if (result?.title === "점 좌표") {
      const measurement = parseCoordinateMeasurementRows(result.rows);
      if (
        !points.some(
          (entry) => entry.content === result.content,
        )
      ) {
        points.push({
          position,
          content: result.content,
          measurement,
        });
      }
      if (points.length === 2) {
        break;
      }
    }
    await clearReview(frame);
  }
  assert.equal(points.length, 2, "two distinct drawing points are required");
  return points;
}

async function qualifyReviewInteractions(frame) {
  const points = await findTwoMeasurementPoints(frame);
  await clearReview(frame);

  await activateTool(frame, "select");
  await frame.locator("#drawing").click({ position: points[0].position });
  const selection = await resultSnapshot(frame);
  assert.ok(selection && selection.content.includes("종류"));
  await clearReview(frame);

  await activateTool(frame, "distance");
  await frame.locator("#drawing").click({ position: points[0].position });
  assert.match(
    (await frame.locator("#status").textContent()) ?? "",
    /첫 점/u,
  );
  await frame.locator("#drawing").click({ position: points[1].position });
  const distance = await resultSnapshot(frame);
  assert.equal(distance?.title, "두 점 거리");
  const distanceMeasurement = parseDistanceMeasurementRows(
    distance.rows,
  );
  assert.equal(
    points.every(
      (point) =>
        point.measurement.unit === distanceMeasurement.unit,
    ),
    true,
  );

  await openViewerTools(frame);
  await frame.locator('[data-view-action="zoom-in"]').click();
  await frame.waitForFunction(
    () => {
      const match = /^(\d+(?:\.\d+)?)×(?:\s|$)/u.exec(
        document.querySelector("#status")?.textContent?.trim() ?? "",
      );
      return match !== null && Number(match[1]) > 1.01;
    },
    undefined,
    { timeout: 15_000 },
  );
  const zoomedStatus =
    (await frame.locator("#status").textContent()) ?? "";
  assert.ok(viewportZoomFromStatus(zoomedStatus) > 1.01);

  await frame.locator('[data-review-action="fit"]').click();
  await frame.waitForFunction(
    () => {
      const match = /^(\d+(?:\.\d+)?)×(?:\s|$)/u.exec(
        document.querySelector("#status")?.textContent?.trim() ?? "",
      );
      return (
        match !== null &&
        Math.abs(Number(match[1]) - 1) <= 0.01
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  const fittedStatus =
    (await frame.locator("#status").textContent()) ?? "";
  assert.ok(
    Math.abs(viewportZoomFromStatus(fittedStatus) - 1) <= 0.01,
  );
  await clearReview(frame);

  return {
    status: "pass",
    selection: true,
    coordinate: true,
    distance: true,
    distanceFields: ["distance", "deltaX", "deltaY", "deltaZ", "angle"],
    measurementUnit: distanceMeasurement.unit,
    coordinateValues: points.map(
      (point) => point.measurement.values,
    ),
    distanceValues: distanceMeasurement.values,
    fit: true,
    fitZoom: {
      before: viewportZoomFromStatus(zoomedStatus),
      after: viewportZoomFromStatus(fittedStatus),
    },
    clear: true,
    observedSnapLabels: points.map((point) => {
      const match = /스냅\s*\n?([^\n]+)/u.exec(point.content);
      return match?.[1]?.trim().slice(0, 40) ?? "present";
    }),
  };
}

async function qualifyLayoutReset(frame) {
  const tabs = frame.locator("#layout-tabs button[data-view-id]");
  const count = await tabs.count();
  assert.ok(count >= 2, "qualification drawing requires Model/Paper views");
  let selectedIndex = 0;
  for (let index = 0; index < count; index += 1) {
    if ((await tabs.nth(index).getAttribute("aria-selected")) === "true") {
      selectedIndex = index;
      break;
    }
  }
  const targetIndex = selectedIndex === 0 ? 1 : 0;
  await activateTool(frame, "distance");
  await tabs.nth(targetIndex).click();
  await frame.waitForFunction(
    (index) => {
      const buttons = document.querySelectorAll(
        "#layout-tabs button[data-view-id]",
      );
      return buttons[index]?.getAttribute("aria-selected") === "true";
    },
    targetIndex,
    { timeout: 15_000 },
  );
  const pressed = await frame
    .locator('[data-review-tool][aria-pressed="true"]')
    .count();
  assert.equal(pressed, 0);
  assert.equal(await frame.locator("#review-result").isVisible(), false);
  await tabs.nth(selectedIndex).click();
  await frame.waitForFunction(
    (index) => {
      const buttons = document.querySelectorAll(
        "#layout-tabs button[data-view-id]",
      );
      return buttons[index]?.getAttribute("aria-selected") === "true";
    },
    selectedIndex,
    { timeout: 15_000 },
  );
  return {
    status: "pass",
    views: count,
    pendingReviewStateCleared: true,
  };
}

async function captureWidth({
  frame,
  page,
  outputDirectory,
  scaleFactor,
  width,
}) {
  const editor = await setEditorWidth(
    page,
    frame,
    width.editorWidth,
  );
  assert.ok(
    Math.abs(editor.width - width.editorWidth) <= 16,
    `expected ${width.label} editor width ${width.editorWidth}, got ${editor.width}`,
  );
  await openViewerTools(frame);
  const surfaces = await surfaceSnapshot(frame);
  assert.ok(
    Math.abs(surfaces.devicePixelRatio - scaleFactor) <= 0.08,
    `expected DPR ${scaleFactor}, got ${surfaces.devicePixelRatio}`,
  );
  assert.equal(surfaces.host, "vscode");
  for (const name of [
    "header",
    "trigger",
    "toolbar",
    "reviewToolbar",
    "canvas",
  ]) {
    assert.equal(surfaces[name]?.hidden, false, `${name} must be visible`);
    assert.equal(
      rectIsContained(surfaces[name], surfaces.viewport),
      true,
      `${name} must fit in the editor viewport: ${JSON.stringify({
        rect: surfaces[name],
        viewport: surfaces.viewport,
      })}`,
    );
  }
  const reviewCoverage =
    (surfaces.reviewToolbar.width * surfaces.reviewToolbar.height) /
    (surfaces.viewport.width * surfaces.viewport.height);
  assert.ok(reviewCoverage < 0.22);

  const scalePercent = Math.round(scaleFactor * 100);
  const screenshotName =
    `windows-vscode-${scalePercent}-${width.label}.png`;
  const screenshotPath = path.join(outputDirectory, screenshotName);
  await page.screenshot({ path: screenshotPath });
  const screenshotMetadata = await stat(screenshotPath);
  assert.ok(screenshotMetadata.size > 10_000);
  return {
    label: width.label,
    status: "pass",
    editorCssSize: editor,
    actualDevicePixelRatio: surfaces.devicePixelRatio,
    reviewToolbarCoverage: reviewCoverage,
    screenshot: {
      file: screenshotName,
      bytes: screenshotMetadata.size,
      sha256: await sha256File(screenshotPath),
    },
  };
}

async function terminateProcessTree(child) {
  if (!child?.pid) {
    return;
  }
  try {
    await execFile(
      "taskkill.exe",
      ["/pid", String(child.pid), "/t", "/f"],
      {
        timeout: 15_000,
        windowsHide: true,
      },
    );
  } catch {
    // The browser may already have terminated through the CDP connection.
  }
}

async function runScale({
  drawingPath,
  driverDirectory,
  extensionsDirectory,
  outputDirectory,
  privateRoot,
  scaleFactor,
  vscodeExecutablePath,
}) {
  const scalePercent = Math.round(scaleFactor * 100);
  const userData = path.join(privateRoot, `user-data-${scalePercent}`);
  const settingsDirectory = path.join(userData, "User");
  await mkdir(settingsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(settingsDirectory, "settings.json"),
    `${JSON.stringify(qualificationSettings(), null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const port = await availablePort();
  const environment = {
    ...process.env,
    DWG_VIEWER_QUALIFICATION_DRAWING: drawingPath,
    DWG_VIEWER_QUALIFICATION_TOKEN:
      randomBytes(32).toString("hex"),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    vscodeExecutablePath,
    [
      "--new-window",
      "--locale",
      "en",
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensionsDirectory}`,
      `--extensionDevelopmentPath=${driverDirectory}`,
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=http://127.0.0.1",
      `--force-device-scale-factor=${scaleFactor}`,
      "--window-size=1400,900",
      "--disable-updates",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--no-sandbox",
      "--disable-gpu-sandbox",
    ],
    {
      cwd: privateRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const chunks = [];
  const append = (chunk) => {
    if (
      chunks.reduce((total, value) => total + value.length, 0) <
      128 * 1024
    ) {
      chunks.push(Buffer.from(chunk));
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let browser;
  try {
    const endpoint = await waitForDevtools(
      port,
      child,
      () => Buffer.concat(chunks).toString("utf8"),
    );
    browser = await chromium.connectOverCDP(endpoint);
    const { frame, page } = await findViewerFrame(browser, child);
    await page.bringToFront();
    const interactionEditorCssSize = await setEditorWidth(
      page,
      frame,
      WIDTHS[0].editorWidth,
    );
    assert.ok(
      Math.abs(
        interactionEditorCssSize.width -
          WIDTHS[0].editorWidth,
      ) <= 16,
      `expected interaction editor width ${WIDTHS[0].editorWidth}, got ${interactionEditorCssSize.width}`,
    );
    const interaction = await qualifyReviewInteractions(frame);
    const layout = await qualifyLayoutReset(frame);
    const widths = [];
    for (const width of WIDTHS) {
      widths.push(
        await captureWidth({
          frame,
          page,
          outputDirectory,
          scaleFactor,
          width,
        }),
      );
    }
    return {
      scalePercent,
      requestedDeviceScaleFactor: scaleFactor,
      status: "pass",
      interactionEditorCssSize,
      interaction,
      layout,
      widths,
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await terminateProcessTree(child);
    await rm(userData, WINDOWS_UI_CLEANUP_OPTIONS);
  }
}

export function parseVSCodeVersionOutput(output) {
  if (typeof output !== "string") {
    throw new TypeError("VS Code version output must be a string");
  }
  const version = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!version || !/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(version)) {
    throw new Error("downloaded VS Code has an invalid product version");
  }
  return version;
}

async function productVersion(downloadOptions) {
  const { stdout } = await runVSCodeCommand(
    ["--version"],
    downloadOptions,
  );
  return parseVSCodeVersionOutput(stdout);
}

export async function qualifyWindowsVsCodeUi(options) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Windows VS Code UI qualification requires win32 x64");
  }
  const [drawing, companionVsix, vsix] = await Promise.all([
    ensureFile(options.drawingPath),
    ensureFile(options.companionVsixPath),
    ensureFile(options.vsixPath),
  ]);
  if (
    path.extname(options.companionVsixPath).toLocaleLowerCase("en-US") !==
      ".vsix" ||
    path.extname(options.vsixPath).toLocaleLowerCase("en-US") !==
    ".vsix"
  ) {
    throw new Error("qualification requires a packaged VSIX");
  }
  await mkdir(path.dirname(options.outputDirectory), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(options.outputDirectory, { mode: 0o700 });
  const privateRoot = await mkdtemp(
    path.join(os.tmpdir(), "dwg-windows-vscode-ui-"),
  );
  const driverDirectory = path.join(privateRoot, "driver");
  const extensionsDirectory = path.join(privateRoot, "extensions");
  const installUserData = path.join(privateRoot, "install-user-data");
  const cachePath = path.join(privateRoot, "vscode-cache");
  await Promise.all([
    writeQualificationDriver(driverDirectory),
    mkdir(extensionsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(installUserData, { recursive: true, mode: 0o700 }),
  ]);
  try {
    const downloadOptions = {
      version: "stable",
      platform: "win32-x64-archive",
      cachePath,
    };
    const vscodeExecutablePath =
      await downloadAndUnzipVSCode(downloadOptions);
    const vscodeVersion = await productVersion(downloadOptions);
    await runVSCodeCommand(
      [
        `--user-data-dir=${installUserData}`,
        `--extensions-dir=${extensionsDirectory}`,
        "--install-extension",
        options.companionVsixPath,
        "--force",
      ],
      downloadOptions,
    );
    await runVSCodeCommand(
      [
        `--user-data-dir=${installUserData}`,
        `--extensions-dir=${extensionsDirectory}`,
        "--install-extension",
        options.vsixPath,
        "--force",
      ],
      downloadOptions,
    );
    const { stdout: installedExtensions } = await runVSCodeCommand(
      [
        `--user-data-dir=${installUserData}`,
        `--extensions-dir=${extensionsDirectory}`,
        "--list-extensions",
        "--show-versions",
      ],
      downloadOptions,
    );
    assert.equal(
      installedExtensions
        .split(/\r?\n/u)
        .some((line) =>
          line.startsWith(`${WINDOWS_UI_EXTENSION_ID}@`),
        ),
      true,
      `packaged extension ${WINDOWS_UI_EXTENSION_ID} was not installed`,
    );
    assert.equal(
      installedExtensions
        .split(/\r?\n/u)
        .some((line) =>
          line.startsWith(`${WINDOWS_UI_COMPANION_EXTENSION_ID}@`),
        ),
      true,
      `companion extension ${WINDOWS_UI_COMPANION_EXTENSION_ID} was not installed`,
    );

    const cases = [];
    for (const scaleFactor of SCALE_FACTORS) {
      cases.push(
        await runScale({
          drawingPath: options.drawingPath,
          driverDirectory,
          extensionsDirectory,
          outputDirectory: options.outputDirectory,
          privateRoot,
          scaleFactor,
          vscodeExecutablePath,
        }),
      );
    }
    const report = {
      schema: REPORT_SCHEMA,
      status: "pass",
      target: {
        platform: process.platform,
        architecture: process.arch,
        os: "windows-2025-runner",
        vscodeChannel: "stable",
        vscodeVersion,
        packagedVsixInstalled: true,
        packagedCompanionVsixInstalled: true,
      },
      input: {
        drawingBytes: drawing.size,
        drawingSha256: await sha256File(options.drawingPath),
        vsixBytes: vsix.size,
        vsixSha256: await sha256File(options.vsixPath),
        companionVsixBytes: companionVsix.size,
        companionVsixSha256: await sha256File(
          options.companionVsixPath,
        ),
        pathDisclosure: "none",
      },
      cases,
    };
    await writeJsonExclusive(
      path.join(options.outputDirectory, "report.json"),
      report,
    );
    return report;
  } finally {
    await rm(privateRoot, WINDOWS_UI_CLEANUP_OPTIONS);
  }
}

async function main() {
  const options = parseWindowsUiArguments(process.argv.slice(2));
  const report = await qualifyWindowsVsCodeUi(options);
  process.stdout.write(
    `${JSON.stringify({
      schema: report.schema,
      status: report.status,
      target: report.target,
      scales: report.cases.map((entry) => entry.scalePercent),
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `Windows VS Code UI qualification failed: ${
        error instanceof Error ? error.stack ?? error.message : "unknown error"
      }\n`,
    );
    process.exitCode = 1;
  });
}
