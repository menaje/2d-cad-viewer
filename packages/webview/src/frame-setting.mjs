// SPDX-License-Identifier: MPL-2.0

function optionalSetting(value, maximum, label) {
  if (
    value !== null &&
    value !== undefined &&
    (!Number.isInteger(value) || value < 0 || value > maximum)
  ) {
    throw new TypeError(`${label} contains an invalid frame setting`);
  }
  return value ?? null;
}

export function effectiveFrameSetting(frame, specific) {
  const global = optionalSetting(frame, 3, "FRAME");
  const individual = optionalSetting(specific, 2, "individual variable");
  return global !== null && global <= 2 ? global : individual;
}
