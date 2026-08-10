import {
  BUILT_IN_CATALOGS,
  DEFAULT_LOCALE,
} from "./locales/index.mjs";

const MAXIMUM_LOCALE_LENGTH = 64;
const MAXIMUM_MESSAGE_KEY_LENGTH = 128;
const MESSAGE_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*$/u;
const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ps", "ur"]);
const ATTRIBUTE_BINDINGS = Object.freeze([
  Object.freeze(["data-i18n", "textContent"]),
  Object.freeze(["data-i18n-title", "title"]),
  Object.freeze(["data-i18n-aria-label", "aria-label"]),
  Object.freeze(["data-i18n-placeholder", "placeholder"]),
]);
const HTML_TEXT_ENTITIES = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

export function escapeHtmlText(value) {
  return String(value).replace(/[&<>"']/gu, (character) =>
    HTML_TEXT_ENTITIES[character],
  );
}

function canonicalLocale(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_LOCALE_LENGTH
  ) {
    return null;
  }
  const candidate = value.trim().replaceAll("_", "-");
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(candidate)) {
    return null;
  }
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? null;
  } catch {
    return null;
  }
}

function requestedLocaleList(value) {
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value) ? value : [];
}

export function resolveSupportedLocale(
  requestedLocales,
  catalogs = BUILT_IN_CATALOGS,
  fallbackLocale = DEFAULT_LOCALE,
) {
  const supported = new Set(Object.keys(catalogs));
  for (const requested of requestedLocaleList(requestedLocales)) {
    const canonical = canonicalLocale(requested);
    if (!canonical) {
      continue;
    }
    const normalized = canonical.toLowerCase();
    if (supported.has(normalized)) {
      return normalized;
    }
    const language = normalized.split("-")[0];
    if (supported.has(language)) {
      return language;
    }
  }
  return supported.has(fallbackLocale)
    ? fallbackLocale
    : Object.keys(catalogs)[0];
}

function normalizedMessageKey(key) {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAXIMUM_MESSAGE_KEY_LENGTH ||
    !MESSAGE_KEY_PATTERN.test(key)
  ) {
    throw new TypeError("localization message key is invalid");
  }
  return key;
}

function interpolate(template, values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return template;
  }
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

export function createI18n({
  requestedLocales = [],
  catalogs = BUILT_IN_CATALOGS,
  fallbackLocale = DEFAULT_LOCALE,
} = {}) {
  const locale = resolveSupportedLocale(
    requestedLocales,
    catalogs,
    fallbackLocale,
  );
  const messages = catalogs[locale] ?? {};
  const fallbackMessages = catalogs[fallbackLocale] ?? {};
  const language = locale.split("-")[0];

  function t(key, values, fallbackTemplate) {
    const normalizedKey = normalizedMessageKey(key);
    const template =
      messages[normalizedKey] ??
      fallbackMessages[normalizedKey] ??
      (typeof fallbackTemplate === "string" ? fallbackTemplate : undefined) ??
      normalizedKey;
    return interpolate(template, values);
  }

  function localize(root) {
    if (!root || typeof root.querySelectorAll !== "function") {
      throw new TypeError("localization root must support querySelectorAll");
    }
    for (const [attribute, property] of ATTRIBUTE_BINDINGS) {
      for (const element of root.querySelectorAll(`[${attribute}]`)) {
        const key = element.getAttribute(attribute);
        if (!key) {
          continue;
        }
        const value = t(key);
        if (property === "textContent") {
          element.textContent = value;
        } else {
          element.setAttribute(property, value);
        }
      }
    }
    const documentElement = root.documentElement;
    if (documentElement) {
      documentElement.lang = locale;
      documentElement.dir = RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
      documentElement.dataset.resolvedLocale = locale;
    }
    return locale;
  }

  return Object.freeze({
    locale,
    direction: RTL_LANGUAGES.has(language) ? "rtl" : "ltr",
    t,
    localize,
    formatNumber(value, options) {
      return new Intl.NumberFormat(locale, options).format(value);
    },
  });
}

export function environmentLocales(
  documentObject = globalThis.document,
  navigatorObject = globalThis.navigator,
) {
  const explicit = documentObject?.documentElement?.dataset?.locale;
  const browserLocales = Array.isArray(navigatorObject?.languages)
    ? navigatorObject.languages
    : [navigatorObject?.language];
  return [explicit, ...browserLocales].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
}
