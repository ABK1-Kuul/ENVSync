// Assembles the publishable `envsync` package in a directory outside the source tree, so no
// generated copies are ever left in the repository. Usage:
//   node apps/cli/scripts/stage.mjs [--out <empty-or-new-directory>] [--no-bundle]
// Then: npm pack <dir>   (or, for a release: npm publish <dir>)
// --no-bundle reuses an existing dist/envsync.js (used by tests that stage a copied tree).
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--no-bundle")) await import("./bundle.mjs");

const cliDir = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const repositoryBlobUrl = "https://github.com/ABK1-Kuul/ENVSync/blob/main/";

// Every published input must be a regular file: a symlinked LICENSE/README/CHANGELOG (or bundle)
// would otherwise publish whatever it points to.
const inputs = {
  bundle: path.join(cliDir, "dist", "envsync.js"),
  manifest: path.join(cliDir, "package.json"),
  license: path.join(repoRoot, "LICENSE"),
  changelog: path.join(repoRoot, "CHANGELOG.md"),
  readme: path.join(repoRoot, "README.md"),
};
for (const file of Object.values(inputs)) {
  const stats = await lstat(file);
  if (!stats.isFile()) throw new Error(`Refusing to stage ${file}: it is not a regular file (symbolic links are not followed).`);
}

const outIndex = process.argv.findIndex((arg) => arg === "--out" || arg.startsWith("--out="));
let outDir;
if (outIndex !== -1) {
  const arg = process.argv[outIndex];
  const value = arg.startsWith("--out=") ? arg.slice("--out=".length) || undefined : process.argv[outIndex + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("--out needs a directory, for example: --out ./envsync-stage");
  outDir = path.resolve(value);
  await mkdir(outDir, { recursive: true });
  if ((await readdir(outDir)).length > 0) throw new Error(`Refusing to stage into non-empty directory ${outDir}`);
} else {
  outDir = await mkdtemp(path.join(tmpdir(), "envsync-stage-"));
}

// Only fields consumers need. Dropping devDependencies and scripts keeps internal package names
// and build tooling out of the published manifest; `private` is dropped only here.
const source = JSON.parse(await readFile(inputs.manifest, "utf8"));
const PUBLISHED_FIELDS = ["name", "version", "description", "license", "type", "bin", "files", "engines", "keywords", "repository", "homepage", "bugs", "dependencies"];
const manifest = Object.fromEntries(PUBLISHED_FIELDS.filter((field) => field in source).map((field) => [field, source[field]]));
await writeFile(path.join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

await mkdir(path.join(outDir, "dist"));
await copyFile(inputs.bundle, path.join(outDir, "dist", "envsync.js"));
await chmod(path.join(outDir, "dist", "envsync.js"), 0o755);
await copyFile(inputs.license, path.join(outDir, "LICENSE"));
await copyFile(inputs.changelog, path.join(outDir, "CHANGELOG.md"));

// Relative links in the repository README would be broken on npm; point them at GitHub instead.
const readme = await readFile(inputs.readme, "utf8");
await writeFile(
  path.join(outDir, "README.md"),
  readme.replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_match, target) => `](${repositoryBlobUrl}${target})`),
);

console.log(outDir);
