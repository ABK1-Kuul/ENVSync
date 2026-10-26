// Bundles the extension into apps/vscode/dist/extension.cjs (gitignored). VS Code loads extensions
// as CommonJS; `vscode` is provided by the editor at runtime. Workspace packages and `typescript`
// (used to parse source and the config, never to run them) are inlined.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const extensionDir = fileURLToPath(new URL("../", import.meta.url));

await build({
  absWorkingDir: extensionDir,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  conditions: ["source"],
  external: ["vscode"],
  logLevel: "warning",
});

console.log("Bundled apps/vscode/dist/extension.cjs");
