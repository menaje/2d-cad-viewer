import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderWebviewHtml } from "../src/webview-html";

const template = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <script type="importmap">{"imports":{"x":"./x.js"}}</script>
    <script type="module" src="./src/main.mjs"></script>
  </body>
</html>`;

test("renders a nonce-protected VS Code webview without an import map", () => {
  const html = renderWebviewHtml(template, {
    cspSource: "vscode-webview:",
    nonce: "abcdefghijklmnopqrstuvwxyz",
    stylesUri: "vscode-webview://test/styles.css",
    scriptUri: "vscode-webview://test/main.mjs",
    locale: "ko-KR",
  });

  assert.match(html, /default-src 'none'/u);
  assert.match(html, /worker-src blob:/u);
  assert.match(html, /connect-src vscode-webview:/u);
  assert.match(html, /nonce-abcdefghijklmnopqrstuvwxyz/u);
  assert.match(
    html,
    /nonce="abcdefghijklmnopqrstuvwxyz" type="module"/u,
  );
  assert.match(html, /data-host="vscode"/u);
  assert.match(
    html,
    /<body data-host="vscode" data-top-toolbar-labels="hover" data-left-toolbar-labels="hover" data-render-resolution="auto" data-interaction-rendering="hybrid" data-mouse-wheel-zoom-sensitivity="1" data-trackpad-pinch-zoom-sensitivity="1\.5">/u,
  );
  assert.match(html, /<html lang="ko-KR" data-locale="ko-KR">/u);
  assert.match(html, /vscode-webview:\/\/test\/styles\.css/u);
  assert.match(html, /vscode-webview:\/\/test\/main\.mjs/u);
  assert.doesNotMatch(html, /importmap/u);
});

test("renders independent toolbar preferences", () => {
  const html = renderWebviewHtml(template, {
    cspSource: "vscode-webview:",
    nonce: "abcdefghijklmnopqrstuvwxyz",
    stylesUri: "vscode-webview://test/styles.css",
    scriptUri: "vscode-webview://test/main.mjs",
    topToolbarLabels: "icons",
    leftToolbarLabels: "hover",
    renderResolution: "performance",
    interactionRendering: "maximumPerformance",
    mouseWheelZoomSensitivity: 1.75,
    trackpadPinchZoomSensitivity: 2.25,
  });

  assert.match(
    html,
    /<body data-host="vscode" data-top-toolbar-labels="icons" data-left-toolbar-labels="hover" data-render-resolution="performance" data-interaction-rendering="maximumPerformance" data-mouse-wheel-zoom-sensitivity="1\.75" data-trackpad-pinch-zoom-sensitivity="2\.25">/u,
  );
});

test("clamps host zoom sensitivity before writing data attributes", () => {
  const html = renderWebviewHtml(template, {
    cspSource: "vscode-webview:",
    nonce: "abcdefghijklmnopqrstuvwxyz",
    stylesUri: "vscode-webview://test/styles.css",
    scriptUri: "vscode-webview://test/main.mjs",
    mouseWheelZoomSensitivity: -1,
    trackpadPinchZoomSensitivity: 10,
  });

  assert.match(html, /data-mouse-wheel-zoom-sensitivity="0\.25"/u);
  assert.match(html, /data-trackpad-pinch-zoom-sensitivity="4"/u);
});

test("falls back to English for an invalid host locale", () => {
  const html = renderWebviewHtml(template, {
    cspSource: "vscode-webview:",
    nonce: "abcdefghijklmnopqrstuvwxyz",
    stylesUri: "vscode-webview://test/styles.css",
    scriptUri: "vscode-webview://test/main.mjs",
    locale: 'ko" data-host="unsafe',
  });

  assert.match(html, /<html lang="en" data-locale="en">/u);
  assert.doesNotMatch(html, /data-host="unsafe"/u);
});

test("rejects a weak webview nonce", () => {
  assert.throws(
    () =>
      renderWebviewHtml(template, {
        cspSource: "vscode-webview:",
        nonce: "short",
        stylesUri: "styles",
        scriptUri: "script",
      }),
    /nonce is invalid/u,
  );
});

test("renders the repository Webview template with the strict policy", async () => {
  const repositoryTemplate = await readFile(
    path.resolve(
      __dirname,
      "../../../..",
      "packages",
      "webview",
      "index.html",
    ),
    "utf8",
  );
  const html = renderWebviewHtml(repositoryTemplate, {
    cspSource: "vscode-webview:",
    nonce: "repositorytemplate012345",
    stylesUri: "vscode-webview://test/styles.css",
    scriptUri: "vscode-webview://test/main.mjs",
  });
  assert.match(html, /Content-Security-Policy/u);
  assert.doesNotMatch(html, /node_modules/u);
  assert.doesNotMatch(html, /importmap/u);
});

test("repository Webview CSS keeps host-only controls hidden", async () => {
  const repositoryStyles = await readFile(
    path.resolve(
      __dirname,
      "../../../..",
      "packages",
      "webview",
      "styles.css",
    ),
    "utf8",
  );
  assert.match(
    repositoryStyles,
    /\[hidden\]\s*\{\s*display:\s*none\s*!important;/u,
  );
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\s+#metrics\s*\{\s*display:\s*none;/u,
  );
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\s+\.viewport,[\s\S]*?border:\s*0;/u,
  );
  assert.match(
    repositoryStyles,
    /header:hover\s+\.toolbar,[\s\S]*?pointer-events:\s*auto;/u,
  );
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\s+\.layout-tabs\s*\{[\s\S]*?opacity:\s*0\.88;[\s\S]*?transform:\s*translate\(-50%,\s*0\);/u,
  );
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\s+header\s*\{[\s\S]*?right:\s*max\(0\.75rem,\s*env\(safe-area-inset-right\)\);[\s\S]*?width:\s*2\.95rem;[\s\S]*?max-width:\s*calc\(100%\s*-\s*2rem\);[\s\S]*?height:\s*2\.95rem;/u,
  );
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\s+header\s*\{[\s\S]*?--viewer-tools-expanded-width:\s*52rem;[\s\S]*?width:\s*2\.95rem;/u,
  );
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\[data-top-toolbar-labels="icons"\]\s+header\s*\{\s*--viewer-tools-expanded-width:\s*38rem;/u,
  );
  assert.match(
    repositoryStyles,
    /header\.tools-open\s*\{[\s\S]*?width:\s*min\(var\(--viewer-tools-expanded-width\),\s*calc\(100%\s*-\s*2rem\)\);/u,
  );
  assert.doesNotMatch(
    repositoryStyles,
    /100vw/u,
  );
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\s+\.review-toolbar\s*\{[\s\S]*?z-index:\s*15;[\s\S]*?width:\s*2\.75rem;[\s\S]*?opacity:\s*0\.72;/u,
  );
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\s+\.review-toolbar\s*\{[\s\S]*?max-height:\s*calc\(100%\s*-\s*5\.25rem\);/u,
  );
  assert.match(
    repositoryStyles,
    /@media\s*\(max-height:\s*680px\)\s*\{[\s\S]*?\.review-toolbar\s*\{[\s\S]*?gap:\s*0\.1rem;[\s\S]*?\.review-toolbar button\s*\{[\s\S]*?height:\s*2\.25rem;/u,
  );
  assert.match(
    repositoryStyles,
    /\[data-left-toolbar-labels="hover"\]\s+\.review-toolbar:hover,[\s\S]*?width:\s*13\.5rem;/u,
  );
  assert.match(
    repositoryStyles,
    /\[data-left-toolbar-labels="hover"\]\s+\.review-toolbar:hover \.review-tool-label,[\s\S]*?\.review-toolbar:focus-within \.review-tool-label[\s\S]*?visibility:\s*visible;[\s\S]*?opacity:\s*1;/u,
  );
  assert.match(
    repositoryStyles,
    /\[data-top-toolbar-labels="hover"\]\s+header:hover \.toolbar \.viewer-tool-label,[\s\S]*?header\.tools-open \.toolbar \.viewer-tool-label[\s\S]*?visibility:\s*visible;[\s\S]*?opacity:\s*1;/u,
  );
  assert.match(
    repositoryStyles,
    /header\.tools-open\s*\+\s*\.viewport\s+\.layer-panel,[\s\S]*?header\.tools-open\s*\+\s*\.viewport\s+\.export-panel\s*\{[\s\S]*?top:\s*7\.25rem;[\s\S]*?max-height:\s*calc\(100%\s*-\s*7\.85rem\);/u,
  );
  assert.doesNotMatch(
    repositoryStyles,
    /\.review-toolbar button:hover \.review-tool-label/u,
  );
  assert.doesNotMatch(
    repositoryStyles,
    /\.viewer-tool-button:hover \.viewer-tool-label/u,
  );
  assert.match(
    repositoryStyles,
    /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?body\[data-host="vscode"\]\s+\.review-result\s*\{[\s\S]*?width:\s*min\(20rem,\s*calc\(100%\s*-\s*11\.25rem\)\);[\s\S]*?body\[data-host="vscode"\]\s+\.view-bookmark-panel\s*\{[\s\S]*?width:\s*min\(23rem,\s*calc\(100%\s*-\s*11\.25rem\)\);/u,
  );
  assert.doesNotMatch(
    repositoryStyles,
    /\.layout-tabs\s*\{[\s\S]*?translate\(-50%,\s*calc\(100%\s*-\s*8px\)\)/u,
  );
});

test("repository host UI and manifest expose adapter selection and diagnosis", async () => {
  const repositoryRoot = path.resolve(__dirname, "../../../..");
  const [template, mainModule, manifestText] = await Promise.all([
    readFile(
      path.join(repositoryRoot, "packages", "webview", "index.html"),
      "utf8",
    ),
    readFile(
      path.join(repositoryRoot, "packages", "webview", "src", "main.mjs"),
      "utf8",
    ),
    readFile(
      path.join(
        repositoryRoot,
        "apps",
        "vscode-extension",
        "package.json",
      ),
      "utf8",
    ),
  ]);
  assert.match(
    template,
    /id="host-adapter-setup"[^>]*hidden/u,
  );
  assert.match(
    template,
    /id="viewer-tools-trigger"[^>]*aria-expanded="false"/u,
  );
  assert.match(template, /id="review-toolbar"/u);
  assert.match(template, /id="window-zoom"/u);
  assert.match(template, /id="view-history-back"/u);
  assert.match(template, /id="view-history-forward"/u);
  assert.match(template, /id="view-bookmarks-toggle"/u);
  assert.match(template, /id="view-bookmark-panel"/u);
  assert.match(template, /id="export-toggle"/u);
  assert.match(template, /id="export-panel"/u);
  assert.match(template, /id="export-target"/u);
  assert.match(template, /id="export-format"/u);
  assert.match(template, /id="export-paper"/u);
  assert.match(template, /id="export-orientation"/u);
  assert.match(template, /id="export-scale"/u);
  assert.match(template, /id="export-plot-style"/u);
  assert.match(template, /data-review-tool="distance"/u);
  assert.match(template, /data-review-action="settings"/u);
  assert.match(mainModule, /qualification-theme/u);
  assert.match(mainModule, /--vscode-editor-background/u);
  assert.match(template, /data-i18n="review\.settings"/u);
  assert.match(template, /class="viewer-tool-icon"/u);
  assert.match(template, /class="viewer-tool-label"/u);
  assert.match(template, /id="review-result"/u);
  assert.match(
    template,
    /"@menaje\/viewer-core":\s*"\.\.\/viewer-core\/src\/index\.mjs"/u,
  );
  assert.match(
    template,
    /"@menaje\/viewer-ui":\s*"\.\.\/viewer-ui\/src\/index\.mjs"/u,
  );
  assert.match(
    template,
    /"@menaje\/dwg-scene-source":\s*"\.\.\/dwg-scene-source\/src\/index\.mjs\?v=1\.26\.0"/u,
  );
  assert.match(
    template,
    /"@menaje\/viewer-webgl":\s*"\.\/src\/public-api\.mjs"/u,
  );
  assert.match(
    template,
    /id="host-rebuild"[\s\S]*?data-i18n="toolbar\.rebuild"/u,
  );
  assert.doesNotMatch(template, /캐시 다시 만들기/u);
  assert.match(mainModule, /setViewerToolsOpen/u);
  assert.match(mainModule, /applyMenuDisplaySettings/u);
  assert.match(mainModule, /NamedPlotStyleName/u);
  assert.match(mainModule, /\.endsWith\("\.stb"\)/u);
  assert.match(mainModule, /dwg-menu-display-settings\/1/u);
  assert.match(mainModule, /dwg-zoom-sensitivity\/1/u);
  assert.match(
    mainModule,
    /if\s*\(!open\)\s*\{\s*closeViewerPanels\(\);/u,
  );
  assert.match(mainModule, /viewerToolSurfaceContains/u);
  assert.match(mainModule, /new ReviewTools/u);
  assert.match(mainModule, /new DwgSceneCacheSource/u);
  assert.match(mainModule, /openViewerRuntime/u);
  assert.match(mainModule, /mountDwgWebGlPresentation/u);
  assert.match(mainModule, /projectDwgSelection/u);
  assert.match(mainModule, /onSelectionChange/u);
  assert.match(mainModule, /new CameraViewHistory/u);
  assert.match(mainModule, /normalizeViewBookmarks/u);
  assert.match(mainModule, /focusAt\(\s*bookmark\.view\.origin/u);
  assert.match(mainModule, /measurementPreferences/u);
  assert.match(mainModule, /vscodeApi\.setState/u);
  assert.match(mainModule, /makeRasterPdf/u);
  assert.match(mainModule, /makeStoredZip/u);
  assert.match(mainModule, /type: "dwg-export-save\/1"/u);
  assert.match(mainModule, /code\.startsWith\("ADAPTER_"\)/u);
  assert.match(mainModule, /type: "dwg-adapter-select\/1"/u);
  assert.match(mainModule, /type: "dwg-font-file-select\/1"/u);
  assert.match(
    mainModule,
    /type: "dwg-plot-style-file-select\/1"/u,
  );
  assert.match(mainModule, /type: "dwg-visual-complete\/1"/u);

  const manifest = JSON.parse(manifestText) as {
    contributes?: {
      commands?: Array<{ command?: string }>;
      menus?: {
        "view/title"?: Array<{
          command?: string;
          toggled?: string;
        }>;
      };
      configuration?: {
        properties?: Record<
          string,
          {
            default?: unknown;
            description?: unknown;
            enum?: unknown;
            enumDescriptions?: unknown;
            maximum?: unknown;
            minimum?: unknown;
            scope?: unknown;
            type?: unknown;
          }
        >;
      };
    };
  };
  const commands = new Set(
    manifest.contributes?.commands?.map(({ command }) => command),
  );
  assert.equal(commands.has("dwgViewer.selectLibreDwgAdapter"), true);
  assert.equal(commands.has("dwgViewer.diagnoseLibreDwgAdapter"), true);
  assert.equal(commands.has("dwgViewer.searchWorkspaceText"), true);
  assert.equal(
    commands.has("dwgViewer.toggleTextSearchRegularExpression"),
    true,
  );
  assert.deepEqual(
    manifest.contributes?.menus?.["view/title"]?.find(
      ({ command }) =>
        command === "dwgViewer.toggleTextSearchRegularExpression",
    ),
    {
      command: "dwgViewer.toggleTextSearchRegularExpression",
      when: "view == dwgViewer.textSearch",
      group: "navigation@3",
      toggled: "dwgViewer.textSearchRegularExpressionEnabled",
    },
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.topToolbarLabels"
    ],
    {
      type: "string",
      enum: ["hover", "icons"],
      enumDescriptions: [
        "Expand all top toolbar icons and names together when the ellipsis is hovered, focused, or opened.",
        "Reveal icon-only actions when the ellipsis is hovered, focused, or opened.",
      ],
      default: "hover",
      scope: "window",
      description:
        "Choose whether the top-right drawing toolbar shows names when it expands.",
    },
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.leftToolbarLabels"
    ],
    {
      type: "string",
      enum: ["hover", "icons"],
      enumDescriptions: [
        "Expand the entire left review toolbar and show every tool name when the shelf is hovered or focused.",
        "Keep the left review toolbar icon-only. Tool names remain available as tooltips.",
      ],
      default: "hover",
      scope: "window",
      description:
        "Choose whether the left drawing toolbar expands to show tool names.",
    },
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.progressivePreview"
    ],
    {
      type: "boolean",
      default: false,
      scope: "window",
      description:
        "Show an overview while full conversion continues. This improves first-frame latency but substantially increases concurrent memory.",
    },
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.sceneCacheMode"
    ],
    {
      type: "string",
      enum: ["session", "persistent"],
      enumDescriptions: [
        "Keep generated Scene Caches only while the drawing or workspace search is using them, then delete them.",
        "Keep validated Scene Caches for faster subsequent opens. This can use several times the source DWG size on local disk.",
      ],
      default: "session",
      scope: "machine",
      description:
        "Choose whether generated drawing caches are retained between sessions. Changing this setting affects newly opened drawings.",
    },
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.sceneCacheMaximumSizeGiB"
    ],
    {
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 5,
      scope: "machine",
      description:
        "Maximum local disk space in GiB for persistent drawing caches. Oldest closed drawings are removed first; session mode does not retain them.",
    },
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.interactionRendering"
    ],
    {
      type: "string",
      enum: ["continuous", "hybrid", "maximumPerformance"],
      enumDescriptions: [
        "Redraw low-resolution geometry on every interaction frame so newly exposed areas remain visible. This uses the most GPU and CPU time.",
        "Move the completed frame immediately and refresh low-resolution geometry periodically. This is the recommended balance of responsiveness and coverage.",
        "Move only the completed frame until interaction stops. This minimizes rendering work, but newly exposed areas can remain blank temporarily.",
      ],
      default: "hybrid",
      scope: "window",
      description:
        "Choose how the viewer redraws while panning or zooming. Conversion and export performance are unaffected.",
    },
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.mouseWheelZoomSensitivity"
    ],
    {
      type: "number",
      minimum: 0.25,
      maximum: 4,
      default: 1,
      scope: "window",
      description:
        "Adjust mouse-wheel zoom distance. 1.0 is the standard response; higher values zoom farther per wheel step.",
    },
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.trackpadPinchZoomSensitivity"
    ],
    {
      type: "number",
      minimum: 0.25,
      maximum: 4,
      default: 1.5,
      scope: "window",
      description:
        "Adjust trackpad pinch zoom distance. 1.0 matches the original response; the faster 1.5 default zooms 50% farther for the same gesture.",
    },
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.shxBigFontEncodings"
    ],
    {
      type: "object",
      default: {},
      scope: "window",
      maxProperties: 128,
      additionalProperties: {
        type: "string",
        enum: ["auto", "euc-kr", "cp949", "johab"],
      },
      description:
        "Map a DWG-requested BigFont name to auto glyph probing, strict EUC-KR, Windows CP949/UHC, or Johab CP1361 codes.",
    },
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.textSearchUseRegularExpression"
    ],
    {
      type: "boolean",
      default: false,
      scope: "window",
      description:
        "Use a bounded JavaScript regular expression by default in workspace DWG text search. The Explorer view toggle is retained per workspace.",
    },
  );
});
