const DRAWING_UNIT = Object.freeze({
  key: "drawing",
  label: "도면 단위",
  millimeters: null,
});

const UNIT_DEFINITIONS = Object.freeze([
  Object.freeze({ key: "in", label: "in", millimeters: 25.4 }),
  Object.freeze({ key: "ft", label: "ft", millimeters: 304.8 }),
  Object.freeze({ key: "mi", label: "mi", millimeters: 1_609_344 }),
  Object.freeze({ key: "mm", label: "mm", millimeters: 1 }),
  Object.freeze({ key: "cm", label: "cm", millimeters: 10 }),
  Object.freeze({ key: "m", label: "m", millimeters: 1_000 }),
  Object.freeze({ key: "km", label: "km", millimeters: 1_000_000 }),
  Object.freeze({ key: "microin", label: "µin", millimeters: 0.0000254 }),
  Object.freeze({ key: "mil", label: "mil", millimeters: 0.0254 }),
  Object.freeze({ key: "yd", label: "yd", millimeters: 914.4 }),
  Object.freeze({ key: "angstrom", label: "Å", millimeters: 1e-7 }),
  Object.freeze({ key: "nm", label: "nm", millimeters: 1e-6 }),
  Object.freeze({ key: "micron", label: "µm", millimeters: 0.001 }),
  Object.freeze({ key: "dm", label: "dm", millimeters: 100 }),
  Object.freeze({ key: "dam", label: "dam", millimeters: 10_000 }),
  Object.freeze({ key: "hm", label: "hm", millimeters: 100_000 }),
  Object.freeze({ key: "gm", label: "Gm", millimeters: 1e12 }),
  Object.freeze({
    key: "au",
    label: "AU",
    millimeters: 149_597_870_700_000,
  }),
  Object.freeze({
    key: "ly",
    label: "ly",
    millimeters: 9.4607304725808e18,
  }),
  Object.freeze({
    key: "pc",
    label: "pc",
    millimeters: 3.0856775814913673e19,
  }),
  Object.freeze({
    key: "us-ft",
    label: "US ft",
    millimeters: 1_200_000 / 3_937,
  }),
  Object.freeze({
    key: "us-in",
    label: "US in",
    millimeters: 100_000 / 3_937,
  }),
  Object.freeze({
    key: "us-yd",
    label: "US yd",
    millimeters: 3_600_000 / 3_937,
  }),
  Object.freeze({
    key: "us-mi",
    label: "US mi",
    millimeters: 6_336_000_000 / 3_937,
  }),
]);

const UNIT_BY_KEY = new Map(
  UNIT_DEFINITIONS.map((unit) => [unit.key, unit]),
);

export const COMMON_DISPLAY_UNITS = Object.freeze(
  ["mm", "cm", "m", "km", "in", "ft", "yd"].map((key) =>
    UNIT_BY_KEY.get(key),
  ),
);

export function insertionUnitInfo(code) {
  return Number.isInteger(code) && code >= 1 && code <= UNIT_DEFINITIONS.length
    ? UNIT_DEFINITIONS[code - 1]
    : DRAWING_UNIT;
}

export function measurementUnitInfo(key) {
  return key === "drawing"
    ? DRAWING_UNIT
    : UNIT_BY_KEY.get(key) ?? null;
}

export function normalizeMeasurementPreferences(value = {}) {
  const precision =
    value.precision === null ||
    value.precision === "auto" ||
    value.precision === undefined
      ? null
      : Number.isInteger(value.precision) &&
          value.precision >= 0 &&
          value.precision <= 6
        ? value.precision
        : null;
  const displayUnit =
    value.displayUnit === "auto" ||
    value.displayUnit === "drawing" ||
    UNIT_BY_KEY.has(value.displayUnit)
      ? value.displayUnit
      : "auto";
  const rawCalibration = value.calibration;
  const calibration =
    rawCalibration &&
    Number.isFinite(rawCalibration.millimetersPerDrawingUnit) &&
    rawCalibration.millimetersPerDrawingUnit > 0
      ? Object.freeze({
          millimetersPerDrawingUnit:
            rawCalibration.millimetersPerDrawingUnit,
          referenceDistance:
            Number.isFinite(rawCalibration.referenceDistance) &&
            rawCalibration.referenceDistance > 0
              ? rawCalibration.referenceDistance
              : null,
          referenceUnit:
            UNIT_BY_KEY.has(rawCalibration.referenceUnit)
              ? rawCalibration.referenceUnit
              : "mm",
          drawingDistance:
            Number.isFinite(rawCalibration.drawingDistance) &&
            rawCalibration.drawingDistance > 0
              ? rawCalibration.drawingDistance
              : null,
        })
      : null;
  return Object.freeze({
    displayUnit,
    precision,
    calibration,
  });
}

export function formatMeasurementNumber(
  value,
  precision = null,
  locale = "ko-KR",
) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const normalized = Math.abs(value) < 1e-9 ? 0 : value;
  if (Number.isInteger(precision)) {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
      useGrouping: true,
    }).format(normalized);
  }
  const magnitude = Math.abs(normalized);
  const maximumFractionDigits =
    magnitude >= 10_000 ? 1 : magnitude >= 100 ? 2 : 4;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits,
    useGrouping: true,
  }).format(normalized);
}

export function calibrationFromKnownDistance(
  drawingDistance,
  referenceDistance,
  referenceUnit,
) {
  const unit = UNIT_BY_KEY.get(referenceUnit);
  if (
    !Number.isFinite(drawingDistance) ||
    drawingDistance <= 0 ||
    !Number.isFinite(referenceDistance) ||
    referenceDistance <= 0 ||
    !unit
  ) {
    return null;
  }
  const millimetersPerDrawingUnit =
    (referenceDistance * unit.millimeters) / drawingDistance;
  if (
    !Number.isFinite(millimetersPerDrawingUnit) ||
    millimetersPerDrawingUnit <= 0
  ) {
    return null;
  }
  return Object.freeze({
    millimetersPerDrawingUnit,
    referenceDistance,
    referenceUnit: unit.key,
    drawingDistance,
  });
}

export function createMeasurementFormat(
  insertionUnits,
  rawPreferences = {},
  {
    locale = "ko-KR",
    drawingUnitLabel = DRAWING_UNIT.label,
  } = {},
) {
  const preferences = normalizeMeasurementPreferences(rawPreferences);
  const sourceDefinition = insertionUnitInfo(insertionUnits);
  const localizedDrawingUnit = Object.freeze({
    ...DRAWING_UNIT,
    label: drawingUnitLabel,
  });
  const localizedUnit = (unit) =>
    unit === DRAWING_UNIT ? localizedDrawingUnit : unit;
  const sourceUnit = localizedUnit(sourceDefinition);
  const calibrated =
    sourceDefinition === DRAWING_UNIT ? preferences.calibration : null;
  const millimetersPerDrawingUnit =
    sourceUnit.millimeters ?? calibrated?.millimetersPerDrawingUnit ?? null;
  const requestedDefinition =
    preferences.displayUnit === "auto"
      ? sourceDefinition !== DRAWING_UNIT
        ? sourceDefinition
        : calibrated
          ? UNIT_BY_KEY.get(calibrated.referenceUnit)
          : DRAWING_UNIT
      : measurementUnitInfo(preferences.displayUnit) ?? DRAWING_UNIT;
  const displayDefinition =
    requestedDefinition !== DRAWING_UNIT && millimetersPerDrawingUnit === null
      ? DRAWING_UNIT
      : requestedDefinition;
  const displayUnit = localizedUnit(displayDefinition);
  const lengthScale =
    displayDefinition === DRAWING_UNIT
      ? 1
      : millimetersPerDrawingUnit / displayUnit.millimeters;
  const number = (value) =>
    formatMeasurementNumber(value, preferences.precision, locale);
  const lengthValue = (value) => value * lengthScale;
  const areaValue = (value) => value * lengthScale * lengthScale;
  const length = (value) =>
    `${number(lengthValue(value))} ${displayUnit.label}`;
  const area = (value) =>
    `${number(areaValue(value))} ${displayUnit.label}²`;
  const point = (value) =>
    `X ${number(lengthValue(value[0]))} · ` +
    `Y ${number(lengthValue(value[1]))} · ` +
    `Z ${number(lengthValue(value[2]))} ${displayUnit.label}`;
  return Object.freeze({
    insertionUnits,
    preferences,
    sourceUnit,
    displayUnit,
    calibrated: Boolean(calibrated),
    canUsePhysicalUnits: millimetersPerDrawingUnit !== null,
    millimetersPerDrawingUnit,
    lengthScale,
    number,
    lengthValue,
    areaValue,
    length,
    area,
    point,
  });
}

export { DRAWING_UNIT, UNIT_DEFINITIONS };
