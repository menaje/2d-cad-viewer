import assert from "node:assert/strict";
import test from "node:test";

import {
  calibrationFromKnownDistance,
  createMeasurementFormat,
  insertionUnitInfo,
  normalizeMeasurementPreferences,
} from "../src/measurement-format.mjs";

test("known DWG insertion units convert lengths, areas, and points", () => {
  const measurement = createMeasurementFormat(4, {
    displayUnit: "m",
  });

  assert.equal(measurement.sourceUnit.label, "mm");
  assert.equal(measurement.displayUnit.label, "m");
  assert.equal(measurement.length(2_500), "2.5 m");
  assert.equal(measurement.area(1_000_000), "1 m²");
  assert.equal(
    measurement.point([1_000, 2_500, 0]),
    "X 1 · Y 2.5 · Z 0 m",
  );
});

test("fixed measurement precision applies after unit conversion", () => {
  const measurement = createMeasurementFormat(4, {
    displayUnit: "cm",
    precision: 3,
  });

  assert.equal(measurement.length(25), "2.500 cm");
  assert.equal(measurement.area(250), "2.500 cm²");
  assert.equal(measurement.number(90), "90.000");
});

test("unitless drawings cannot claim a physical unit before calibration", () => {
  const measurement = createMeasurementFormat(0, {
    displayUnit: "mm",
  });

  assert.equal(measurement.canUsePhysicalUnits, false);
  assert.equal(measurement.displayUnit.key, "drawing");
  assert.equal(measurement.length(25), "25 도면 단위");
});

test("measurement output follows the viewer locale and drawing-unit label", () => {
  const measurement = createMeasurementFormat(
    0,
    { precision: 2 },
    { locale: "en-US", drawingUnitLabel: "drawing units" },
  );

  assert.equal(measurement.sourceUnit.label, "drawing units");
  assert.equal(measurement.length(1_234.5), "1,234.50 drawing units");
});

test("two-point calibration unlocks physical length and area values", () => {
  const calibration = calibrationFromKnownDistance(100, 2, "m");
  assert.deepEqual(calibration, {
    millimetersPerDrawingUnit: 20,
    referenceDistance: 2,
    referenceUnit: "m",
    drawingDistance: 100,
  });

  const measurement = createMeasurementFormat(0, {
    displayUnit: "m",
    calibration,
  });
  assert.equal(measurement.canUsePhysicalUnits, true);
  assert.equal(measurement.calibrated, true);
  assert.equal(measurement.length(50), "1 m");
  assert.equal(measurement.area(2_500), "1 m²");
});

test("invalid calibrations and unsupported precision values are ignored", () => {
  assert.equal(calibrationFromKnownDistance(0, 1, "mm"), null);
  assert.equal(calibrationFromKnownDistance(1, -1, "mm"), null);
  assert.equal(calibrationFromKnownDistance(1, 1, "unknown"), null);
  assert.equal(
    normalizeMeasurementPreferences({ precision: 7 }).precision,
    null,
  );
  assert.equal(insertionUnitInfo(999).label, "도면 단위");
});
