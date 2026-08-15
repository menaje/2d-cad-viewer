const BY_LAYER = 0;
const BY_BLOCK = 1;
const CONTINUOUS = 2;
const MAX_CODE = 2047;
const MAX_SHADER_DASHES = 64;

function key(value) {
  return String(value ?? "")
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("en-US");
}

export function linetypeCodeByName(linetypes) {
  const output = new Map([
    ["bylayer", BY_LAYER],
    ["byblock", BY_BLOCK],
    ["continuous", CONTINUOUS],
  ]);
  for (const linetype of linetypes ?? []) {
    const name = key(linetype?.name);
    if (
      name &&
      Number.isInteger(linetype?.code) &&
      linetype.code >= 0 &&
      linetype.code <= MAX_CODE
    ) {
      output.set(name, linetype.code);
    }
  }
  return output;
}

export function layerLinetypeCodes(layers, linetypes) {
  const byName = linetypeCodeByName(linetypes);
  return Uint16Array.from(layers ?? [], (layer) => {
    const code = byName.get(key(layer?.linetype));
    return Number.isInteger(code) && code >= CONTINUOUS
      ? code
      : CONTINUOUS;
  });
}

export function makeLinetypeTextureData(linetypes) {
  let maximumCode = CONTINUOUS;
  let dashCount = 0;
  let complexCount = 0;
  let truncatedCount = 0;
  for (const definition of linetypes ?? []) {
    maximumCode = Math.max(maximumCode, definition.code);
    dashCount += Math.min(
      definition.dashes?.length ?? 0,
      MAX_SHADER_DASHES,
    );
    if (definition.flags & 1) {
      complexCount += 1;
    }
    if ((definition.dashes?.length ?? 0) > MAX_SHADER_DASHES) {
      truncatedCount += 1;
    }
  }
  const headers = new Float32Array((maximumCode + 1) * 4);
  const dashes = new Float32Array(Math.max(dashCount, 1));
  let dashCursor = 0;
  for (const definition of linetypes ?? []) {
    const code = definition.code;
    if (!Number.isInteger(code) || code < 0 || code > MAX_CODE) {
      continue;
    }
    const sourceDashes = definition.dashes ?? [];
    const count = Math.min(sourceDashes.length, MAX_SHADER_DASHES);
    const offset = code * 4;
    headers[offset] =
      Number.isFinite(definition.patternLength) &&
      definition.patternLength > 0
        ? definition.patternLength
        : sourceDashes.reduce(
            (total, dash) => total + Math.abs(dash.length),
            0,
          );
    headers[offset + 1] = dashCursor;
    headers[offset + 2] = count;
    headers[offset + 3] =
      (definition.flags & 1 ? 1 : 0) +
      (definition.alignment === 65 ? 2 : 0);
    for (let index = 0; index < count; index += 1) {
      dashes[dashCursor] = sourceDashes[index].length;
      dashCursor += 1;
    }
  }
  return Object.freeze({
    headers,
    dashes,
    maximumCode,
    dashCount,
    complexCount,
    truncatedCount,
  });
}

export const CadLinetypeCode = Object.freeze({
  ByLayer: BY_LAYER,
  ByBlock: BY_BLOCK,
  Continuous: CONTINUOUS,
});

export { MAX_SHADER_DASHES };
