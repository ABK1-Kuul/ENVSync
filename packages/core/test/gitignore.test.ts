import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  compileWildmatch,
  isIgnoredFile,
  isTrackedFile,
  loadIgnoreContext,
  parseGitConfig,
  parseIndex,
  wildmatch,
} from "../src/index.js";

// Tests may run git (product code may not): it is the reference implementation for these rules.
const gitVersion = (() => {
  try {
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const NBSP = String.fromCharCode(0xa0);

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "envsync-gitignore-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", ...(input === undefined ? {} : { input }) });
}

async function initRepo(dir: string, ignoreCase: boolean): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "core.ignorecase", String(ignoreCase)]);
}

/** Git's verdict for files directly in `dir`: ignored unless the deciding pattern is a negation. */
function gitIgnored(dir: string, names: string[]): Record<string, boolean> {
  let output = "";
  try {
    output = git(dir, ["check-ignore", "--no-index", "--stdin", "-z", "-v", "-n"], names.join("\0") + "\0");
  } catch (error) {
    // Exit code 1 means "nothing ignored"; stdout still carries the -n records.
    output = String((error as { stdout?: string }).stdout ?? "");
  }
  const fields = output.split("\0");
  const result: Record<string, boolean> = {};
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [source, , pattern, name] = fields.slice(i, i + 4) as [string, string, string, string];
    result[name] = source !== "" && !pattern.startsWith("!");
  }
  return result;
}

async function oursIgnored(dir: string, names: string[]): Promise<Record<string, boolean>> {
  const context = await loadIgnoreContext(dir, { ceiling: workspace });
  return Object.fromEntries(names.map((name) => [name, isIgnoredFile(context, dir, name)]));
}

const NAMES = [".env", ".env.local", ".env.production.local", ".env.LOCAL", ".ENV.local", ".env.example", "a!b", "#nope"];

// Each entry is the full .gitignore content. Includes every case from the security review.
const CORPUS: string[] = [
  ".env*.local",
  ".env*",
  ".env\n.env.local",
  ".env*\n!.env",
  ".env*\n!.ENV.local",
  "*.local",
  "*.LOCAL",
  "/.env.local",
  "**/.env.local",
  "**",
  "*",
  ".env*.local\n!*",
  ".env.[lp]*",
  ".env.l?cal",
  ".env.\\l*",
  "# .env.local",
  "\\#nope",
  "\\!x\na\\!b",
  "!",
  ".env.local/",
  `.env*.local${TAB}`,
  `.env*.local${NBSP}`,
  ".env*.local  ",
  ".env.local\\ ",
  `foo${CR}.env.local`,
  `.env.local${CR}`,
  ".env.loca[!]",
  ".env.loca[^]",
  ".env.loca[]l]",
  ".env.[z-a]ocal",
  ".env.[[:lower:]]ocal",
  ".env.[[:bogus:]]ocal",
  ".env.[!a-k]ocal",
  ".env.local\\",
  "*a*a*a*a*a*a*a*a*a*a*a*a*b",
];

describe.skipIf(gitVersion === null)(`gitignore matching agrees with ${gitVersion ?? "git"}`, () => {
  for (const ignoreCase of [false, true]) {
    test.each(CORPUS.map((content) => [JSON.stringify(content), content]))(`core.ignorecase=${ignoreCase}: %s`, async (_label, content) => {
      const dir = path.join(workspace, "repo");
      await initRepo(dir, ignoreCase);
      await writeFile(path.join(dir, ".gitignore"), content);
      expect(await oursIgnored(dir, NAMES)).toEqual(gitIgnored(dir, NAMES));
    });
  }

  test("nested .gitignore files, anchoring relative to their directory, and ignored ancestors", async () => {
    const repo = path.join(workspace, "repo");
    await initRepo(repo, false);
    const cases: Record<string, string>[] = [
      { ".gitignore": ".env*.local\n", "apps/web/.gitignore": "!.env.local\n" },
      { ".gitignore": "apps/web/.env.local\n/.env.test.local\n" },
      { ".gitignore": "apps/\n", "apps/web/.gitignore": "!.env.local\n" },
      { ".gitignore": "apps/**/.env.local\n" },
      { ".gitignore": "/apps/*/.env*\n!/apps/web/.env.production.local\n" },
      { ".gitignore": "web/\n" },
      // `?` and classes never match `/`, so these must not ignore apps/web/.env.local.
      { ".gitignore": "apps[/]web/.env.local\n" },
      { ".gitignore": "apps?web/.env.local\n" },
      { ".gitignore": "apps[!a]web/.env.local\n" },
    ];
    for (const files of cases) {
      await rm(path.join(repo, "apps"), { recursive: true, force: true });
      await rm(path.join(repo, ".gitignore"), { force: true });
      for (const [relative, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
        await writeFile(path.join(repo, relative), content);
      }
      const project = path.join(repo, "apps", "web");
      await mkdir(project, { recursive: true });
      const names = [".env.local", ".env.test.local", ".env.production.local"];
      const ours = await oursIgnored(project, names);
      const theirs = gitIgnored(project, names);
      expect({ files, verdict: ours }).toEqual({ files, verdict: theirs });
    }
  });

  test(".git/info/exclude has the lowest precedence", async () => {
    const repo = path.join(workspace, "repo");
    await initRepo(repo, false);
    await writeFile(path.join(repo, ".git", "info", "exclude"), ".env.local\n.env\n");
    await writeFile(path.join(repo, ".gitignore"), "!.env\n");
    expect(await oursIgnored(repo, [".env.local", ".env"])).toEqual(gitIgnored(repo, [".env.local", ".env"]));
  });

  test("tracked files are detected from the index, including index v4 and ignorecase", async () => {
    const repo = path.join(workspace, "repo");
    await initRepo(repo, true);
    await writeFile(path.join(repo, ".gitignore"), ".env*.local\n");
    await writeFile(path.join(repo, ".env.local"), "PLACEHOLDER=\n");
    await mkdir(path.join(repo, "apps", "web"), { recursive: true });
    await writeFile(path.join(repo, "apps", "web", ".env.local"), "PLACEHOLDER=\n");
    git(repo, ["add", "-f", ".env.local", "apps/web/.env.local", ".gitignore"]);

    for (const version of ["2", "3", "4"]) {
      git(repo, ["update-index", "--index-version", version]);
      const context = await loadIgnoreContext(repo, { ceiling: workspace });
      expect(context.tracked.status).toBe("ok");
      expect(isIgnoredFile(context, repo, ".env.local")).toBe(true);
      expect(isTrackedFile(context, repo, ".env.local")).toBe(true);
      expect(isTrackedFile(context, repo, ".ENV.LOCAL")).toBe(true); // core.ignorecase=true
      expect(isTrackedFile(context, repo, ".env.test.local")).toBe(false);
      expect(isTrackedFile(context, path.join(repo, "apps", "web"), ".env.local")).toBe(true);
    }
  });
});

describe("wildmatch is linear-time on hostile input", () => {
  test("many stars against a long non-matching name finish quickly", () => {
    const pattern = compileWildmatch(`${"*a".repeat(60)}*b`, false);
    const name = `.env.${"a".repeat(20_000)}`;
    const started = performance.now();
    expect(wildmatch(pattern, name)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("repeated globstars against a deep path finish quickly", () => {
    const pattern = compileWildmatch(`${"**/".repeat(200)}x`, false);
    const text = `${"d/".repeat(2_000)}y`;
    const started = performance.now();
    expect(wildmatch(pattern, text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("malformed classes never throw", () => {
    for (const pattern of ["[z-a]", "[", "[!", "[[:x:]]", "a\\", "[a-", "[\\"]) {
      expect(() => wildmatch(compileWildmatch(pattern, false), "a")).not.toThrow();
    }
  });
});

describe("index parsing is defensive", () => {
  test("rejects data that is not a valid index", () => {
    expect(parseIndex(Buffer.from("not an index"), 20)).toBeNull();
    const header = Buffer.alloc(12);
    header.write("DIRC", 0, "latin1");
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(1_000_000, 8); // claims far more entries than bytes allow
    expect(parseIndex(header, 20)).toBeNull();
    header.writeUInt32BE(9, 4); // unknown version
    header.writeUInt32BE(0, 8);
    expect(parseIndex(header, 20)).toBeNull();
  });

  test.skipIf(gitVersion === null)("a truncated real index is rejected rather than half-read", async () => {
    const repo = path.join(workspace, "repo");
    await initRepo(repo, false);
    await writeFile(path.join(repo, "a.txt"), "x");
    git(repo, ["add", "a.txt"]);
    const index = await readFile(path.join(repo, ".git", "index"));
    expect(parseIndex(index, 20)).toEqual(new Set(["a.txt"]));
    expect(parseIndex(index.subarray(0, 40), 20)).toBeNull();
  });

  test("an unreadable index makes tracking unknown instead of 'not tracked'", async () => {
    const repo = path.join(workspace, "repo");
    await mkdir(path.join(repo, ".git", "index"), { recursive: true }); // a directory, not a file
    const context = await loadIgnoreContext(repo, { ceiling: workspace });
    expect(context.tracked.status).toBe("unavailable");
    expect(isTrackedFile(context, repo, ".env.local")).toBeUndefined();
  });
});

describe("git config and search boundaries", () => {
  test("reads core.ignorecase and the object format", () => {
    expect(parseGitConfig("[core]\n\tignorecase = true\n[extensions]\n\tobjectformat = sha256\n")).toEqual({ ignoreCase: true, sha256: true });
    expect(parseGitConfig('[core]\n\tIgnoreCase = false ; comment\n[remote "origin"]\n\tignorecase = true\n')).toEqual({ ignoreCase: false, sha256: false });
  });

  test("outside a git repository nothing is ignored or tracked", async () => {
    const root = path.join(workspace, "no-repo");
    await mkdir(root);
    await writeFile(path.join(root, ".gitignore"), ".env*\n");
    const context = await loadIgnoreContext(root, { ceiling: workspace });
    expect(context.repositoryRoot).toBeNull();
    expect(isIgnoredFile(context, root, ".env.local")).toBe(false);
  });
});
