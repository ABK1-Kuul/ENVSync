import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  compileWildmatch,
  explainIgnoreStatus,
  ignoreStatus,
  isIgnoredFile,
  isTrackedFile,
  loadIgnoreContext,
  parseGitConfig,
  parseIndex,
  wildmatch,
} from "../src/index.js";
import { makeMinimalGitDirectory } from "../../../tests/helpers.js";

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

/** Builds a raw index: header, entries (all-zero stat data and hash), optional extensions, checksum. */
function buildIndex(version: number, names: { name: Buffer; drop?: number; mode?: number }[], extensions: Buffer[] = []): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "latin1");
  header.writeUInt32BE(version, 4);
  header.writeUInt32BE(names.length, 8);
  parts.push(header);
  for (const { name, drop = 0, mode = 0o100644 } of names) {
    const fixed = Buffer.alloc(40 + 20 + 2);
    fixed.writeUInt32BE(mode, 24);
    fixed.writeUInt16BE(Math.min(name.length, 0xfff), 60);
    if (version === 4) {
      parts.push(fixed, Buffer.from([drop]), name, Buffer.from([0]));
    } else {
      const length = 62 + name.length;
      parts.push(fixed, name, Buffer.alloc(((length + 8) & ~7) - length));
    }
  }
  parts.push(...extensions, Buffer.alloc(20)); // checksum (not verified)
  return Buffer.concat(parts);
}

function extension(signature: string, size: number): Buffer {
  const head = Buffer.alloc(8);
  head.write(signature, 0, "latin1");
  head.writeUInt32BE(size, 4);
  return Buffer.concat([head, Buffer.alloc(size)]);
}

describe("index parsing is conservative", () => {
  test("rejects data that is not a valid index", () => {
    expect(parseIndex(Buffer.from("not an index"), 20)).toEqual({ kind: "invalid" });
    const header = Buffer.alloc(32);
    header.write("DIRC", 0, "latin1");
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(1_000_000, 8); // claims far more entries than bytes allow
    expect(parseIndex(header, 20)).toEqual({ kind: "invalid" });
    header.writeUInt32BE(9, 4); // unknown version
    header.writeUInt32BE(0, 8);
    expect(parseIndex(header, 20)).toEqual({ kind: "invalid" });
  });

  test("reads synthetic v2 and v4 indexes, including prefix compression", () => {
    const v2 = buildIndex(2, [{ name: Buffer.from(".env.local") }, { name: Buffer.from("apps/web/.env.local") }]);
    expect(parseIndex(v2, 20)).toEqual({ kind: "ok", paths: new Set([".env.local", "apps/web/.env.local"]) });
    const v4 = buildIndex(4, [{ name: Buffer.from("apps/web/a") }, { name: Buffer.from("b"), drop: 1 }]);
    expect(parseIndex(v4, 20)).toEqual({ kind: "ok", paths: new Set(["apps/web/a", "apps/web/b"]) });
  });

  test("split and sparse index markers are unsupported, never 'not tracked'", () => {
    const entries = [{ name: Buffer.from("a.txt") }];
    expect(parseIndex(buildIndex(2, entries, [extension("TREE", 4), extension("link", 20)]), 20)).toMatchObject({ kind: "unsupported" });
    expect(parseIndex(buildIndex(2, entries, [extension("sdir", 0)]), 20)).toMatchObject({ kind: "unsupported" });
    expect(parseIndex(buildIndex(2, [{ name: Buffer.from("apps/"), mode: 0o040000 }]), 20)).toMatchObject({ kind: "unsupported" });
  });

  test("malformed structure is invalid: truncated entries, overlong names, bad varints, overrunning extensions", () => {
    const good = buildIndex(2, [{ name: Buffer.from("a.txt") }, { name: Buffer.from("b.txt") }]);
    expect(parseIndex(good.subarray(0, 60), 20)).toEqual({ kind: "invalid" });
    expect(parseIndex(buildIndex(2, [{ name: Buffer.alloc(5_000, 0x61) }]), 20)).toEqual({ kind: "invalid" });
    expect(parseIndex(buildIndex(4, [{ name: Buffer.alloc(5_000, 0x61) }]), 20)).toEqual({ kind: "invalid" });
    // v4 names that only become too long through prefix reuse.
    expect(parseIndex(buildIndex(4, [{ name: Buffer.alloc(3_000, 0x61) }, { name: Buffer.alloc(3_000, 0x62) }]), 20)).toEqual({ kind: "invalid" });
    // v4: drop larger than the previous name, and a varint that never terminates.
    expect(parseIndex(buildIndex(4, [{ name: Buffer.from("a") }, { name: Buffer.from("b"), drop: 5 }]), 20)).toEqual({ kind: "invalid" });
    const endless = buildIndex(4, [{ name: Buffer.from("a"), drop: 0x80 }]);
    expect(parseIndex(endless, 20)).toEqual({ kind: "invalid" });
    const overrun = buildIndex(2, [{ name: Buffer.from("a.txt") }], [extension("TREE", 4)]);
    overrun.writeUInt32BE(1_000, overrun.length - 20 - 8); // extension claims more bytes than exist
    expect(parseIndex(overrun, 20)).toEqual({ kind: "invalid" });
    // Leftover bytes after the entries that are too short to be an extension header.
    expect(parseIndex(buildIndex(2, [{ name: Buffer.from("a.txt") }], [Buffer.from("abc")]), 20)).toEqual({ kind: "invalid" });
  });

  test("v4 prefix amplification is bounded in time and memory", () => {
    // Each entry keeps the whole previous name and adds 64 bytes: names grow without limit.
    const entries = Array.from({ length: 20_000 }, () => ({ name: Buffer.alloc(64, 0x61), drop: 0 }));
    const index = buildIndex(4, entries);
    const started = performance.now();
    const result = parseIndex(index, 20);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.kind).not.toBe("ok");
  });

  test("total decoded path bytes are capped even when every name is within the per-name limit", () => {
    // ~4 KB names that each cost ~64 bytes in the file (drop 1 byte, add 1): ~65x amplification.
    const entries = [{ name: Buffer.alloc(4_000, 0x61) }, ...Array.from({ length: 20_000 }, (_, i) => ({ name: Buffer.from([0x61 + (i % 26)]), drop: 1 }))];
    const index = buildIndex(4, entries);
    expect(index.length).toBeLessThan(2_000_000);
    const started = performance.now();
    expect(parseIndex(index, 20)).toMatchObject({ kind: "unsupported", reason: "the git index has more path data than EnvSync reads" });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test.skipIf(gitVersion === null)("a truncated real index is rejected rather than half-read", async () => {
    const repo = path.join(workspace, "repo");
    await initRepo(repo, false);
    await writeFile(path.join(repo, "a.txt"), "x");
    git(repo, ["add", "a.txt"]);
    const index = await readFile(path.join(repo, ".git", "index"));
    expect(parseIndex(index, 20)).toEqual({ kind: "ok", paths: new Set(["a.txt"]) });
    expect(parseIndex(index.subarray(0, 40), 20)).toEqual({ kind: "invalid" });
  });

  test.skipIf(gitVersion === null)("a real split index makes tracking unknown (it would otherwise hide a committed .env.local)", async () => {
    const repo = path.join(workspace, "repo");
    await initRepo(repo, false);
    await writeFile(path.join(repo, ".gitignore"), ".env*.local\n");
    await writeFile(path.join(repo, ".env.local"), "X=\n");
    git(repo, ["add", "-f", ".env.local", ".gitignore"]);
    git(repo, ["update-index", "--split-index"]);
    await writeFile(path.join(repo, "c.txt"), "c");
    git(repo, ["add", "c.txt"]);

    const context = await loadIgnoreContext(repo, { ceiling: workspace });
    expect(context.tracked).toMatchObject({ status: "unavailable" });
    expect(isTrackedFile(context, repo, ".env.local")).toBeUndefined();
  });

  test.skipIf(gitVersion === null)("a real sparse index makes tracking unknown", async (context) => {
    const repo = path.join(workspace, "repo");
    await initRepo(repo, false);
    for (const file of ["apps/web/.env.local", "apps/web/page.ts", "libs/x/y.ts"]) {
      await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await writeFile(path.join(repo, file), "x");
    }
    git(repo, ["add", "-f", "."]);
    git(repo, ["-c", "user.name=EnvSync Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture"]);
    try {
      git(repo, ["sparse-checkout", "init", "--cone", "--sparse-index"]);
      git(repo, ["sparse-checkout", "set", "libs"]);
    } catch {
      context.skip(`${gitVersion} does not support sparse indexes`);
    }
    const index = await readFile(path.join(repo, ".git", "index"));
    if (!index.includes(Buffer.from("sdir"))) context.skip(`${gitVersion} did not write a sparse index for this layout`);

    const ignore = await loadIgnoreContext(repo, { ceiling: workspace });
    expect(ignore.tracked).toMatchObject({ status: "unavailable" });
  });

  test("an unreadable index makes tracking unknown instead of 'not tracked'", async () => {
    const repo = path.join(workspace, "repo");
    await makeMinimalGitDirectory(repo);
    await mkdir(path.join(repo, ".git", "index")); // a directory, not a file
    const context = await loadIgnoreContext(repo, { ceiling: workspace });
    expect(context.repositoryRoot).toBe(repo);
    expect(context.tracked.status).toBe("unavailable");
    expect(isTrackedFile(context, repo, ".env.local")).toBeUndefined();
  });
});

describe("repository detection and incomplete rules", () => {
  test("a planted .git that git would not accept is not a repository root", async () => {
    const outer = path.join(workspace, "outer");
    await makeMinimalGitDirectory(outer);
    await writeFile(path.join(outer, ".gitignore"), "node_modules/\n");
    const project = path.join(outer, "apps", "web");
    await mkdir(path.join(project, ".git", "info"), { recursive: true }); // no HEAD/objects/refs
    await writeFile(path.join(project, ".git", "info", "exclude"), ".env*.local\n*\n");

    const context = await loadIgnoreContext(project, { ceiling: workspace });
    expect(context.repositoryRoot).toBe(outer);
    expect(ignoreStatus(context, project, ".env.local")).toBe("not-ignored");

    // A valid-looking HEAD alone is not enough: git also requires objects/ and refs/.
    await writeFile(path.join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect((await loadIgnoreContext(project, { ceiling: workspace })).repositoryRoot).toBe(outer);

    await writeFile(path.join(project, ".git", "HEAD"), "garbage\n");
    await mkdir(path.join(project, ".git", "objects"));
    await mkdir(path.join(project, ".git", "refs"));
    expect((await loadIgnoreContext(project, { ceiling: workspace })).repositoryRoot).toBe(outer);
  });

  test("a .git file (worktree or submodule) makes every verdict unknown", async () => {
    const root = path.join(workspace, "worktree");
    await mkdir(root);
    await writeFile(path.join(root, ".git"), "gitdir: /somewhere/else\n");
    await writeFile(path.join(root, ".gitignore"), ".env*.local\n");
    const context = await loadIgnoreContext(root, { ceiling: workspace });
    expect(explainIgnoreStatus(context, root, ".env.local")).toMatchObject({ status: "unknown" });
    expect(isTrackedFile(context, root, ".env.local")).toBeUndefined();
  });

  test("an oversized or over-limit .gitignore makes verdicts unknown, never 'ignored'", async () => {
    const repo = path.join(workspace, "repo");
    await makeMinimalGitDirectory(repo);
    await writeFile(path.join(repo, ".gitignore"), ".env*.local\n");
    const project = path.join(repo, "apps", "web");
    await mkdir(project, { recursive: true });

    // Oversized: a negation git honours sits past the size limit.
    await writeFile(path.join(project, ".gitignore"), `${"# padding\n".repeat(110_000)}!.env.local\n`);
    let verdict = explainIgnoreStatus(await loadIgnoreContext(project, { ceiling: workspace }), project, ".env.local");
    expect(verdict.status).toBe("unknown");
    expect(verdict.reasons.join(" ")).toContain("apps/web/.gitignore");

    // Rule limit: rule 10,001 is the negation.
    await writeFile(path.join(project, ".gitignore"), `${"unused-rule\n".repeat(10_000)}!.env.local\n`);
    verdict = explainIgnoreStatus(await loadIgnoreContext(project, { ceiling: workspace }), project, ".env.local");
    expect(verdict.status).toBe("unknown");

    // Unrelated directories are unaffected by an incomplete ruleset elsewhere.
    const sibling = path.join(repo, "apps", "admin");
    await mkdir(sibling, { recursive: true });
    expect(ignoreStatus(await loadIgnoreContext(sibling, { ceiling: workspace }), sibling, ".env.local")).toBe("ignored");
  });

  test("a symlinked .gitignore is not followed and makes verdicts unknown", async (context) => {
    const repo = path.join(workspace, "repo");
    await makeMinimalGitDirectory(repo);
    const target = path.join(workspace, "elsewhere.txt");
    await writeFile(target, ".env*.local\n");
    try {
      await symlink(target, path.join(repo, ".gitignore"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip("file symlinks are not permitted for this user on this platform");
      throw error;
    }
    expect(ignoreStatus(await loadIgnoreContext(repo, { ceiling: workspace }), repo, ".env.local")).toBe("unknown");
  });
});

describe("git config parsing", () => {
  test("reads core.ignorecase and the object format", () => {
    expect(parseGitConfig("[core]\n\tignorecase = true\n[extensions]\n\tobjectformat = sha256\n")).toEqual({ ignoreCase: true, sha256: true, unparsedLines: 0 });
    expect(parseGitConfig('[core]\n\tIgnoreCase = false ; comment\n[remote "origin"]\n\tignorecase = true\n')).toMatchObject({ ignoreCase: false, sha256: false });
    expect(parseGitConfig("[core]\n\tignorecase = true # comment\n")).toMatchObject({ ignoreCase: true });
  });

  test("pathological lines are linear-time and counted as unparsed", () => {
    const started = performance.now();
    const result = parseGitConfig(`[core]\n\tignorecase = a${" ".repeat(500_000)}b\n${"[".repeat(100_000)}\n`);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.ignoreCase).toBe(false);
    expect(result.unparsedLines).toBeGreaterThan(0);
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

describe.skipIf(gitVersion === null)("non-ASCII and unusual directory names agree with git", () => {
  const UMLAUT = String.fromCodePoint(0xe4); // a-umlaut, 2 bytes in UTF-8
  const UPPER_UMLAUT = String.fromCodePoint(0xc4);
  const cases: { project: string; patterns: string[] }[] = [
    { project: `${UMLAUT}pps/web`, patterns: ["?pps/web/.env.local", "??pps/web/.env.local", "[!x]pps/web/.env.local", `${UPPER_UMLAUT}PPS/`, `${UMLAUT}pps/`, "*pps/web/.env.local"] },
    // Git folds ASCII only: an upper-case non-ASCII directory does not match a lower-case pattern.
    { project: `${UPPER_UMLAUT}PPS/web`, patterns: [`${UMLAUT}pps/`, `${UMLAUT}PPS/`, `${UPPER_UMLAUT}pps/`] },
    { project: "..x/web", patterns: ["*", "..x/", "/..x/web/.env.local"] },
  ];
  for (const ignoreCase of [false, true]) {
    for (const { project, patterns } of cases) {
      for (const pattern of patterns) {
        test(`core.ignorecase=${ignoreCase}: ${JSON.stringify(pattern)} for project ${JSON.stringify(project)}`, async () => {
          const repo = path.join(workspace, "repo");
          await initRepo(repo, ignoreCase);
          await writeFile(path.join(repo, ".gitignore"), `${pattern}\n`);
          const dir = path.join(repo, ...project.split("/"));
          await mkdir(dir, { recursive: true });
          expect(await oursIgnored(dir, [".env.local"])).toEqual(gitIgnored(dir, [".env.local"]));
        });
      }
    }
  }
});
