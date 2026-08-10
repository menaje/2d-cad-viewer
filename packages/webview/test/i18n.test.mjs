import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createI18n,
  environmentLocales,
  escapeHtmlText,
  resolveSupportedLocale,
} from "../src/i18n.mjs";
import {
  BUILT_IN_CATALOGS,
} from "../src/locales/index.mjs";

test("resolves exact and base environment locales with an English fallback", () => {
  assert.equal(resolveSupportedLocale(["ko-KR"]), "ko");
  assert.equal(resolveSupportedLocale(["en-US"]), "en");
  assert.equal(resolveSupportedLocale(["ja-JP"]), "en");
  assert.equal(resolveSupportedLocale(["../../ko"]), "en");
});

test("formats catalog messages without interpreting injected values", () => {
  const english = createI18n({ requestedLocales: ["en-GB"] });
  const korean = createI18n({ requestedLocales: ["ko-KR"] });

  assert.equal(english.t("toolbar.fit"), "Fit drawing");
  assert.equal(korean.t("toolbar.fit"), "전체 보기");
  assert.equal(
    english.t("toolbar.fontsWithIssues", { count: "<3>" }),
    "Fonts (<3>)",
  );
  assert.equal(
    english.t("review.runtime.future", { count: 2 }, "Future {count}"),
    "Future 2",
  );
  assert.throws(() => english.t("../toolbar.fit"), /key is invalid/u);
});

test("escapes diagnostic text before inserting it into metric markup", () => {
  assert.equal(
    escapeHtmlText(`<limit reason="A&B">'unsafe'</limit>`),
    "&lt;limit reason=&quot;A&amp;B&quot;&gt;&#39;unsafe&#39;&lt;/limit&gt;",
  );
});

test("prefers the host locale before browser languages", () => {
  assert.deepEqual(
    environmentLocales(
      { documentElement: { dataset: { locale: "ko-KR" } } },
      { languages: ["en-US"] },
    ),
    ["ko-KR", "en-US"],
  );
});

test("built-in locale catalogs stay structurally aligned with the template", async () => {
  const englishKeys = Object.keys(BUILT_IN_CATALOGS.en).sort();
  assert.deepEqual(
    Object.keys(BUILT_IN_CATALOGS.ko).sort(),
    englishKeys,
  );

  const template = await readFile(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  const templateKeys = [
    ...template.matchAll(
      /data-i18n(?:-title|-aria-label|-placeholder)?="([^"]+)"/gu,
    ),
  ].map((match) => match[1]);
  assert.ok(templateKeys.length >= 70);
  for (const key of templateKeys) {
    assert.ok(
      Object.hasOwn(BUILT_IN_CATALOGS.en, key),
      `missing English message: ${key}`,
    );
    assert.ok(
      Object.hasOwn(BUILT_IN_CATALOGS.ko, key),
      `missing Korean message: ${key}`,
    );
  }
});

test("runtime shell and review message keys exist in every built-in catalog", async () => {
  const runtime = (
    await Promise.all(
      ["../src/main.mjs", "../src/review-tools.mjs"].map((path) =>
        readFile(new URL(path, import.meta.url), "utf8"),
      ),
    )
  ).join("\n");
  const runtimeKeys = new Set(
    [...runtime.matchAll(
      /\b(?:t|message)\(\s*["']([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)["']/gu,
    )].map((match) => match[1]),
  );
  assert.ok(runtimeKeys.size >= 250);
  for (const key of runtimeKeys) {
    for (const [locale, messages] of Object.entries(
      BUILT_IN_CATALOGS,
    )) {
      assert.ok(
        Object.hasOwn(messages, key),
        `missing ${locale} runtime message: ${key}`,
      );
    }
  }
});
