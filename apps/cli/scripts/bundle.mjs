// Builds the publishable `envsync` package: one ESM file with the internal workspace packages
// bundled in, so nothing under @envsync-internal/* is ever resolved from a registry.
// `typescript` stays external and is the package's only runtime dependency.
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const cliDir = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const repositoryUrl = "https://github.com/ABK1-Kuul/ENVSync/blob/main/";

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

await copyFile(`${repoRoot}LICENSE`, `${cliDir}LICENSE`);
await copyFile(`${repoRoot}CHANGELOG.md`, `${cliDir}CHANGELOG.md`);

// Relative links in the repository README would be broken on npm; point them at GitHub instead.
const readme = await readFile(`${repoRoot}README.md`, "utf8");
await writeFile(
  `${cliDir}README.md`,
  readme.replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_match, target) => `](${repositoryUrl}${target})`),
);

console.log("Bundled apps/cli/dist/envsync.js");
