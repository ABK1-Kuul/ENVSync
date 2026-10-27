import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { TableSession, type ConfirmRequest } from "./table-session.js";

export const TABLE_VIEW_TYPE = "envsync.envTable";
export const PREVIEW_SCHEME = "envsync-preview";

/**
 * Read-only documents holding a proposed version of an env file, shown in a diff before an edit is
 * applied. Only used for files with no hidden values (see `confirmationMode`).
 */
export class PreviewContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private counter = 0;

  add(text: string, fileName: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${fileName}`, query: String(++this.counter) });
    this.contents.set(uri.toString(), text);
    return uri;
  }

  remove(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
}

/**
 * Table view of an env file, backed by the normal text document: undo/redo, dirty state, saving and
 * the "file changed on disk" prompt are VS Code's own, and the raw text editor can be open beside it.
 */
export class EnvTableEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly environment: () => string,
    private readonly onEnvironmentChange: vscode.Event<string>,
    private readonly previews: PreviewContentProvider,
  ) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.html(panel.webview, mediaRoot);

    const session = new TableSession(document, {
      post: (message) => panel.webview.postMessage(message),
      environment: this.environment,
      confirm: (request) => this.confirm(request),
      openText: () => vscode.commands.executeCommand("vscode.openWith", document.uri, "default", vscode.ViewColumn.Beside),
    });

    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === document.uri.toString()) void session.render();
      }),
      this.onEnvironmentChange(() => void session.render()),
      panel.webview.onDidReceiveMessage((raw: unknown) => session.handle(raw)),
    ];
    panel.onDidDispose(() => subscriptions.forEach((subscription) => subscription.dispose()));
  }

  /**
   * Files without hidden values: a read-only diff of the change beside the file, then Apply.
   * Files with hidden values: a modal that names the change (a diff would display the values).
   */
  private async confirm(request: ConfirmRequest): Promise<boolean> {
    if (request.mode === "dialog") {
      const choice = await vscode.window.showWarningMessage(
        `${request.label}?`,
        {
          modal: true,
          detail: "This file has hidden values, so the change is not shown as a diff (that would display them). Use \"Open as text\" to review the whole file.",
        },
        "Apply",
      );
      return choice === "Apply";
    }
    const fileName = request.currentUri.path.split("/").pop() ?? "env";
    const previewUri = this.previews.add(request.proposedText, fileName);
    try {
      await vscode.commands.executeCommand("vscode.diff", request.currentUri, previewUri, `${fileName}: proposed change`, {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      });
      const choice = await vscode.window.showInformationMessage(`${request.label}: review the diff, then apply.`, "Apply", "Cancel");
      return choice === "Apply";
    } finally {
      this.previews.remove(previewUri);
    }
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
