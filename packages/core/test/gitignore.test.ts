import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isIgnoredFile, loadIgnoreContext } from "../src/index.js";

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "envsync-gitignore-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function repo(files: Record<string, string>, projectDir = ""): Promise<string> {
  await mkdir(path.join(workspace, ".git", "info"), { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await writeFile(path.join(workspace, relative), content);
  }
  const root = path.join(workspace, projectDir);
  await mkdir(root, { recursive: true });
  return root;
}

async function ignored(root: string, names: string[]): Promise<Record<string, boolean>> {
  const context = await loadIgnoreContext(root);
  return Object.fromEntries(names.map((name) => [name, isIgnoredFile(context, root, name)]));
}

describe("gitignore evaluation", () => {
  test.each([
    [".env*.local", { ".env": false, ".env.local": true, ".env.production.local": true }],
    [".env*", { ".env": true, ".env.local": true, ".env.production.local": true }],
    [".env\n.env.local", { ".env": true, ".env.local": true, ".env.production.local": false }],
    [".env*\n!.env", { ".env": false, ".env.local": true, ".env.production.local": true }],
    ["*.local", { ".env": false, ".env.local": true, ".env.production.local": true }],
    ["/.env.local", { ".env": false, ".env.local": true, ".env.production.local": false }],
    ["**/.env.local", { ".env": false, ".env.local": true, ".env.production.local": false }],
    [".env.[lp]*", { ".env": false, ".env.local": true, ".env.production.local": true }],
    ["# .env.local\n\\#nope", { ".env": false, ".env.local": false, ".env.production.local": false }],
    [".env.local/", { ".env": false, ".env.local": false, ".env.production.local": false }],
  ])("root .gitignore %j", async (rules, expected) => {
    const root = await repo({ ".gitignore": rules });
    expect(await ignored(root, Object.keys(expected))).toEqual(expected);
  });

  test("rules from a parent .gitignore apply to a nested project; deeper files take precedence", async () => {
    const root = await repo({ ".gitignore": ".env*.local\n", "apps/web/.gitignore": "!.env.local\n" }, "apps/web");
    expect(await ignored(root, [".env.local", ".env.test.local"])).toEqual({ ".env.local": false, ".env.test.local": true });
  });

  test("anchored rules in a parent are matched against the path from that parent", async () => {
    const root = await repo({ ".gitignore": "apps/web/.env.local\n/.env.test.local\n" }, "apps/web");
    expect(await ignored(root, [".env.local", ".env.test.local"])).toEqual({ ".env.local": true, ".env.test.local": false });
  });

  test("an ignored ancestor directory ignores the file even if a deeper rule re-includes it", async () => {
    const root = await repo({ ".gitignore": "apps/\n", "apps/web/.gitignore": "!.env.local\n" }, "apps/web");
    expect(await ignored(root, [".env.local"])).toEqual({ ".env.local": true });
  });

  test(".git/info/exclude is honoured with the lowest precedence", async () => {
    const root = await repo({ ".git/info/exclude": ".env.local\n.env\n", ".gitignore": "!.env\n" });
    expect(await ignored(root, [".env.local", ".env"])).toEqual({ ".env.local": true, ".env": false });
  });

  test("outside a git repository nothing is reported as ignored", async () => {
    const root = path.join(workspace, "no-repo");
    await mkdir(root);
    await writeFile(path.join(root, ".gitignore"), ".env*\n");
    const context = await loadIgnoreContext(root);
    // A .git further up (e.g. the user's home) could exist on a developer machine; only assert when none was found.
    if (context.repositoryRoot === null) expect(isIgnoredFile(context, root, ".env.local")).toBe(false);
  });
});
