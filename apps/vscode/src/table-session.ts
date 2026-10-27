import { parseConfigSource, type ParsedConfig } from "@envsync-internal/schema";
import * as vscode from "vscode";
import { confirmationMode, decideEdit } from "./edit-handler.js";
import { parseWebviewMessage } from "./messages.js";
import { buildTableModel, revealValue, type TableModel } from "./model.js";

/** What the user is asked to confirm. `proposedText` is only used to show a diff ("diff" mode). */
export type ConfirmRequest = { label: string; mode: "diff" | "dialog"; currentUri: vscode.Uri; proposedText: string };

export type SessionDeps = {
  /** Sends a message to the table webview. */
  post: (message: unknown) => Thenable<unknown> | Promise<unknown>;
  environment: () => string;
  /** Shows the change and resolves true if the user chose to apply it. */
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  openText: () => Thenable<unknown> | Promise<unknown>;
};

const CHANGED_NOTICE = "The file changed after the table was shown. The table has been refreshed; please make the change again.";

/**
 * One table editor's handling of webview messages, against the real text document. Every edit is
 * confirmed by the user first, then decided again against the document as it is at that moment and
 * applied only if it is still the version the table showed. So no edit is ever applied to content
 * the user has not seen, however long the confirmation stays open.
 */
export class TableSession {
  constructor(
    private readonly document: vscode.TextDocument,
    private readonly deps: SessionDeps,
  ) {}

  async model(): Promise<TableModel> {
    return buildTableModel({
      text: this.document.getText(),
      version: this.document.version,
      fileName: vscode.workspace.asRelativePath(this.document.uri),
      environment: this.deps.environment(),
      config: await readConfig(this.document.uri),
      publicPrefix: "NEXT_PUBLIC_",
    });
  }

  /** Still open, and still the document VS Code has for this file. */
  private isLiveDocument(): boolean {
    if (this.document.isClosed) return false;
    const uri = this.document.uri.toString();
    return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri) === this.document;
  }

  async render(): Promise<void> {
    await this.deps.post({ type: "model", model: await this.model() });
  }

  async handle(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (message === undefined) return;
    switch (message.type) {
      case "ready":
        return this.render();
      case "openText":
        await this.deps.openText();
        return;
      case "reveal": {
        // Values are revealed one at a time, on request, and only if the table is current.
        if (message.version !== this.document.version) return this.render();
        const value = revealValue(this.document.getText(), message.name);
        if (value !== undefined) await this.deps.post({ type: "revealed", name: message.name, value });
        return;
      }
      case "edit": {
        const decision = decideEdit(this.document.getText(), this.document.version, message.version, message.edit);
        if (decision.kind === "conflict") {
          await this.deps.post({ type: "notice", text: CHANGED_NOTICE });
          return this.render();
        }
        if (decision.kind === "refused") {
          await this.deps.post({ type: "notice", text: decision.reason });
          return;
        }
        const text = this.document.getText();
        const proposedText = text.slice(0, decision.replacement.start) + decision.replacement.text + text.slice(decision.replacement.end);
        // Both versions must be safe to show in full for a diff: the edit itself may add a secret.
        const mode = confirmationMode(text, proposedText, await readConfig(this.document.uri));
        if (!(await this.deps.confirm({ label: decision.label, mode, currentUri: this.document.uri, proposedText }))) return;

        // The file may have changed while the confirmation was open: decide again against it now.
        // A closed or replaced document no longer tracks the file, so its version proves nothing.
        if (!this.isLiveDocument()) {
          await this.deps.post({ type: "notice", text: CHANGED_NOTICE });
          return;
        }
        const current = decideEdit(this.document.getText(), this.document.version, message.version, message.edit);
        if (current.kind !== "apply") {
          await this.deps.post({ type: "notice", text: CHANGED_NOTICE });
          return this.render();
        }
        const edit = new vscode.WorkspaceEdit();
        const range = new vscode.Range(this.document.positionAt(current.replacement.start), this.document.positionAt(current.replacement.end));
        edit.replace(this.document.uri, range, current.replacement.text);
        if (!(await vscode.workspace.applyEdit(edit))) await this.deps.post({ type: "notice", text: "The change was not applied." });
        return;
      }
    }
  }
}

const MAX_CONFIG_BYTES = 1_000_000;

/**
 * The nearest envsync.config.ts from the env file's folder up to its workspace folder (Next.js loads
 * env files from the app root, which is where the config normally sits). Only regular files inside
 * the workspace are read: links are not followed, and the size is checked before reading.
 */
export async function readConfig(envFile: vscode.Uri): Promise<ParsedConfig | null> {
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
