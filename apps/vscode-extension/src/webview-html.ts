export interface WebviewHtmlOptions {
  cspSource: string;
  nonce: string;
  stylesUri: string;
  scriptUri: string;
  locale?: string;
  topToolbarLabels?: MenuLabelMode;
  leftToolbarLabels?: MenuLabelMode;
}

export type MenuLabelMode = "hover" | "icons";

function normalizeWebviewLocale(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)
  ) {
    return "en";
  }
  try {
    return Intl.getCanonicalLocales(value)[0] ?? "en";
  } catch {
    return "en";
  }
}

function normalizeMenuLabelMode(
  value: MenuLabelMode | undefined,
): MenuLabelMode {
  return value === "icons" ? "icons" : "hover";
}

export function renderWebviewHtml(
  template: string,
  {
    cspSource,
    nonce,
    stylesUri,
    scriptUri,
    locale,
    topToolbarLabels,
    leftToolbarLabels,
  }: WebviewHtmlOptions,
): string {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(nonce)) {
    throw new TypeError("webview nonce is invalid");
  }
  const csp = [
    "default-src 'none'",
    `img-src data: ${cspSource}`,
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "worker-src blob:",
    `connect-src ${cspSource}`,
  ].join("; ");

  const withoutImportMap = template.replace(
    /\s*<script\s+type=["']importmap["']>[\s\S]*?<\/script>\s*/iu,
    "\n",
  );
  const withCsp = withoutImportMap.replace(
    /(<meta\s+charset=["']utf-8["']\s*\/?>)/iu,
    `$1\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
  );
  const resolvedLocale = normalizeWebviewLocale(locale);
  const withLocale = withCsp.replace(
    /<html\b[^>]*>/iu,
    `<html lang="${resolvedLocale}" data-locale="${resolvedLocale}">`,
  );
  const resolvedTopToolbarLabels = normalizeMenuLabelMode(
    topToolbarLabels,
  );
  const resolvedLeftToolbarLabels = normalizeMenuLabelMode(
    leftToolbarLabels,
  );
  const withHost = withLocale.replace(
    "<body>",
    `<body data-host="vscode" data-top-toolbar-labels="${resolvedTopToolbarLabels}" data-left-toolbar-labels="${resolvedLeftToolbarLabels}">`,
  );
  const withStyles = withHost.replace(
    /<link\s+rel=["']stylesheet["']\s+href=["'][^"']+["']\s*\/?>/iu,
    `<link rel="stylesheet" href="${stylesUri}" />`,
  );
  const withScript = withStyles.replace(
    /<script\s+type=["']module["']\s+src=["'][^"']+["']><\/script>/iu,
    `<script nonce="${nonce}" type="module" src="${scriptUri}"></script>`,
  );

  if (
    withScript === template ||
    !withScript.includes("Content-Security-Policy") ||
    !withScript.includes(`nonce="${nonce}"`) ||
    withScript.includes('type="importmap"')
  ) {
    throw new Error("webview template does not match the expected structure");
  }
  return withScript;
}
