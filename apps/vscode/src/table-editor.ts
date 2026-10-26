import { randomBytes } from "node:crypto";
import { parseConfigSource, type ParsedConfig } from "@envsync-internal/schema";
import * as vscode from "vscode";
import { confirmationMode, decideEdit } from "./edit-handler.js";
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

    const buildModel = async () =>
      buildTableModel({
        text: document.getText(),
        version: document.version,
        fileName: vscode.workspace.asRelativePath(document.uri),
        environment: this.environment(),
        config: await readConfig(document.uri),
        publicPrefix: "NEXT_PUBLIC_",
      });
    const render = async () => {
      await panel.webview.postMessage({ type: "model", model: await buildModel() });
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
            if (confirmationMode(await buildModel()) === "dialog") {
              // The diff preview would show the whole file, hidden values included: confirm by name.
              const choice = await vscode.window.showWarningMessage(
                `${decision.label}?`,
                {
                  modal: true,
                  detail: "This file has hidden values, so the change is not shown as a diff (that would display them). Use \"Open as text\" to review the whole file.",
                },
                "Apply",
              );
              if (choice !== "Apply") return;
              // The file may have changed while the dialog was open: decide again against it now.
              const current = decideEdit(document.getText(), document.version, message.version, message.edit);
              if (current.kind !== "apply") {
                await panel.webview.postMessage({ type: "notice", text: "The file changed before the change was applied. The table has been refreshed; please make the change again." });
                return void render();
              }
              const edit = new vscode.WorkspaceEdit();
              edit.replace(document.uri, rangeOf(document, current.replacement), current.replacement.text);
              if (!(await vscode.workspace.applyEdit(edit))) await panel.webview.postMessage({ type: "notice", text: "The change was not applied." });
              return;
            }
            const edit = new vscode.WorkspaceEdit();
            // needsConfirmation opens VS Code's refactor preview: the change is shown before it is applied.
            edit.replace(document.uri, rangeOf(document, decision.replacement), decision.replacement.text, { label: decision.label, needsConfirmation: true });
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

function rangeOf(document: vscode.TextDocument, replacement: { start: number; end: number }): vscode.Range {
  return new vscode.Range(document.positionAt(replacement.start), document.positionAt(replacement.end));
}

const MAX_CONFIG_BYTES = 1_000_000;

/**
 * The nearest envsync.config.ts from the env file's folder up to its workspace folder (Next.js loads
 * env files from the app root, which is where the config normally sits). Only regular files inside
 * the workspace are read: links are not followed, and the size is checked before reading.
 */
async function readConfig(envFile: vscode.Uri): Promise<ParsedConfig | null> {
  const folder = vscode.workspace.getWorkspaceFolder(envFile);
  if (folder === undefined) return null;
  const rootPath = folder.uri.path.replace(/\/$/, "");
  let directory = vscode.Uri.joinPath(envFile, "..");
  for (;;) {
    const configUri = vscode.Uri.joinPath(directory, "envsync.config.ts");
    try {
      const stat = await vscode.workspace.fs.stat(configUri);
      // FileType is a bit set: a link to a file reports File | SymbolicLink.
      if (stat.type === vscode.FileType.File && stat.size <= MAX_CONFIG_BYTES) {
        // Parsed as data, never executed (the same parser the CLI uses).
        return parseConfigSource(new TextDecoder().decode(await vscode.workspace.fs.readFile(configUri)));
      }
      return null; // present but a link, a directory or too large: do not use it
    } catch {
      // not here; try the parent
    }
    if (directory.path.replace(/\/$/, "") === rootPath || !directory.path.startsWith(rootPath)) return null;
    directory = vscode.Uri.joinPath(directory, "..");
  }
}
