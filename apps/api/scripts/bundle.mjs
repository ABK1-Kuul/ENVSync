// Bundles the API server into apps/api/dist/server.mjs (gitignored). Runtime dependencies (fastify,
// jose, postgres) stay external and are resolved from apps/api/node_modules.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.12",
  conditions: ["source"],
  packages: "external",
  logLevel: "warning",
});

console.log("Bundled apps/api/dist/server.mjs");
