import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Builds the publishable package exactly as a release would (bundle + stage), outside the repo.
const stageScript = fileURLToPath(new URL("../scripts/stage.mjs", import.meta.url));
let workspace: string;
let stageDir: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "envsync-package-"));
  stageDir = path.join(workspace, "stage");
  execFileSync(process.execPath, [stageScript, "--out", stageDir], { stdio: "pipe" });
}, 60_000);

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("staged npm package", () => {
  test("contains exactly the published files", async () => {
    const entries = await readdir(stageDir, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => path.relative(stageDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
    expect(files.sort()).toEqual(["CHANGELOG.md", "LICENSE", "README.md", "dist/envsync.js", "package.json"]);
  });

  test("the manifest exposes no internal packages, build scripts or private flag", async () => {
    const manifest = JSON.parse(await readFile(path.join(stageDir, "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.name).toBe("envsync");
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.bin).toEqual({ envsync: "./dist/envsync.js" });
    expect(manifest.dependencies).toEqual({ typescript: "6.0.3" });
    for (const field of ["devDependencies", "scripts", "private", "peerDependencies", "optionalDependencies"]) {
      expect(manifest).not.toHaveProperty(field);
    }
  });

  test("the bundle imports only Node built-ins and typescript, and names no internal package", async () => {
    const bundle = await readFile(path.join(stageDir, "dist", "envsync.js"), "utf8");
    expect(bundle.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(bundle).not.toContain("@envsync-internal");
    const imports = new Set([...bundle.matchAll(/^import [^;]* from "([^"]+)"/gm)].map((match) => match[1]));
    expect([...imports].filter((specifier) => !specifier?.startsWith("node:"))).toEqual(["typescript"]);
  });

  test("README links point at the repository instead of relative paths", async () => {
    const readme = await readFile(path.join(stageDir, "README.md"), "utf8");
    expect(readme).not.toMatch(/\]\((?!https?:|#|mailto:)/);
  });

  test("the staged binary runs with only its declared dependency available", async () => {
    // Provide `typescript` the way an install would (a link stands in for npm here); nothing else.
    const typescriptDir = path.dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
    await mkdir(path.join(stageDir, "node_modules"));
    await symlink(typescriptDir, path.join(stageDir, "node_modules", "typescript"), process.platform === "win32" ? "junction" : "dir");

    const run = (args: string[]) => {
      try {
        return { code: 0, stdout: execFileSync(process.execPath, [path.join(stageDir, "dist", "envsync.js"), ...args], { encoding: "utf8" }) };
      } catch (error) {
        return { code: (error as { status: number }).status, stdout: String((error as { stdout?: string }).stdout ?? "") };
      }
    };
    expect(run(["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const fixture = fileURLToPath(new URL("../../../tests/fixtures/next-pages-router", import.meta.url));
    const scan = run(["scan", fixture, "--format", "json"]);
    expect(scan.code).toBe(1); // the drift fixture has findings
    expect(JSON.parse(scan.stdout)).toMatchObject({ schemaVersion: 1 });
  });
});
