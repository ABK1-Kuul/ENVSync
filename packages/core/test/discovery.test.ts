import { mkdir, mkdtemp, readFile, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { discoverSourceFiles, DiscoveryError } from "../src/index.js";

// Spy on content-reading APIs so tests can prove discovery never opens files.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) };
});

const FAKE_SECRET = "ENVSYNC_FAKE_SECRET_DO_NOT_LEAK";

let workspace: string;
let root: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "envsync-discovery-"));
  root = path.join(workspace, "project");
  await mkdir(root);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function writeTree(base: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(base, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
}

describe("discoverSourceFiles", () => {
  test("returns sorted, root-relative source files with forward slashes", async () => {
    await writeTree(root, {
      "src/lib/db.ts": "",
      "src/index.tsx": "",
      "app/page.jsx": "",
      "app/api/route.js": "",
      "next.config.mjs": "",
      "scripts/setup.cjs": "",
      "src/esm.mts": "",
      "src/cjs.cts": "",
      "README.md": "",
      "public/logo.svg": "",
      "src/styles.css": "",
    });

    const result = await discoverSourceFiles(root);

    expect(result.files).toEqual([
      "app/api/route.js",
      "app/page.jsx",
      "next.config.mjs",
      "scripts/setup.cjs",
      "src/cjs.cts",
      "src/esm.mts",
      "src/index.tsx",
      "src/lib/db.ts",
    ]);
    expect(result.skipped).toEqual([]);
  });

  test("never descends into excluded directories at any depth", async () => {
    await writeTree(root, {
      "src/keep.ts": "",
      ".git/hooks/pre-commit.js": "",
      "node_modules/pkg/index.js": "",
      "packages/a/node_modules/dep/index.js": "",
      ".next/server/page.js": "",
      "dist/index.js": "",
      "build/out.js": "",
      "out/static.js": "",
      "coverage/lcov.js": "",
      "Node_Modules/upper/index.js": "",
    });

    const result = await discoverSourceFiles(root);

    expect(result.files).toEqual(["src/keep.ts"]);
  });

  test("never returns environment files, including .env.example", async () => {
    await writeTree(root, {
      "src/config.ts": "",
      ".env": `API_KEY=${FAKE_SECRET}`,
      ".env.local": `API_KEY=${FAKE_SECRET}`,
      ".env.production": `API_KEY=${FAKE_SECRET}`,
      ".env.example": "API_KEY=",
      "nested/.env.local": `API_KEY=${FAKE_SECRET}`,
      ".env.config.ts": `export const key = "${FAKE_SECRET}";`,
      ".ENV.LOCAL.js": `export const key = "${FAKE_SECRET}";`,
    });

    const result = await discoverSourceFiles(root);

    expect(result.files).toEqual(["src/config.ts"]);
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET);
  });

  test("excludes generated type declarations", async () => {
    await writeTree(root, {
      "next-env.d.ts": "",
      "types/global.d.mts": "",
      "types/legacy.d.cts": "",
      "src/real.ts": "",
    });

    const result = await discoverSourceFiles(root);

    expect(result.files).toEqual(["src/real.ts"]);
  });

  test("does not read any file contents", async () => {
    await writeTree(root, { "src/a.ts": "", ".env.local": `API_KEY=${FAKE_SECRET}` });
    vi.mocked(readFile).mockClear();
    vi.mocked(open).mockClear();

    await discoverSourceFiles(root);

    expect(readFile).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  test("does not follow a directory link that points outside the root", async () => {
    const outside = path.join(workspace, "outside");
    await writeTree(outside, { "leaked.ts": "" });
    await writeTree(root, { "src/a.ts": "" });
    // Junctions need no elevated privilege on Windows and are reported as symlinks by Node.
    await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");

    const result = await discoverSourceFiles(root);

    expect(result.files).toEqual(["src/a.ts"]);
    expect(result.skipped).toEqual([{ path: "linked", reason: "symlink" }]);
  });

  test("does not follow a file symlink", async (context) => {
    const outside = path.join(workspace, "outside");
    await writeTree(outside, { "leaked.ts": "" });
    await writeTree(root, { "src/a.ts": "" });
    try {
      await symlink(path.join(outside, "leaked.ts"), path.join(root, "src", "link.ts"), "file");
    } catch (error) {
      // Windows requires Developer Mode or elevation for file symlinks.
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("file symlinks are not permitted for this user on this platform");
      }
      throw error;
    }

    const result = await discoverSourceFiles(root);

    expect(result.files).toEqual(["src/a.ts"]);
    expect(result.skipped).toEqual([{ path: "src/link.ts", reason: "symlink" }]);
  });

  test("rejects a missing root with an actionable error", async () => {
    const missing = path.join(workspace, "does-not-exist");

    const error = await discoverSourceFiles(missing).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DiscoveryError);
    expect(error).toMatchObject({ code: "ROOT_NOT_FOUND" });
    expect((error as Error).message).toContain("Pass the path to your project directory");
  });

  test("rejects a file passed as the root", async () => {
    const file = path.join(workspace, "package.json");
    await writeFile(file, "{}");

    const error = await discoverSourceFiles(file).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DiscoveryError);
    expect(error).toMatchObject({ code: "ROOT_NOT_DIRECTORY" });
  });

  test("produces identical output across runs", async () => {
    await writeTree(root, { "b.ts": "", "a.ts": "", "C.ts": "", "dir/z.js": "", "dir/a.js": "" });

    const first = await discoverSourceFiles(root);
    const second = await discoverSourceFiles(root);

    expect(second).toEqual(first);
  });
});
