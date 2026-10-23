import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runDoctor } from "@envsync-internal/core";
import { nextFramework } from "@envsync-internal/parser-next";
import { afterEach, describe, expect, test, vi } from "vitest";
import { copyFixture, FAKE_SECRET, runCli, type FixtureCopy } from "../helpers.js";

// Tests may use git as a reference tool; product code never runs it.
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

// Record every path whose contents are read, to prove doctor never opens .env files.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) };
});

let fixture: FixtureCopy | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

type DoctorJson = {
  summary: { pass: number; warn: number; fail: number; skip: number; exitCode: number };
  checks: { id: string; status: string; message: string; suggestion?: string }[];
};

/** Copies the healthy fixture into a fake git repository with a typical Next.js .gitignore. */
async function healthyRepo(gitignore = ".env*.local\nnode_modules/\n"): Promise<string> {
  fixture = await copyFixture("next-app-router");
  await mkdir(path.join(fixture.root, ".git"));
  await writeFile(path.join(fixture.root, ".gitignore"), gitignore);
  return fixture.root;
}

async function doctor(root: string, nodeVersion = "22.12.0") {
  const { main } = await import("../../apps/cli/src/main.js");
  let stdout = "";
  let stderr = "";
  const exitCode = await main(["doctor", "--format", "json"], {
    cwd: root,
    nodeVersion,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr, json: JSON.parse(stdout) as DoctorJson };
}

const statuses = (json: DoctorJson) => Object.fromEntries(json.checks.map((check) => [check.id, check.status]));

describe("envsync doctor", () => {
  test("a healthy project passes every check", async () => {
    const root = await healthyRepo();
    await writeFile(path.join(root, ".env.local"), `AUTH_SECRET=${FAKE_SECRET}\n`);

    const run = await doctor(root);
    expect(run.exitCode).toBe(0);
    expect(statuses(run.json)).toEqual({
      "node-version": "pass",
      "source-files": "pass",
      "package-json": "pass",
      framework: "pass",
      config: "pass",
      "env-example": "pass",
      "env-files-ignored": "pass",
    });
    expect(run.json.checks.find((c) => c.id === "env-files-ignored")?.message).toContain("Their contents were not read.");
    // Matches the "4 files" that scan reports for this fixture.
    expect(run.json.checks.find((c) => c.id === "source-files")?.message).toBe("Found 4 source files to scan.");
  });

  test("terminal output spells out each status and a summary", async () => {
    const root = await healthyRepo();
    const run = await runCli(["doctor"], root);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/^PASS {2}node-version: Node\.js /m);
    expect(run.stdout).toContain("Doctor: 0 failures, 0 warnings, 7 passed.");
  });

  test("never reads the contents of .env files and never prints their values", async () => {
    const root = await healthyRepo(".gitignore\n");
    for (const name of [".env", ".env.local", ".env.production"]) await writeFile(path.join(root, name), `SECRET=${FAKE_SECRET}\n`);
    vi.mocked(readFile).mockClear();
    vi.mocked(open).mockClear();

    const json = await doctor(root);
    const terminal = await runCli(["doctor"], root);

    const touched = [...vi.mocked(readFile).mock.calls, ...vi.mocked(open).mock.calls].map((call) => path.basename(String(call[0])));
    expect(touched.filter((name) => /^\.env(?!\.example$)/.test(name))).toEqual([]);
    expect(json.stdout + json.stderr + terminal.stdout + terminal.stderr).not.toContain(FAKE_SECRET);
  });

  test("does not run package scripts", async () => {
    const root = await healthyRepo();
    await doctor(root);
    await expect(readFile(path.join(root, "ENVSYNC_SCRIPT_WAS_RUN"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an unignored .env.local fails; an unignored shared .env only warns", async () => {
    const root = await healthyRepo("node_modules/\n");
    await writeFile(path.join(root, ".env"), "PUBLIC_DEFAULT=1\n");
    await writeFile(path.join(root, ".env.local"), `SECRET=${FAKE_SECRET}\n`);
    const failing = await doctor(root);
    expect(failing.exitCode).toBe(1);
    expect(failing.json.checks.find((c) => c.id === "env-files-ignored")).toMatchObject({
      status: "fail",
      message: ".env.local is not ignored by git, so local secrets could be committed.",
    });

    await rm(path.join(root, ".env.local"));
    const warning = await doctor(root);
    expect(warning.exitCode).toBe(0);
    expect(warning.json.checks.find((c) => c.id === "env-files-ignored")?.status).toBe("warn");
  });

  test("warns when .env.local would not be ignored even though it does not exist yet", async () => {
    const root = await healthyRepo("node_modules/\n");
    const run = await doctor(root);
    expect(run.json.checks.find((c) => c.id === "env-files-ignored")).toMatchObject({ status: "warn" });
  });

  test("outside a git repository the git checks are skipped, not passed", async () => {
    fixture = await copyFixture("next-app-router");
    // The ceiling stops the search at the fixture, so a .git higher up on this machine cannot interfere.
    const checks = await runDoctor({ root: fixture.root, framework: nextFramework, gitSearchCeiling: fixture.root });
    expect(checks.find((c) => c.id === "env-files-ignored")).toMatchObject({
      status: "skip",
      message: "Not inside a git repository, so the git checks were skipped.",
    });
  });

  test("a .env.LOCAL file is treated as local (case-insensitive), so not ignoring it fails", async () => {
    const root = await healthyRepo("node_modules/\n");
    await writeFile(path.join(root, ".env.LOCAL"), "X=\n");
    const run = await doctor(root);
    expect(run.json.checks.find((c) => c.id === "env-files-ignored")?.status).toBe("fail");
  });

  test.skipIf(!hasGit)("a committed .env.local fails even when .gitignore lists it", async () => {
    fixture = await copyFixture("next-app-router");
    const root = fixture.root;
    execFileSync("git", ["-C", root, "init", "-q"]);
    await writeFile(path.join(root, ".gitignore"), ".env*.local\n");
    await writeFile(path.join(root, ".env.local"), `SECRET=${FAKE_SECRET}\n`);
    execFileSync("git", ["-C", root, "add", "-f", ".env.local"]);

    const run = await doctor(root);
    expect(run.exitCode).toBe(1);
    const check = run.json.checks.find((c) => c.id === "env-files-ignored");
    expect(check).toMatchObject({ status: "fail" });
    expect(check?.message).toContain(".env.local is tracked by git");
    expect(check?.suggestion).toContain("git rm --cached");
    expect(run.stdout).not.toContain(FAKE_SECRET);

    execFileSync("git", ["-C", root, "rm", "-q", "--cached", ".env.local"]);
    expect((await doctor(root)).json.checks.find((c) => c.id === "env-files-ignored")?.status).toBe("pass");
  });

  test("when the git index cannot be read, an ignored env file is a warning, not a pass", async () => {
    const root = await healthyRepo();
    await mkdir(path.join(root, ".git", "index")); // not a regular file
    await writeFile(path.join(root, ".env.local"), "X=\n");
    const check = (await doctor(root)).json.checks.find((c) => c.id === "env-files-ignored");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("was not checked");
  });

  test("a hostile .gitignore cannot crash or hang doctor", async () => {
    const root = await healthyRepo(`[z-a]\n${"*a".repeat(80)}*b\n.env*.local\n`);
    await writeFile(path.join(root, `.env.${"a".repeat(200)}`), "X=\n");
    const started = performance.now();
    const run = await doctor(root);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(run.stderr).toBe("");
    expect(run.json.checks.find((c) => c.id === "env-files-ignored")).toBeDefined();
  });

  test("missing config fails; missing .env.example warns", async () => {
    const root = await healthyRepo();
    await rm(path.join(root, "envsync.config.ts"));
    await rm(path.join(root, ".env.example"));
    const run = await doctor(root);
    expect(run.exitCode).toBe(1);
    expect(statuses(run.json)).toMatchObject({ config: "fail", "env-example": "warn" });
    expect(run.json.checks.find((c) => c.id === "config")?.suggestion).toContain("envsync init");
  });

  test("an invalid config fails and points to scan", async () => {
    const root = await healthyRepo();
    await writeFile(path.join(root, "envsync.config.ts"), "export default makeConfig();");
    const run = await doctor(root);
    expect(run.json.checks.find((c) => c.id === "config")).toMatchObject({ status: "fail", message: "envsync.config.ts has 1 problem." });
  });

  test("malformed .env.example lines are reported by line number only", async () => {
    const root = await healthyRepo();
    await writeFile(path.join(root, ".env.example"), `DATABASE_URL=\nthis is not valid ${FAKE_SECRET}\nAUTH_SECRET=\n`);
    const run = await doctor(root);
    expect(run.json.checks.find((c) => c.id === "env-example")).toMatchObject({ status: "warn" });
    expect(run.json.checks.find((c) => c.id === "env-example")?.message).toContain("(line 2)");
    expect(run.stdout).not.toContain(FAKE_SECRET);
  });

  test("package.json problems: invalid JSON fails, missing next warns, workspace root gets a monorepo hint", async () => {
    const root = await healthyRepo();
    await writeFile(path.join(root, "package.json"), "{ not json");
    expect(statuses((await doctor(root)).json)["package-json"]).toBe("fail");

    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "19.0.0" } }));
    expect(statuses((await doctor(root)).json).framework).toBe("warn");

    await writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
    const workspace = await doctor(root);
    expect(workspace.json.checks.find((c) => c.id === "framework")?.suggestion).toContain("apps/web");
  });

  test("never prints dependency version ranges, which can embed credentials", async () => {
    const root = await healthyRepo();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: `git+https://user:${FAKE_SECRET}@example.test/next.git` } }));
    const run = await doctor(root);
    expect(statuses(run.json).framework).toBe("pass");
    expect(run.stdout).not.toContain(FAKE_SECRET);
  });

  test("an old Node.js version fails the runtime check", async () => {
    const root = await healthyRepo();
    const run = await doctor(root, "20.11.1");
    expect(run.exitCode).toBe(1);
    expect(run.json.checks[0]).toMatchObject({ id: "node-version", status: "fail" });
  });

  test("a missing directory fails cleanly", async () => {
    const root = await healthyRepo();
    const run = await doctor(path.join(root, "does-not-exist"));
    expect(run.exitCode).toBe(1);
    expect(statuses(run.json)["source-files"]).toBe("fail");
  });
});
