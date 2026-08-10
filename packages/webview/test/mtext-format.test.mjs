import assert from "node:assert/strict";
import test from "node:test";

import {
  cadMTextParagraphStart,
  DEFAULT_MTEXT_FORMAT,
  measureCadMTextLine,
  nextCadMTextTabAdvance,
  parseCadMTextRuns,
  plainCadMTextLines,
  wrapCadMTextRuns,
} from "../src/mtext-format.mjs";

test("preserves bounded inline MTEXT formatting and restores nested blocks", () => {
  const lines = parseCadMTextRuns(
    String.raw`\A1;{\fHCR Batang|b1|i0|c129|p18;\H0.83333x;\C2;➀}23F \W0.5;\T1.5;\Q20;\L폭\l`,
    { baseHeight: 2 },
  );

  assert.equal(plainCadMTextLines(
    String.raw`\A1;{\fHCR Batang|b1|i0|c129|p18;\H0.83333x;\C2;➀}23F \W0.5;\T1.5;\Q20;\L폭\l`,
  )[0], "➀23F 폭");
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0].text, "➀");
  assert.equal(lines[0][0].format.fontFile, "HCR Batang");
  assert.equal(lines[0][0].format.bold, true);
  assert.equal(lines[0][0].format.italic, false);
  assert.equal(lines[0][0].format.heightScale, 0.83333);
  assert.equal(lines[0][0].format.color, ((2 << 30) | 2) >>> 0);
  assert.equal(lines[0][1].text, "23F ");
  assert.deepEqual(lines[0][1].format, DEFAULT_MTEXT_FORMAT);
  assert.equal(lines[0][2].text, "폭");
  assert.equal(lines[0][2].format.widthScale, 0.5);
  assert.equal(lines[0][2].format.tracking, 1.5);
  assert.ok(
    Math.abs(lines[0][2].format.obliqueAngle - Math.PI / 9) < 1e-12,
  );
  assert.equal(lines[0][2].format.underline, true);
});

test("handles absolute heights, paragraphs, percent codes and stacked text", () => {
  const value = String.raw`\H4;큰%%d\P\S위^아래;\U+00B1`;
  const lines = parseCadMTextRuns(value, { baseHeight: 2 });

  assert.deepEqual(plainCadMTextLines(value), ["큰°", "위/아래±"]);
  assert.equal(lines[0][0].format.heightScale, 2);
  assert.equal(lines[1][0].format.heightScale, 2);
  assert.deepEqual(lines[1][0].stack, {
    upper: "위",
    lower: "아래",
    separator: "tolerance",
  });
  assert.equal(lines[1][1].text, "±");
});

test("treats literal CRLF, CR and LF in MTEXT as line breaks", () => {
  const lines = plainCadMTextLines("첫째\r\n둘째\r셋째\n넷째");

  assert.deepEqual(lines, ["첫째", "둘째", "셋째", "넷째"]);
});

test("preserves horizontal, diagonal, tolerance and one-sided stacks", () => {
  const lines = parseCadMTextRuns(
    String.raw`\S1/2; \S3#4; \S+0.1^-0.2; \S^2; \S3^;`,
  );

  assert.deepEqual(
    lines[0].filter((run) => run.stack).map((run) => run.stack),
    [
      { upper: "1", lower: "2", separator: "horizontal" },
      { upper: "3", lower: "4", separator: "diagonal" },
      {
        upper: "+0.1",
        lower: "-0.2",
        separator: "tolerance",
      },
      { upper: "", lower: "2", separator: "tolerance" },
      { upper: "3", lower: "", separator: "tolerance" },
    ],
  );
  assert.deepEqual(plainCadMTextLines(
    String.raw`\S1/2; \S3#4; \S+0.1^-0.2;`,
  ), ["1/2 3/4 +0.1/-0.2"]);
});

test("does not expose unsupported paragraph properties as drawing text", () => {
  assert.deepEqual(
    plainCadMTextLines(String.raw`\pi2,l4,t6;들여쓰기\P다음`),
    ["들여쓰기", "다음"],
  );
  assert.deepEqual(plainCadMTextLines(String.raw`첫째\p둘째`), [
    "첫째",
    "둘째",
  ]);
});

test("preserves paragraph indents, alignment, tab stops and caret tabs", () => {
  const lines = parseCadMTextRuns(
    String.raw`\pxi-2,l2,r1,qc,t4,c8,r12;항목^I값\P다음`,
  );
  const paragraph = lines[0].paragraph;

  assert.deepEqual(paragraph, {
    indent: -2,
    left: 2,
    right: 1,
    alignment: "center",
    tabStops: [
      { position: 4, alignment: "left" },
      { position: 8, alignment: "center" },
      { position: 12, alignment: "right" },
    ],
  });
  assert.equal(lines[1].paragraph, paragraph);
  assert.deepEqual(
    lines.map((line) => line.map((run) => run.text).join("")),
    ["항목\t값", "다음"],
  );
  assert.equal(cadMTextParagraphStart(paragraph, 0), 0);
  assert.equal(cadMTextParagraphStart(paragraph, 1), 2);
  assert.equal(nextCadMTextTabAdvance(2, paragraph, 0), 2);
  assert.equal(measureCadMTextLine(lines[0], () => 1), 5);
});

test("normalizes stored paragraph distances and clears tab stops", () => {
  const lines = parseCadMTextRuns(
    String.raw`\pxi-600,l600,t600;항목^I값\P\pi0,l0,tz;초기화`,
    { baseHeight: 600 },
  );

  assert.deepEqual(lines[0].paragraph, {
    indent: -1,
    left: 1,
    right: 0,
    alignment: "default",
    tabStops: [{ position: 1, alignment: "left" }],
  });
  assert.deepEqual(lines[1].paragraph, {
    indent: 0,
    left: 0,
    right: 0,
    alignment: "default",
    tabStops: [],
  });
});

test("wraps rich MTEXT without losing run formatting", () => {
  const source = parseCadMTextRuns(
    String.raw`AB {\H2x;CD} EF`,
  );
  const wrapped = wrapCadMTextRuns(
    source,
    4,
    (_character, format) => format.heightScale,
  );

  assert.deepEqual(
    wrapped.map((line) => line.map((run) => run.text).join("")),
    ["AB", "CD", "EF"],
  );
  assert.equal(wrapped[1][0].format.heightScale, 2);
  assert.equal(measureCadMTextLine(wrapped[1],
    (_character, format) => format.heightScale), 4);
  assert.deepEqual(
    wrapCadMTextRuns(parseCadMTextRuns("   "), 4),
    [Object.freeze([])],
  );
});

test("wraps a stacked fraction as one measured unit", () => {
  const source = parseCadMTextRuns(String.raw`ABC \S1/2; CD`);
  const wrapped = wrapCadMTextRuns(
    source,
    5,
    (text, _format, stack) => stack ? 2 : [...text].length,
  );

  assert.deepEqual(
    wrapped.map((line) => line.map((run) => run.text).join("")),
    ["ABC", "1/2 CD"],
  );
  assert.equal(wrapped[1][0].stack.separator, "horizontal");
  assert.equal(
    measureCadMTextLine(
      wrapped[1],
      (text, _format, stack) => stack ? 2 : [...text].length,
    ),
    5,
  );
});

test("uses first-line and continuation indents while wrapping", () => {
  const source = parseCadMTextRuns(
    String.raw`\pxi2,l1,r1;ABCD EFGH`,
  );
  const wrapped = wrapCadMTextRuns(source, 8, () => 1);

  assert.deepEqual(
    wrapped.map((line) => line.map((run) => run.text).join("")),
    ["ABCD", "EFGH"],
  );
  assert.deepEqual(
    wrapped.map((line) => line.paragraphLine),
    [0, 1],
  );
  assert.deepEqual(
    wrapped.map((line) =>
      cadMTextParagraphStart(line.paragraph, line.paragraphLine),
    ),
    [3, 1],
  );
});
