// Packages the extension as apps/vscode/dist-pkg/envsync-vscode.vsix (gitignored), from an
// allow-listed staging folder so only the bundle, the webview files, README and LICENSE are inside.
// The manifest is copied without dependencies or scripts: everything runtime is in the bundle.
// Run `pnpm --filter envsync-vscode run bundle` first.
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(extensionDir, "../..");
const outDir = path.join(extensionDir, "dist-pkg");
const stage = path.join(outDir, "stage");
const vsix = path.join(outDir, "envsync-vscode.vsix");

await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(stage, "dist"), { recursive: true });

const bundle = path.join(extensionDir, "dist/extension.cjs");
if (!(await stat(bundle).catch(() => null))?.isFile()) throw new Error("dist/extension.cjs is missing; run the bundle script first.");

const manifest = JSON.parse(await readFile(path.join(extensionDir, "package.json"), "utf8"));
delete manifest.dependencies;
delete manifest.devDependencies;
delete manifest.scripts;
delete manifest.private;
manifest.repository = { type: "git", url: "https://github.com/ABK1-Kuul/ENVSync.git", directory: "apps/vscode" };
manifest.files = ["dist/extension.cjs", "media", "README.md", "LICENSE"];
await writeFile(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await copyFile(bundle, path.join(stage, "dist/extension.cjs"));
await cp(path.join(extensionDir, "media"), path.join(stage, "media"), { recursive: true });
await copyFile(path.join(extensionDir, "README.md"), path.join(stage, "README.md"));
await copyFile(path.join(repoRoot, "LICENSE"), path.join(stage, "LICENSE"));

const vsce = path.join(extensionDir, "node_modules/@vscode/vsce/vsce");
const run = (args) => execFileSync(process.execPath, [vsce, ...args], { cwd: stage, encoding: "utf8" });
const files = run(["ls", "--no-dependencies"]).trim().split(/\r?\n/).sort();
console.log(`Files in the package:\n  ${files.join("\n  ")}`);
run(["package", "--no-dependencies", "--out", vsix]);
console.log(`Packaged ${path.relative(repoRoot, vsix)}`);
