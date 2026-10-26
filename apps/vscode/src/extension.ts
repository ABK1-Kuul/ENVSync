import path from "node:path";
import { CONFIG_FILE_NAME, ENV_CONTEXTS, isEnvContext, scanProject, type EnvContext } from "@envsync-internal/core";
import { nextFramework } from "@envsync-internal/parser-next";
import * as vscode from "vscode";
import { groupFindings } from "./diagnostics.js";
import { EnvTableEditorProvider, TABLE_VIEW_TYPE } from "./table-editor.js";

/**
 * EnvSync for VS Code: a table editor for env files, scan diagnostics in the Problems panel, and an
 * environment selector. Local only: no network, no telemetry, no project code is executed.
 */
export function activate(context: vscode.ExtensionContext): void {
  const environmentChanged = new vscode.EventEmitter<string>();
  const stored = context.workspaceState.get<string>("envsync.environment");
  let environment: EnvContext = stored !== undefined && isEnvContext(stored) ? stored : "development";

  // Always visible, so it is never unclear which environment the checks refer to.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "envsync.selectEnvironment";
  const showStatus = () => {
    status.text = `$(symbol-variable) EnvSync: ${environment}`;
    status.tooltip = "Environment used for EnvSync checks. Click to change.";
    status.show();
  };
  showStatus();

  const diagnostics = vscode.languages.createDiagnosticCollection("envsync");
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleScan = () => {
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => void scanWorkspace(diagnostics, environment), 400);
  };

  context.subscriptions.push(
    status,
    diagnostics,
    environmentChanged,
    vscode.window.registerCustomEditorProvider(
      TABLE_VIEW_TYPE,
      new EnvTableEditorProvider(context, () => environment, environmentChanged.event),
      { webviewOptions: { retainContextWhenHidden: false }, supportsMultipleEditorsPerDocument: true },
    ),
    vscode.commands.registerCommand("envsync.openTable", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target === undefined) return void vscode.window.showInformationMessage("Open an env file first.");
      await vscode.commands.executeCommand("vscode.openWith", target, TABLE_VIEW_TYPE);
    }),
    vscode.commands.registerCommand("envsync.selectEnvironment", async () => {
      const picked = await vscode.window.showQuickPick([...ENV_CONTEXTS], { placeHolder: `Environment for EnvSync checks (now: ${environment})` });
      if (picked === undefined || !isEnvContext(picked)) return;
      environment = picked;
      await context.workspaceState.update("envsync.environment", environment);
      showStatus();
      environmentChanged.fire(environment);
      scheduleScan();
    }),
    vscode.commands.registerCommand("envsync.scanWorkspace", () => scanWorkspace(diagnostics, environment)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isRelevant(document.uri)) scheduleScan();
    }),
  );
  scheduleScan();
}

export function deactivate(): void {}

function isRelevant(uri: vscode.Uri): boolean {
  const name = path.basename(uri.fsPath).toLowerCase();
  return name === CONFIG_FILE_NAME || name === ".env" || name.startsWith(".env.") || /\.(?:[cm]?[jt]sx?)$/.test(name);
}

/** Scans every workspace folder that has an envsync.config.ts and publishes the findings. */
async function scanWorkspace(collection: vscode.DiagnosticCollection, environment: EnvContext): Promise<void> {
  collection.clear();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    const root = folder.uri.fsPath;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, CONFIG_FILE_NAME));
    } catch {
      continue; // not an EnvSync project
    }
    try {
      // The same scan as the CLI: reads files, never executes them, never returns values here.
      const result = await scanProject({ root, framework: nextFramework, envContext: environment });
      for (const [file, findings] of groupFindings(result.diagnostics, CONFIG_FILE_NAME)) {
        const uri = vscode.Uri.joinPath(folder.uri, ...file.split("/"));
        collection.set(
          uri,
          findings.map((finding) => {
            const position = new vscode.Position(finding.line, finding.column);
            const diagnostic = new vscode.Diagnostic(new vscode.Range(position, position), finding.message, SEVERITY[finding.severity]);
            diagnostic.source = "EnvSync";
            diagnostic.code = finding.code;
            return diagnostic;
          }),
        );
      }
    } catch (error) {
      // Scan errors (missing config, unreadable file) are messages written for users; never values.
      void vscode.window.showWarningMessage(`EnvSync: ${error instanceof Error ? error.message : "the scan could not run."}`);
    }
  }
}

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
} as const;
