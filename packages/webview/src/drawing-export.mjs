const MILLIMETERS_PER_INCH = 25.4;
const DEFAULT_PAGE = Object.freeze({ widthMm: 210, heightMm: 297 });
const MAXIMUM_PAGE_PIXELS = 12_000_000;
const MAXIMUM_PAGE_EDGE = 8_192;
const MAXIMUM_EXPORT_BYTES = 64 * 1024 * 1024;

export const EXPORT_PAPER_PRESETS = Object.freeze({
  a4: Object.freeze({ widthMm: 210, heightMm: 297, label: "A4" }),
  a3: Object.freeze({ widthMm: 297, heightMm: 420, label: "A3" }),
  a2: Object.freeze({ widthMm: 420, heightMm: 594, label: "A2" }),
  a1: Object.freeze({ widthMm: 594, heightMm: 841, label: "A1" }),
  a0: Object.freeze({ widthMm: 841, heightMm: 1_189, label: "A0" }),
  letter: Object.freeze({
    widthMm: 215.9,
    heightMm: 279.4,
    label: "Letter",
  }),
  legal: Object.freeze({
    widthMm: 215.9,
    heightMm: 355.6,
    label: "Legal",
  }),
});

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function orientedSize(size, orientation) {
  if (orientation === "portrait" && size.widthMm > size.heightMm) {
    return { widthMm: size.heightMm, heightMm: size.widthMm };
  }
  if (orientation === "landscape" && size.widthMm < size.heightMm) {
    return { widthMm: size.heightMm, heightMm: size.widthMm };
  }
  return { widthMm: size.widthMm, heightMm: size.heightMm };
}

export function resolvePageGeometry({
  layout = null,
  paper = "drawing",
  orientation = "drawing",
  screenAspect = 1,
} = {}) {
  let source = "fallback";
  let label = "A4";
  let size = DEFAULT_PAGE;
  if (
    paper === "drawing" &&
    positiveFinite(layout?.paperWidth) &&
    positiveFinite(layout?.paperHeight)
  ) {
    size = {
      widthMm: layout.paperWidth,
      heightMm: layout.paperHeight,
    };
    source = "drawing";
    label =
      typeof layout.canonicalMediaName === "string" &&
      layout.canonicalMediaName.trim()
        ? layout.canonicalMediaName.trim().slice(0, 160)
        : "도면 용지";
    if (
      orientation === "drawing" &&
      (layout.rotation === 1 || layout.rotation === 3)
    ) {
      size = {
        widthMm: size.heightMm,
        heightMm: size.widthMm,
      };
    }
  } else if (EXPORT_PAPER_PRESETS[paper]) {
    size = EXPORT_PAPER_PRESETS[paper];
    source = "preset";
    label = size.label;
  } else if (
    paper === "screen" &&
    positiveFinite(screenAspect)
  ) {
    const longEdgeMm = 210;
    size =
      screenAspect >= 1
        ? {
            widthMm: longEdgeMm,
            heightMm: longEdgeMm / screenAspect,
          }
        : {
            widthMm: longEdgeMm * screenAspect,
            heightMm: longEdgeMm,
          };
    source = "screen";
    label = "현재 화면 비율";
  }
  const oriented = orientedSize(size, orientation);
  return Object.freeze({
    ...oriented,
    label,
    source,
    orientation:
      oriented.widthMm > oriented.heightMm ? "landscape" : "portrait",
  });
}

export function pixelsForPage(
  page,
  dpi,
  {
    maximumPixels = MAXIMUM_PAGE_PIXELS,
    maximumEdge = MAXIMUM_PAGE_EDGE,
  } = {},
) {
  if (
    !positiveFinite(page?.widthMm) ||
    !positiveFinite(page?.heightMm) ||
    !positiveFinite(dpi) ||
    !Number.isSafeInteger(maximumPixels) ||
    maximumPixels <= 0 ||
    !Number.isSafeInteger(maximumEdge) ||
    maximumEdge <= 0
  ) {
    throw new RangeError("export page dimensions are invalid");
  }
  const requestedWidth = Math.max(
    1,
    Math.round((page.widthMm / MILLIMETERS_PER_INCH) * dpi),
  );
  const requestedHeight = Math.max(
    1,
    Math.round((page.heightMm / MILLIMETERS_PER_INCH) * dpi),
  );
  const edgeScale = Math.min(
    1,
    maximumEdge / requestedWidth,
    maximumEdge / requestedHeight,
  );
  const pixelScale = Math.min(
    1,
    Math.sqrt(maximumPixels / (requestedWidth * requestedHeight)),
  );
  const scale = Math.min(edgeScale, pixelScale);
  const width = Math.max(1, Math.floor(requestedWidth * scale));
  const height = Math.max(1, Math.floor(requestedHeight * scale));
  return Object.freeze({
    width,
    height,
    requestedWidth,
    requestedHeight,
    requestedDpi: dpi,
    effectiveDpi: dpi * scale,
    limited: scale < 1,
  });
}

export function fitCameraView(bounds, aspect, padding = 1.04) {
  if (
    !bounds?.min?.every(Number.isFinite) ||
    !bounds?.max?.every(Number.isFinite) ||
    bounds.min.length < 2 ||
    bounds.max.length < 2 ||
    bounds.min[0] > bounds.max[0] ||
    bounds.min[1] > bounds.max[1] ||
    !positiveFinite(aspect) ||
    !positiveFinite(padding)
  ) {
    throw new TypeError("cannot fit an invalid export view");
  }
  const width = Math.max(bounds.max[0] - bounds.min[0], 1e-6);
  const height = Math.max(bounds.max[1] - bounds.min[1], 1e-6);
  return Object.freeze({
    origin: Object.freeze([
      bounds.min[0] * 0.5 + bounds.max[0] * 0.5,
      bounds.min[1] * 0.5 + bounds.max[1] * 0.5,
      Number.isFinite(bounds.min[2]) && Number.isFinite(bounds.max[2])
        ? bounds.min[2] * 0.5 + bounds.max[2] * 0.5
        : 0,
    ]),
    worldHeight: Math.max(height, width / aspect) * padding,
  });
}

export function scaleCameraView(
  center,
  pageHeightMm,
  denominator,
  drawingUnitsPerMillimeter = 1,
) {
  if (
    !Array.isArray(center) ||
    center.length < 2 ||
    !center.slice(0, 2).every(Number.isFinite) ||
    !positiveFinite(pageHeightMm) ||
    !positiveFinite(denominator) ||
    !positiveFinite(drawingUnitsPerMillimeter)
  ) {
    throw new TypeError("cannot create an invalid scaled export view");
  }
  return Object.freeze({
    origin: Object.freeze([
      center[0],
      center[1],
      Number.isFinite(center[2]) ? center[2] : 0,
    ]),
    worldHeight:
      pageHeightMm * denominator * drawingUnitsPerMillimeter,
  });
}

export function sanitizeExportStem(value, fallback = "drawing") {
  const normalized =
    typeof value === "string"
      ? value
          .normalize("NFC")
          .replace(/\.[^.\\/]+$/u, "")
          .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
          .replace(/[.\s]+$/gu, "")
          .trim()
      : "";
  return (normalized || fallback).slice(0, 120);
}

function requireBytes(value, label) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be Uint8Array`);
  }
  return value;
}

export function makeLayoutPngZipEntries(pages) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 255) {
    throw new RangeError("layout PNG ZIP requires between 1 and 255 pages");
  }
  const width = Math.max(2, String(pages.length).length);
  const manifest = [
    "2D CAD Viewer layout PNG files",
    "PNG file\tDrawing layout name",
  ];
  const entries = pages.map((page, index) => {
    const data = requireBytes(
      page?.data,
      `layout PNG page ${index + 1}`,
    );
    const number = String(index + 1).padStart(width, "0");
    const fileName = `${number}-layout.png`;
    const label =
      typeof page?.label === "string" && page.label.trim()
        ? page.label
            .normalize("NFC")
            .replace(/[\r\n\t]+/gu, " ")
            .trim()
            .slice(0, 240)
        : `Layout ${number}`;
    manifest.push(`${fileName}\t${label}`);
    return Object.freeze({
      name: `${number}-layout`,
      extension: ".png",
      data,
    });
  });
  entries.push(
    Object.freeze({
      name: "layout-names",
      extension: ".txt",
      data: new TextEncoder().encode(`${manifest.join("\n")}\n`),
    }),
  );
  return Object.freeze(entries);
}

function ascii(value) {
  return new TextEncoder().encode(value);
}

function concatBytes(parts, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    throw new RangeError("export output exceeds its byte limit");
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function pdfNumber(value) {
  return Number(value.toFixed(4)).toString();
}

export function makeRasterPdf(
  pages,
  { maximumBytes = MAXIMUM_EXPORT_BYTES } = {},
) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 256) {
    throw new RangeError("PDF requires between 1 and 256 pages");
  }
  const objectCount = 2 + pages.length * 3;
  const objects = new Array(objectCount + 1);
  const pageObjects = pages.map((_page, index) => 3 + index * 3);
  objects[1] = ascii("<< /Type /Catalog /Pages 2 0 R >>");
  objects[2] = ascii(
    `<< /Type /Pages /Count ${pages.length} /Kids [` +
      pageObjects.map((number) => `${number} 0 R`).join(" ") +
      "] >>",
  );
  pages.forEach((page, index) => {
    const jpeg = requireBytes(page.jpeg, `PDF page ${index + 1} image`);
    if (
      jpeg.length < 4 ||
      jpeg[0] !== 0xff ||
      jpeg[1] !== 0xd8 ||
      !positiveFinite(page.widthMm) ||
      !positiveFinite(page.heightMm) ||
      !Number.isSafeInteger(page.pixelWidth) ||
      page.pixelWidth <= 0 ||
      !Number.isSafeInteger(page.pixelHeight) ||
      page.pixelHeight <= 0
    ) {
      throw new TypeError(`PDF page ${index + 1} is invalid`);
    }
    const pageObject = 3 + index * 3;
    const imageObject = pageObject + 1;
    const contentObject = pageObject + 2;
    const widthPoints = (page.widthMm / MILLIMETERS_PER_INCH) * 72;
    const heightPoints = (page.heightMm / MILLIMETERS_PER_INCH) * 72;
    const imageName = `Im${index + 1}`;
    objects[pageObject] = ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ` +
        `${pdfNumber(widthPoints)} ${pdfNumber(heightPoints)}] ` +
        `/Resources << /XObject << /${imageName} ${imageObject} 0 R >> >> ` +
        `/Contents ${contentObject} 0 R >>`,
    );
    objects[imageObject] = concatBytes([
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} ` +
          `/Height ${page.pixelHeight} /ColorSpace /DeviceRGB ` +
          `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      ascii("\nendstream"),
    ]);
    const content = ascii(
      `q\n${pdfNumber(widthPoints)} 0 0 ${pdfNumber(
        heightPoints,
      )} 0 0 cm\n/${imageName} Do\nQ\n`,
    );
    objects[contentObject] = concatBytes([
      ascii(`<< /Length ${content.length} >>\nstream\n`),
      content,
      ascii("endstream"),
    ]);
  });

  const parts = [ascii("%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n")];
  const offsets = new Array(objectCount + 1).fill(0);
  let position = parts[0].length;
  for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
    offsets[objectNumber] = position;
    const object = concatBytes([
      ascii(`${objectNumber} 0 obj\n`),
      objects[objectNumber],
      ascii("\nendobj\n"),
    ]);
    parts.push(object);
    position += object.length;
    if (position > maximumBytes) {
      throw new RangeError("PDF output exceeds its byte limit");
    }
  }
  const xrefOffset = position;
  const xref = [
    `xref\n0 ${objectCount + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\n`,
    `startxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  parts.push(ascii(xref));
  return concatBytes(parts, maximumBytes);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function littleEndianHeader(length) {
  return new Uint8Array(length);
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function unicodePathExtra(nameBytes) {
  const extra = new Uint8Array(9 + nameBytes.length);
  const view = new DataView(extra.buffer);
  writeU16(view, 0, 0x7075);
  writeU16(view, 2, 5 + nameBytes.length);
  extra[4] = 1;
  writeU32(view, 5, crc32(nameBytes));
  extra.set(nameBytes, 9);
  return extra;
}

export function makeStoredZip(
  files,
  { maximumBytes = MAXIMUM_EXPORT_BYTES } = {},
) {
  if (!Array.isArray(files) || files.length === 0 || files.length > 256) {
    throw new RangeError("ZIP requires between 1 and 256 files");
  }
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [index, file] of files.entries()) {
    const data = requireBytes(file.data, `ZIP file ${index + 1}`);
    const name = sanitizeExportStem(file.name, `drawing-${index + 1}`) +
      (typeof file.extension === "string" ? file.extension : "");
    const nameBytes = encoder.encode(name);
    if (nameBytes.length === 0 || nameBytes.length > 1_024) {
      throw new RangeError(`ZIP file ${index + 1} name is invalid`);
    }
    const checksum = crc32(data);
    const pathExtra = unicodePathExtra(nameBytes);
    const local = littleEndianHeader(30);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x0800);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, 0);
    writeU16(localView, 12, 0x0021);
    writeU32(localView, 14, checksum);
    writeU32(localView, 18, data.length);
    writeU32(localView, 22, data.length);
    writeU16(localView, 26, nameBytes.length);
    writeU16(localView, 28, pathExtra.length);
    localParts.push(local, nameBytes, pathExtra, data);

    const central = littleEndianHeader(46);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x0800);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, 0);
    writeU16(centralView, 14, 0x0021);
    writeU32(centralView, 16, checksum);
    writeU32(centralView, 20, data.length);
    writeU32(centralView, 24, data.length);
    writeU16(centralView, 28, nameBytes.length);
    writeU16(centralView, 30, pathExtra.length);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, localOffset);
    centralParts.push(central, nameBytes, pathExtra);
    localOffset +=
      local.length + nameBytes.length + pathExtra.length + data.length;
    if (localOffset > maximumBytes) {
      throw new RangeError("ZIP output exceeds its byte limit");
    }
  }
  const centralDirectory = concatBytes(centralParts, maximumBytes);
  const end = littleEndianHeader(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 4, 0);
  writeU16(endView, 6, 0);
  writeU16(endView, 8, files.length);
  writeU16(endView, 10, files.length);
  writeU32(endView, 12, centralDirectory.length);
  writeU32(endView, 16, localOffset);
  writeU16(endView, 20, 0);
  return concatBytes([...localParts, centralDirectory, end], maximumBytes);
}

export function bytesToBase64(bytes) {
  requireBytes(bytes, "export bytes");
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

export {
  DEFAULT_PAGE,
  MAXIMUM_EXPORT_BYTES,
  MAXIMUM_PAGE_EDGE,
  MAXIMUM_PAGE_PIXELS,
  MILLIMETERS_PER_INCH,
};
