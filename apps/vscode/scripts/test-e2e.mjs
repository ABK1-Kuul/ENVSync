// Runs the extension's end-to-end tests inside a real VS Code (downloaded by @vscode/test-electron
// into apps/vscode/.vscode-test, gitignored). The workspace is a temporary copy of a fixture project
// with env files holding obviously fake values. Default VS Code version: the oldest one the extension
// supports (engines.vscode); override with ENVSYNC_VSCODE_VERSION=stable.
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";

const extensionDir = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(extensionDir, "../..");
const version = process.env.ENVSYNC_VSCODE_VERSION ?? "1.95.0";
// When this script runs from a terminal inside VS Code (or another Electron app), this variable is
// inherited and would make the downloaded VS Code start as plain Node.js instead of an editor.
delete process.env.ELECTRON_RUN_AS_NODE;

await build({
  absWorkingDir: extensionDir,
  entryPoints: ["test-e2e/suite.ts"],
  outfile: "dist-test/suite.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  conditions: ["source"],
  external: ["vscode"],
  logLevel: "warning",
});

const workspace = await mkdtemp(path.join(tmpdir(), "envsync-vscode-e2e-"));
const userData = await mkdtemp(path.join(tmpdir(), "envsync-vscode-user-"));
try {
  await cp(path.join(repoRoot, "tests/fixtures/next-app-router"), workspace, { recursive: true });
  await cp(path.join(workspace, "env.example.fixture"), path.join(workspace, ".env.example"));
  await rm(path.join(workspace, "env.example.fixture"));
  await writeFile(path.join(workspace, ".env.development"), "# Development defaults (fake values)\nNEXT_PUBLIC_SITE_URL=https://dev.example\nLOG_LEVEL=debug\n");
  await writeFile(path.join(workspace, ".env.local"), "API_TOKEN=ENVSYNC_FAKE_SECRET_DO_NOT_LEAK\nUNDECLARED_LOCAL=1\n");

  await runTests({
    version,
    extensionDevelopmentPath: extensionDir,
    extensionTestsPath: path.join(extensionDir, "dist-test/suite.cjs"),
    launchArgs: [workspace, "--disable-extensions", "--skip-welcome", "--skip-release-notes", `--user-data-dir=${userData}`],
  });
} finally {
  await rm(workspace, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}
