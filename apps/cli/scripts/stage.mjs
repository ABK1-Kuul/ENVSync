// Assembles the publishable `envsync` package in a directory outside the source tree, so no
// generated copies are ever left in the repository. Usage:
//   node apps/cli/scripts/stage.mjs [--out <empty-or-new-directory>]
// Then: npm pack <dir>   (or, for a release: npm publish <dir>)
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./bundle.mjs";

const cliDir = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const repositoryBlobUrl = "https://github.com/ABK1-Kuul/ENVSync/blob/main/";

const outIndex = process.argv.indexOf("--out");
let outDir;
if (outIndex !== -1) {
  outDir = path.resolve(process.argv[outIndex + 1] ?? "");
  await mkdir(outDir, { recursive: true });
  if ((await readdir(outDir)).length > 0) throw new Error(`Refusing to stage into non-empty directory ${outDir}`);
} else {
  outDir = await mkdtemp(path.join(tmpdir(), "envsync-stage-"));
}

// Only fields consumers need. Dropping devDependencies and scripts keeps internal package names
// and build tooling out of the published manifest; `private` is dropped only here.
const source = JSON.parse(await readFile(path.join(cliDir, "package.json"), "utf8"));
const PUBLISHED_FIELDS = ["name", "version", "description", "license", "type", "bin", "files", "engines", "keywords", "repository", "homepage", "bugs", "dependencies"];
const manifest = Object.fromEntries(PUBLISHED_FIELDS.filter((field) => field in source).map((field) => [field, source[field]]));
await writeFile(path.join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

await mkdir(path.join(outDir, "dist"));
await copyFile(path.join(cliDir, "dist", "envsync.js"), path.join(outDir, "dist", "envsync.js"));
await chmod(path.join(outDir, "dist", "envsync.js"), 0o755);
await copyFile(path.join(repoRoot, "LICENSE"), path.join(outDir, "LICENSE"));
await copyFile(path.join(repoRoot, "CHANGELOG.md"), path.join(outDir, "CHANGELOG.md"));

// Relative links in the repository README would be broken on npm; point them at GitHub instead.
const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
await writeFile(
  path.join(outDir, "README.md"),
  readme.replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_match, target) => `](${repositoryBlobUrl}${target})`),
);

console.log(outDir);
