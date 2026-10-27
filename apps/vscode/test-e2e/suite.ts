import assert from "node:assert/strict";
import * as vscode from "vscode";
import { TableSession, type ConfirmRequest } from "../src/table-session.js";

/**
 * Runs inside a real VS Code (see scripts/test-e2e.mjs) against a copy of a fixture workspace.
 * A tiny runner instead of a test framework: each test runs in order; any failure fails the run.
 */

const FAKE_SECRET = "ENVSYNC_FAKE_SECRET_DO_NOT_LEAK";
const tests: { name: string; fn: () => Promise<void> }[] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });

const root = () => (vscode.workspace.workspaceFolders?.[0] as vscode.WorkspaceFolder).uri;
const file = (name: string) => vscode.Uri.joinPath(root(), name);

async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

type Recorder = { posted: unknown[]; confirms: ConfirmRequest[] };

async function session(name: string, confirm: (request: ConfirmRequest) => Promise<boolean>) {
  const document = await vscode.workspace.openTextDocument(file(name));
  const recorder: Recorder = { posted: [], confirms: [] };
  const table = new TableSession(document, {
    post: async (message) => void recorder.posted.push(message),
    environment: () => "development",
    confirm: async (request) => {
      recorder.confirms.push(request);
      return confirm(request);
    },
    openText: async () => undefined,
  });
  return { document, table, recorder };
}

const notices = (recorder: Recorder) =>
  recorder.posted.filter((message): message is { type: "notice"; text: string } => (message as { type?: string }).type === "notice").map((m) => m.text);

test("the extension activates in a workspace with envsync.config.ts and registers its commands", async () => {
  const extension = vscode.extensions.getExtension("envsync.envsync-vscode");
  assert.ok(extension, "extension found");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of ["envsync.openTable", "envsync.selectEnvironment", "envsync.scanWorkspace"]) assert.ok(commands.includes(command), command);
});

test("scan findings appear in the Problems panel, without values", async () => {
  await vscode.commands.executeCommand("envsync.scanWorkspace");
  const diagnostics = await waitFor(() => {
    const found = vscode.languages.getDiagnostics(file(".env.local"));
    return found.filter((d) => d.code === "ENV009").length >= 2 ? found : undefined;
  }, "ENV009 findings on .env.local");
  // Both undeclared variables are reported, each on its own line.
  const env009 = diagnostics.filter((d) => d.code === "ENV009").sort((a, b) => a.range.start.line - b.range.start.line);
  assert.deepEqual(
    env009.map((d) => [d.range.start.line, d.source, d.severity]),
    [
      [0, "EnvSync", vscode.DiagnosticSeverity.Warning],
      [1, "EnvSync", vscode.DiagnosticSeverity.Warning],
    ],
  );
  assert.match(env009[0]?.message ?? "", /API_TOKEN is set in \.env\.local but not declared/);
  assert.match(env009[1]?.message ?? "", /UNDECLARED_LOCAL is set in \.env\.local but not declared/);
  for (const uri of [file(".env.local"), file(".env.development")]) {
    for (const d of vscode.languages.getDiagnostics(uri)) assert.ok(!d.message.includes(FAKE_SECRET), "no value in diagnostics");
  }
});

test("the table editor opens for an env file", async () => {
  await vscode.commands.executeCommand("vscode.openWith", file(".env.development"), "envsync.envTable");
  const tab = await waitFor(() => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom ? input : undefined;
  }, "custom editor tab");
  assert.equal(tab.viewType, "envsync.envTable");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
});

test("a table edit is shown as a diff, then applied with formatting kept", async () => {
  const { document, table, recorder } = await session(".env.development", async () => true);
  const before = document.getText();
  await table.handle({ type: "edit", version: document.version, edit: { kind: "set", name: "NEXT_PUBLIC_SITE_URL", value: "https://changed.example" } });
  assert.equal(recorder.confirms.length, 1);
  assert.equal(recorder.confirms[0]?.mode, "diff");
  assert.equal(recorder.confirms[0]?.proposedText, document.getText(), "applied text is exactly what was previewed");
  assert.equal(document.getText(), before.replace("https://dev.example", "https://changed.example"));
  assert.ok(document.getText().startsWith("# Development defaults (fake values)\n"), "comment kept");
});

test("a file with hidden values is confirmed by name, never as a diff", async () => {
  const { document, table, recorder } = await session(".env.local", async () => false);
  const before = document.getText();
  await table.handle({ type: "edit", version: document.version, edit: { kind: "set", name: "UNDECLARED_LOCAL", value: "2" } });
  assert.equal(recorder.confirms[0]?.mode, "dialog");
  assert.equal(document.getText(), before, "cancelled: nothing applied");
});

test("an edit made against an older version is rejected as a conflict", async () => {
  const { document, table, recorder } = await session(".env.development", async () => true);
  const before = document.getText();
  await table.handle({ type: "edit", version: document.version - 1, edit: { kind: "set", name: "NEXT_PUBLIC_SITE_URL", value: "https://stale.example" } });
  assert.equal(recorder.confirms.length, 0, "not even offered");
  assert.equal(document.getText(), before);
  assert.match(notices(recorder)[0] ?? "", /changed after the table was shown/);
});

test("if the file changes while the confirmation is open, the confirmed edit is not applied (review L4)", async () => {
  const { document, table, recorder } = await session(".env.development", async () => {
    // Someone edits the file while the user is looking at the preview.
    const concurrent = new vscode.WorkspaceEdit();
    concurrent.insert(document.uri, new vscode.Position(0, 0), "# edited elsewhere\n");
    assert.ok(await vscode.workspace.applyEdit(concurrent));
    return true;
  });
  const version = document.version;
  await table.handle({ type: "edit", version, edit: { kind: "set", name: "NEXT_PUBLIC_SITE_URL", value: "https://late.example" } });
  assert.ok(document.getText().startsWith("# edited elsewhere\n"), "the other change is kept");
  assert.ok(!document.getText().includes("https://late.example"), "the stale edit was not applied");
  assert.match(notices(recorder)[0] ?? "", /changed after the table was shown/);
});

test("refused edits are explained and change nothing", async () => {
  const { document, table, recorder } = await session(".env.development", async () => true);
  const before = document.getText();
  await table.handle({ type: "edit", version: document.version, edit: { kind: "set", name: "NEXT_PUBLIC_SITE_URL", value: "$OTHER" } });
  assert.equal(document.getText(), before);
  assert.match(notices(recorder)[0] ?? "", /references to other variables/);
});

test("masked values stay out of the table model and are revealed only on request", async () => {
  const { document, table, recorder } = await session(".env.local", async () => false);
  const model = await table.model();
  assert.ok(!JSON.stringify(model).includes(FAKE_SECRET), "masked value not in the model");
  assert.ok(model.rows.find((row) => row.name === "API_TOKEN")?.masked);
  await table.handle({ type: "reveal", version: document.version - 1, name: "API_TOKEN" });
  assert.ok(!JSON.stringify(recorder.posted).includes(FAKE_SECRET), "stale reveal refused");
  await table.handle({ type: "reveal", version: document.version, name: "API_TOKEN" });
  assert.deepEqual(recorder.posted.at(-1), { type: "revealed", name: "API_TOKEN", value: FAKE_SECRET });
});

test("malformed webview messages are ignored", async () => {
  const { document, table, recorder } = await session(".env.development", async () => true);
  const before = document.getText();
  for (const raw of [null, { type: "edit" }, { type: "edit", version: document.version, edit: { kind: "writeFile", path: "/etc/hosts" } }]) {
    await table.handle(raw);
  }
  assert.equal(document.getText(), before);
  assert.equal(recorder.posted.length, 0);
});

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`  FAIL  ${name}\n        ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  }
  console.log(`\n${tests.length - failures.length}/${tests.length} passed`);
  if (failures.length > 0) throw new Error(`${failures.length} test(s) failed`);
}
