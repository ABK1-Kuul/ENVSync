import { randomBytes } from "node:crypto";
import { parseConfigSource, type ParsedConfig } from "@envsync-internal/schema";
import * as vscode from "vscode";
import { decideEdit } from "./edit-handler.js";
import { parseWebviewMessage } from "./messages.js";
import { buildTableModel, revealValue } from "./model.js";

export const TABLE_VIEW_TYPE = "envsync.envTable";

/**
 * Table view of an env file, backed by the normal text document: undo/redo, dirty state, saving and
 * the "file changed on disk" prompt are VS Code's own, and the raw text editor can be open beside it.
 * Every edit goes through VS Code's refactor preview before it is applied.
 */
export class EnvTableEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly environment: () => string,
    private readonly onEnvironmentChange: vscode.Event<string>,
  ) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.html(panel.webview, mediaRoot);

    const render = async () => {
      const config = await readConfig(document.uri);
      const model = buildTableModel({
        text: document.getText(),
        version: document.version,
        fileName: vscode.workspace.asRelativePath(document.uri),
        environment: this.environment(),
        config,
        publicPrefix: "NEXT_PUBLIC_",
      });
      await panel.webview.postMessage({ type: "model", model });
    };

    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === document.uri.toString()) void render();
      }),
      this.onEnvironmentChange(() => void render()),
      panel.webview.onDidReceiveMessage(async (raw: unknown) => {
        const message = parseWebviewMessage(raw);
        if (message === undefined) return;
        switch (message.type) {
          case "ready":
            await render();
            return;
          case "openText":
            await vscode.commands.executeCommand("vscode.openWith", document.uri, "default", vscode.ViewColumn.Beside);
            return;
          case "reveal": {
            // Values are revealed one at a time, on request, and only if the table is current.
            if (message.version !== document.version) return void render();
            const value = revealValue(document.getText(), message.name);
            if (value !== undefined) await panel.webview.postMessage({ type: "revealed", name: message.name, value });
            return;
          }
          case "edit": {
            const decision = decideEdit(document.getText(), document.version, message.version, message.edit);
            if (decision.kind === "conflict") {
              await panel.webview.postMessage({ type: "notice", text: "The file changed after the table was shown. The table has been refreshed; please make the change again." });
              return void render();
            }
            if (decision.kind === "refused") {
              await panel.webview.postMessage({ type: "notice", text: decision.reason });
              return;
            }
            const edit = new vscode.WorkspaceEdit();
            const range = new vscode.Range(document.positionAt(decision.replacement.start), document.positionAt(decision.replacement.end));
            // needsConfirmation opens VS Code's refactor preview: the change is shown before it is applied.
            edit.replace(document.uri, range, decision.replacement.text, { label: decision.label, needsConfirmation: true });
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) await panel.webview.postMessage({ type: "notice", text: "The change was not applied." });
            return;
          }
        }
      }),
    ];
    panel.onDidDispose(() => subscriptions.forEach((subscription) => subscription.dispose()));
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "table.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "table.css"));
    // No remote content, no inline script except the nonce'd one, no eval.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style.toString()}">
<title>EnvSync table</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}

/** The app's envsync.config.ts next to the env file (Next.js loads env files from the app root). */
async function readConfig(envFile: vscode.Uri): Promise<ParsedConfig | null> {
  const configUri = vscode.Uri.joinPath(envFile, "..", "envsync.config.ts");
  try {
    const bytes = await vscode.workspace.fs.readFile(configUri);
    if (bytes.byteLength > 1_000_000) return null;
    // Parsed as data, never executed (the same parser the CLI uses).
    return parseConfigSource(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
