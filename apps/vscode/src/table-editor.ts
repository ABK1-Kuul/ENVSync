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
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  add(text: string, fileName: string): vscode.Uri {
    // A random, unguessable address: no one can open a pending preview by counting.
    const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${fileName}`, query: randomBytes(16).toString("hex") });
    this.contents.set(uri.toString(), text);
    return uri;
  }

  /** Forgets the text and tells VS Code, so an open or cached preview document becomes empty. */
  remove(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
    this.changed.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
}

/**
 * Asks the user to confirm an edit.
 * - Dialog mode: a modal that names the change and shows no values.
 * - Diff mode: a read-only diff of the change beside the file, plus Apply / Cancel.
 *
 * The preview is closed and emptied as soon as the user decides. If the file changes while the
 * preview is open, the confirmation is cancelled, because the diff no longer shows what would happen.
 */
export async function confirmEdit(request: ConfirmRequest, previews: PreviewContentProvider): Promise<boolean> {
  if (request.mode === "dialog") {
    const choice = await vscode.window.showWarningMessage(
      `${request.label}?`,
      {
        modal: true,
        detail: "This change is not shown as a diff, because the file has values that are hidden in the table. Use \"Open as text\" to review the whole file.",
      },
      "Apply",
    );
    return choice === "Apply";
  }
  const fileName = request.currentUri.path.split("/").pop() ?? "env";
  const previewUri = previews.add(request.proposedText, fileName);
  let stopWatching: vscode.Disposable | undefined;
  try {
    const fileChanged = new Promise<false>((resolve) => {
      stopWatching = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === request.currentUri.toString() && event.contentChanges.length > 0) resolve(false);
      });
    });
    await vscode.commands.executeCommand("vscode.diff", request.currentUri, previewUri, `${fileName}: proposed change`, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
    const answer = vscode.window.showInformationMessage(`${request.label}: review the diff, then apply.`, "Apply", "Cancel").then((choice) => choice === "Apply");
    return await Promise.race([answer, fileChanged]);
  } finally {
    stopWatching?.dispose();
    previews.remove(previewUri);
    await closePreviewTabs(previewUri);
  }
}

async function closePreviewTabs(previewUri: vscode.Uri): Promise<void> {
  const target = previewUri.toString();
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === target);
  if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
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

  private confirm(request: ConfirmRequest): Promise<boolean> {
    return confirmEdit(request, this.previews);
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
