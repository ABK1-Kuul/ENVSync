import { afterEach, describe, expect, test } from "vitest";
import { copyFixture, runCli, type FixtureCopy } from "../../../tests/helpers.js";
import { exitCodeFor } from "../src/exit-codes.js";
import { VERSION } from "../src/main.js";

let fixture: FixtureCopy | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe("argument handling", () => {
  test("no command and --help print usage and exit 0", async () => {
    for (const args of [[], ["--help"], ["scan", "-h"]]) {
      const run = await runCli(args, process.cwd());
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("Usage:");
      expect(run.stdout).toContain("Exit codes:");
    }
  });

  test("--version prints the version", async () => {
    expect(await runCli(["--version"], process.cwd())).toEqual({ exitCode: 0, stdout: `${VERSION}\n`, stderr: "" });
  });

  test("VERSION and the minimum Node.js version match the published package.json", async () => {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      name: string;
      version: string;
      engines: { node: string };
    };
    const { MINIMUM_NODE_VERSION } = await import("../src/main.js");
    expect(manifest.name).toBe("envsync");
    expect(manifest.version).toBe(VERSION);
    expect(manifest.engines.node).toBe(`>=${MINIMUM_NODE_VERSION}`);
  });

  test.each([
    [["deploy"], "Unknown command `deploy`"],
    [["scan", "--write"], "`--write` is not an option of `scan`"],
    [["init", "--format", "json"], "`--format` is not an option of `init`"],
    [["doctor", "--strict"], "`--strict` is not an option of `doctor`"],
    [["scan", "--format", "xml"], "Unknown format `xml`"],
    [["scan", "--bogus"], "--bogus"],
    [["scan", "a", "b"], "at most one directory"],
  ])("%j is a usage error with exit code 2", async (args, message) => {
    const run = await runCli(args, process.cwd());
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(message);
  });

  test("a missing directory or missing config is exit code 2 with guidance on stderr", async () => {
    const missingDir = await runCli(["scan", "does-not-exist-envsync"], process.cwd());
    expect(missingDir.exitCode).toBe(2);
    expect(missingDir.stderr).toContain("does not exist");

    fixture = await copyFixture("next-app-router");
    const { rm } = await import("node:fs/promises");
    await rm(`${fixture.root}/envsync.config.ts`);
    const missingConfig = await runCli(["scan"], fixture.root);
    expect(missingConfig.exitCode).toBe(2);
    expect(missingConfig.stderr).toContain("No envsync.config.ts found");
  });
});

describe("exit codes", () => {
  test.each([
    [{ errors: 0, warnings: 0, infos: 3 }, false, 0],
    [{ errors: 0, warnings: 2, infos: 0 }, false, 0],
    [{ errors: 0, warnings: 2, infos: 0 }, true, 1],
    [{ errors: 1, warnings: 0, infos: 0 }, false, 1],
    [{ errors: 1, warnings: 0, infos: 0 }, true, 1],
    [{ errors: 0, warnings: 0, infos: 5 }, true, 0],
  ])("%j strict=%s -> %i", (counts, strict, expected) => {
    expect(exitCodeFor(counts, strict)).toBe(expected);
  });
});

describe("formatters", () => {
  test("terminal output for a clean project", async () => {
    fixture = await copyFixture("next-app-router");
    const run = await runCli(["scan"], fixture.root);
    expect(run).toEqual({ exitCode: 0, stdout: "No issues found in 4 files.\n", stderr: "" });
  });

  test("terminal and JSON report the same codes, severities and locations", async () => {
    fixture = await copyFixture("next-pages-router");
    const terminal = await runCli(["scan"], fixture.root);
    const json = await runCli(["scan", "--format", "json"], fixture.root);
    const parsed = JSON.parse(json.stdout) as {
      schemaVersion: number;
      summary: { errors: number; warnings: number; infos: number; exitCode: number; strict: boolean };
      diagnostics: { code: string; severity: string; file?: string; line?: number; column?: number }[];
    };

    expect(parsed.schemaVersion).toBe(1);
    expect(terminal.exitCode).toBe(json.exitCode);
    expect(parsed.summary.exitCode).toBe(json.exitCode);

    const terminalHeadlines = terminal.stdout.split("\n").filter((line) => /^ENV\d{3} /.test(line));
    const jsonHeadlines = parsed.diagnostics.map(
      (d) => `${d.code} ${d.severity}${d.file ? ` ${d.file}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ""}` : ""}` : ""}`,
    );
    expect(terminalHeadlines.map((line) => line.split(" - ")[0])).toEqual(jsonHeadlines);
    const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
    expect(terminal.stdout).toContain(
      `Found ${plural(parsed.summary.errors, "error")}, ${plural(parsed.summary.warnings, "warning")} and ${parsed.summary.infos} info in`,
    );
  });

  test("--strict turns a warnings-only result into exit code 1 in both formats", async () => {
    fixture = await copyFixture("next-app-router");
    const { appendFile } = await import("node:fs/promises");
    // A duplicate example entry is a warning (ENV007) and nothing else changes.
    await appendFile(`${fixture.root}/.env.example`, "AUTH_SECRET=\n");

    const relaxed = await runCli(["scan", "--format", "json"], fixture.root);
    expect(relaxed.exitCode).toBe(0);
    expect(JSON.parse(relaxed.stdout).summary).toMatchObject({ errors: 0, warnings: 1, strict: false, exitCode: 0 });

    const strictJson = await runCli(["scan", "--format", "json", "--strict"], fixture.root);
    expect(strictJson.exitCode).toBe(1);
    expect(JSON.parse(strictJson.stdout).summary).toMatchObject({ strict: true, exitCode: 1 });

    const strictTerminal = await runCli(["scan", "--strict"], fixture.root);
    expect(strictTerminal.exitCode).toBe(1);
    expect(strictTerminal.stdout).toContain("Strict mode: warnings cause a non-zero exit code.");
  });

  test("scan accepts a directory argument relative to the working directory", async () => {
    fixture = await copyFixture("next-app-router");
    const { dirname, basename } = await import("node:path");
    const run = await runCli(["scan", basename(fixture.root)], dirname(fixture.root));
    expect(run.exitCode).toBe(0);
  });
});
