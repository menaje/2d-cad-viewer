import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  COMPARISON_QUALIFICATION_MESSAGE_TYPE,
  comparisonQualificationFields,
} from "./comparison-qualification-result";
import type { QualificationReporter } from "./qualification";

export const QUALIFICATION_MODE_ENV =
  "DWG_VIEWER_QUALIFICATION_MODE";

function qualificationHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
): string {
  const nonce = randomBytes(16).toString("hex");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src ${webview.cspSource};">
    <title>DWG Viewer revision comparison qualification</title>
    <style nonce="${nonce}">
      html, body { width: 100%; height: 100%; margin: 0; background: #111820; color: #d9e2ec; font: 14px/1.4 system-ui, sans-serif; }
      body { display: grid; grid-template-rows: minmax(0, 1fr) auto; }
      #comparison { min-width: 0; min-height: 0; }
      [data-viewer-split-label] { padding: 6px 10px; background: #1c2733; }
      [data-viewer-split-divider] { background: #3b82f6; }
      #render-canvas { width: 640px; height: 360px; }
      #result { box-sizing: border-box; max-height: 32vh; margin: 0; padding: 10px; overflow: auto; background: #0a0f14; color: #9fe6a0; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <section id="comparison" aria-label="Actual WebGL comparison"></section>
    <pre id="result" aria-live="polite">running</pre>
    <canvas id="render-canvas" width="640" height="360"></canvas>
    <script type="module" src="${scriptUri}"></script>
  </body>
</html>`;
}

export function activateRevisionComparisonQualification(
  context: vscode.ExtensionContext,
  reporter: QualificationReporter,
  environment: NodeJS.ProcessEnv = process.env,
): vscode.WebviewPanel | undefined {
  if (environment[QUALIFICATION_MODE_ENV] !== "comparison") {
    return undefined;
  }
  const mediaRoot = vscode.Uri.joinPath(
    context.extensionUri,
    "media",
    "webview",
  );
  const panel = vscode.window.createWebviewPanel(
    "dwgViewer.revisionComparisonQualification",
    "DWG Viewer comparison qualification",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [mediaRoot],
    },
  );
  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(
      mediaRoot,
      "src",
      "revision-comparison-qualification.mjs",
    ),
  );
  let handling = false;
  let outcome: "qualified" | "failed" | null = null;
  const messageSubscription = panel.webview.onDidReceiveMessage(
    async (message: unknown) => {
      if (handling || outcome !== null) {
        return;
      }
      const candidate =
        message && typeof message === "object"
          ? (message as Record<string, unknown>)
          : null;
      if (candidate?.type !== COMPARISON_QUALIFICATION_MESSAGE_TYPE) {
        return;
      }
      handling = true;
      try {
        const fields = comparisonQualificationFields(candidate.result);
        await reporter.emit("comparison-qualified", fields);
        outcome = "qualified";
      } catch {
        await reporter.emit("comparison-failed", {
          code: "invalid-result",
        });
        outcome = "failed";
      } finally {
        panel.dispose();
      }
    },
  );
  const disposeSubscription = panel.onDidDispose(() => {
    if (outcome === null) {
      outcome = "failed";
      void reporter.emit("comparison-failed", {
        code: "panel-closed",
      });
    }
    void reporter.emit("comparison-panel-disposed", {
      qualified: outcome === "qualified",
    });
  });
  panel.webview.html = qualificationHtml(panel.webview, scriptUri);
  context.subscriptions.push(
    panel,
    messageSubscription,
    disposeSubscription,
  );
  return panel;
}
