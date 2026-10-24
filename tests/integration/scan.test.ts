import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { scanProject } from "@envsync-internal/core";
import { nextFramework } from "@envsync-internal/parser-next";
import { afterEach, describe, expect, test } from "vitest";
import { copyFixture, type FixtureCopy } from "../helpers.js";

let fixture: FixtureCopy | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

const scan = (root: string) => scanProject({ root, framework: nextFramework });

describe("fixture: next-app-router (healthy)", () => {
  test("produces no diagnostics", async () => {
    fixture = await copyFixture("next-app-router");
    const result = await scan(fixture.root);
    expect(result).toEqual({ diagnostics: [], filesScanned: 4, skipped: [], complete: true });
  });

  test("ignores references in excluded directories and generated files", async () => {
    fixture = await copyFixture("next-app-router");
    for (const dir of ["node_modules/some-lib", ".next/server", "dist", "build", "coverage"]) {
      await mkdir(path.join(fixture.root, dir), { recursive: true });
      await writeFile(path.join(fixture.root, dir, "index.js"), "module.exports = process.env.SHOULD_NOT_BE_SCANNED;");
    }
    await writeFile(path.join(fixture.root, "types.d.ts"), "declare const x: typeof process.env.ALSO_NOT_SCANNED;");

    const result = await scan(fixture.root);
    expect(result.diagnostics).toEqual([]);
    expect(result.filesScanned).toBe(4);
  });
});

describe("dynamic access is always visible (Option B: reported, not a strict failure)", () => {
  test("terminal and JSON report the ENV006 count; --strict still passes on it alone", async () => {
    fixture = await copyFixture("next-app-router");
    await writeFile(path.join(fixture.root, "lib", "dynamic.ts"), "export const read = (key: string) => process.env[key];\n");
    const { runCli } = await import("../helpers.js");

    const terminal = await runCli(["scan", "--strict"], fixture.root);
    expect(terminal.exitCode).toBe(0);
    expect(terminal.stdout).toContain("Dynamic process.env access in 1 place (ENV006): variables read there were not checked.");

    const json = await runCli(["scan", "--format", "json", "--strict"], fixture.root);
    expect(JSON.parse(json.stdout).summary).toMatchObject({ dynamicAccesses: 1, complete: true, exitCode: 0 });
  });
});

describe("incomplete scans", () => {
  test("a stop at a resource limit says 'at least', not an exact count", async () => {
    const { formatTerminal } = await import("../../apps/cli/src/formatters/terminal.js");
    const output = formatTerminal(
      { diagnostics: [], filesScanned: 3, skipped: [{ path: "z.ts", reason: "limit-reached" }], complete: false },
      { errors: 0, warnings: 0, infos: 0 },
      false,
      0,
    );
    expect(output).toContain("scanning stopped at a limit, so at least 1 path (listed above) and possibly many more were not scanned");
  });

  test("a skipped path makes the scan incomplete in every format, and --strict fails on it", async () => {
    fixture = await copyFixture("next-app-router");
    await writeFile(path.join(fixture.root, "lib", "huge.ts"), `${"//".padEnd(1_100_000, "x")}\n`);
    const { runCli } = await import("../helpers.js");

    const terminal = await runCli(["scan"], fixture.root);
    expect(terminal.exitCode).toBe(0);
    expect(terminal.stdout).toContain("No issues found in 4 files.");
    expect(terminal.stdout).toContain("Scan incomplete: 1 path not scanned (listed above), so findings may be missing.");

    const json = await runCli(["scan", "--format", "json", "--strict"], fixture.root);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout).summary).toMatchObject({ complete: false, errors: 0, warnings: 0, strict: true, exitCode: 1 });

    const strict = await runCli(["scan", "--strict"], fixture.root);
    expect(strict.exitCode).toBe(1);
    expect(strict.stdout).toContain("Strict mode: an incomplete scan causes a non-zero exit code.");

    const init = await runCli(["init"], fixture.root);
    expect(init.stdout).toContain("1 path was not scanned");
  });
});

describe("fixture: next-pages-router (drift)", () => {
  test("reports each expected diagnostic at its location", async () => {
    fixture = await copyFixture("next-pages-router");
    const result = await scan(fixture.root);

    expect(result.diagnostics.map(({ code, severity, file, line, column, variableName }) => ({ code, severity, file, line, column, variableName }))).toEqual([
      { code: "ENV007", severity: "warning", file: ".env.example", line: 3, column: undefined, variableName: "NEXT_PUBLIC_API_URL" },
      { code: "ENV002", severity: "error", file: "envsync.config.ts", line: 4, column: 5, variableName: "STRIPE_KEY" },
      { code: "ENV005", severity: "error", file: "envsync.config.ts", line: 5, column: 5, variableName: "NEXT_PUBLIC_ADMIN_SECRET" },
      // Info, not warning: the fixture has dynamic access, so "unused" cannot be certain.
      { code: "ENV003", severity: "info", file: "envsync.config.ts", line: 6, column: 5, variableName: "UNUSED_FLAG" },
      { code: "ENV005", severity: "error", file: "next.config.js", line: 3, column: 5, variableName: "STRIPE_KEY" },
      { code: "ENV006", severity: "info", file: "pages/api/data.ts", line: 3, column: 17, variableName: undefined },
      { code: "ENV001", severity: "error", file: "pages/api/data.ts", line: 5, column: 17, variableName: "MISSING_IN_CONFIG" },
    ]);
    expect(result.filesScanned).toBe(3);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.message.length).toBeGreaterThan(0);
      expect(diagnostic.suggestion?.length).toBeGreaterThan(0);
    }
  });
});

describe("fixture: broken-config", () => {
  test("reports unsupported config syntax as ENV004/ENV007 without crashing", async () => {
    fixture = await copyFixture("broken-config");
    const result = await scan(fixture.root);
    const configFindings = result.diagnostics
      .filter((d) => d.code === "ENV004" || d.code === "ENV007")
      .map(({ code, line, variableName }) => ({ code, line, variableName }));

    expect(configFindings).toEqual([
      // The top-level writeFileSync call is reported (it would run at import time; EnvSync never runs it).
      { code: "ENV004", line: 4, variableName: undefined },
      { code: "ENV004", line: 9, variableName: undefined },
      { code: "ENV004", line: 10, variableName: "lower-case" },
      { code: "ENV007", line: 12, variableName: "DUPLICATE" },
      { code: "ENV004", line: 13, variableName: "BAD_TYPE" },
      { code: "ENV004", line: 14, variableName: "COMPUTED" },
    ]);
    // Variables with invalid fields are still declared, so they are not also reported as undeclared.
    expect(result.diagnostics.filter((d) => d.code === "ENV001")).toEqual([]);
    // No .env.example: each required variable gets ENV002.
    expect(result.diagnostics.filter((d) => d.code === "ENV002").map((d) => d.variableName)).toEqual(["DUPLICATE", "BAD_TYPE", "COMPUTED"]);
  });

  test("a config with a syntax error yields a single ENV004 and the scan still completes", async () => {
    fixture = await copyFixture("next-app-router");
    await writeFile(path.join(fixture.root, "envsync.config.ts"), "export default { variables: { A: {");
    const result = await scan(fixture.root);
    const env004 = result.diagnostics.filter((d) => d.code === "ENV004");
    expect(env004).toHaveLength(1);
    expect(env004[0]?.message).toContain("syntax error");
  });
});
