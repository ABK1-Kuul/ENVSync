// Bundles the CLI into apps/cli/dist/envsync.js (gitignored): the internal workspace packages are
// inlined, so nothing under @envsync-internal/* is ever resolved from a registry, and `typescript`
// stays external as the only runtime dependency. Publishable contents are assembled by stage.mjs.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const cliDir = fileURLToPath(new URL("../", import.meta.url));

await build({
  absWorkingDir: cliDir,
  entryPoints: ["src/bin.ts"],
  outfile: "dist/envsync.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.12",
  // Resolve workspace packages to their TypeScript sources (see the "source" export condition).
  conditions: ["source"],
  external: ["typescript"],
  logLevel: "warning",
});

console.log("Bundled apps/cli/dist/envsync.js");
