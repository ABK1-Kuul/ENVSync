import { access, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { copyFixture, FAKE_SECRET, runCli, type FixtureCopy } from "../helpers.js";

// Records every path whose contents are opened or read, to prove env files are never touched.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) };
});

let fixture: FixtureCopy | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

const EXECUTION_MARKER = "ENVSYNC_CONFIG_WAS_EXECUTED";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function scanBothFormats(root: string) {
  return [await runCli(["scan"], root), await runCli(["scan", "--format", "json"], root), await runCli(["scan", "--strict"], root)];
}

describe("env files are never opened", () => {
  test("scan and init (preview and --write) never open or read .env/.env.* other than .env.example", async () => {
    fixture = await copyFixture("next-pages-router");
    for (const name of [".env", ".env.local", ".env.production", ".env.development.local"]) {
      await writeFile(path.join(fixture.root, name), `SECRET=${FAKE_SECRET}\n`);
    }
    vi.mocked(readFile).mockClear();
    vi.mocked(open).mockClear();

    await runCli(["scan"], fixture.root);
    await runCli(["scan", "--format", "json"], fixture.root);
    await runCli(["init"], fixture.root);
    await runCli(["init", "--write"], fixture.root);

    const touched = [...vi.mocked(readFile).mock.calls, ...vi.mocked(open).mock.calls].map((call) => path.basename(String(call[0])));
    expect(touched.length).toBeGreaterThan(0); // the instrumentation is live
    expect(touched.filter((name) => /^\.env(?!\.example$)/i.test(name))).toEqual([]);
  });
});

describe("secret values never appear in output", () => {
  test("values in real env files are never read or printed", async () => {
    fixture = await copyFixture("next-pages-router");
    const line = `STRIPE_KEY=sk_test_${FAKE_SECRET}\nMISSING_IN_CONFIG=${FAKE_SECRET}\n`;
    for (const name of [".env", ".env.local", ".env.development.local", ".env.production"]) {
      await writeFile(path.join(fixture.root, name), line);
    }
    await mkdir(path.join(fixture.root, "pages", "nested"), { recursive: true });
    await writeFile(path.join(fixture.root, "pages", "nested", ".env.local"), line);

    for (const run of await scanBothFormats(fixture.root)) {
      expect(run.stdout + run.stderr).not.toContain(FAKE_SECRET);
      expect(run.stdout).toContain("MISSING_IN_CONFIG");
    }
  });

  test("values in .env.example (even if a real secret was pasted there) are never printed", async () => {
    fixture = await copyFixture("next-pages-router");
    await writeFile(
      path.join(fixture.root, ".env.example"),
      `NEXT_PUBLIC_API_URL=${FAKE_SECRET}\nNEXT_PUBLIC_ADMIN_SECRET="${FAKE_SECRET}"\nNEXT_PUBLIC_API_URL=${FAKE_SECRET}\nnot a valid line ${FAKE_SECRET}\n`,
    );
    for (const run of await scanBothFormats(fixture.root)) {
      expect(run.stdout + run.stderr).not.toContain(FAKE_SECRET);
    }
  });

  test("the ENV005 heuristic warning reports the name only, never the value", async () => {
    fixture = await copyFixture("next-app-router");
    await writeFile(path.join(fixture.root, "lib", "analytics.ts"), "export const t = process.env.NEXT_PUBLIC_ANALYTICS_TOKEN;");
    for (const name of [".env", ".env.local"]) {
      await writeFile(path.join(fixture.root, name), `NEXT_PUBLIC_ANALYTICS_TOKEN=${FAKE_SECRET}\n`);
    }
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path.join(fixture.root, ".env.example"), `NEXT_PUBLIC_ANALYTICS_TOKEN=${FAKE_SECRET}\n`);

    const json = await runCli(["scan", "--format", "json"], fixture.root);
    const warning = (JSON.parse(json.stdout) as { diagnostics: { code: string; severity: string; variableName?: string }[] }).diagnostics.find(
      (d) => d.code === "ENV005",
    );
    expect(warning).toMatchObject({ severity: "warning", variableName: "NEXT_PUBLIC_ANALYTICS_TOKEN" });
    for (const run of [json, ...(await scanBothFormats(fixture.root))]) {
      expect(run.stdout + run.stderr).not.toContain(FAKE_SECRET);
    }
  });

  test("literal values in source code and config are never printed", async () => {
    fixture = await copyFixture("next-pages-router");
    await writeFile(path.join(fixture.root, "pages", "fallback.ts"), `export const k = process.env.MISSING_IN_CONFIG ?? "${FAKE_SECRET}";`);
    await writeFile(
      path.join(fixture.root, "envsync.config.ts"),
      `export default { variables: { STRIPE_KEY: { type: "${FAKE_SECRET}", description: "${FAKE_SECRET}", secret: true } } };`,
    );
    for (const run of await scanBothFormats(fixture.root)) {
      expect(run.stdout + run.stderr).not.toContain(FAKE_SECRET);
    }
  });
});

describe("repository-controlled text cannot manipulate the terminal", () => {
  test("control characters and bidi overrides in names are escaped in both formats", async () => {
    fixture = await copyFixture("next-app-router");
    const hostileName = "\u001b[2J\u001b[31mEVIL\u009b\u202eNAME\u007f";
    await writeFile(path.join(fixture.root, "lib", "hostile.ts"), `export const x = process.env[${JSON.stringify(hostileName)}];`);

    const terminal = await runCli(["scan"], fixture.root);
    const json = await runCli(["scan", "--format", "json"], fixture.root);

    for (const output of [terminal.stdout, json.stdout]) {
      expect(output).not.toMatch(/[\u001b\u007f-\u009f\u202e]/);
      expect(output).toContain("EVIL");
    }
    expect(terminal.stdout).toContain("\\u001b[2J");
    const parsed = JSON.parse(json.stdout) as { diagnostics: { code: string; variableName?: string }[] };
    expect(parsed.diagnostics.find((d) => d.code === "ENV001")?.variableName).toBe(hostileName);
  });

  test("invisible, zero-width and tag characters are escaped and JSON stays exact", async () => {
    fixture = await copyFixture("next-app-router");
    const hidden = [0x061c, 0x00ad, 0x200b, 0x200d, 0x2060, 0xfeff, 0xe0041].map((code) => String.fromCodePoint(code)).join("");
    const hostileName = `A${hidden}B`;
    await writeFile(path.join(fixture.root, "lib", "hidden.ts"), `export const x = process.env[${JSON.stringify(hostileName)}];`);

    const terminal = await runCli(["scan"], fixture.root);
    const json = await runCli(["scan", "--format", "json"], fixture.root);
    for (const output of [terminal.stdout, json.stdout]) {
      for (const char of hidden) expect(output.includes(char)).toBe(false);
    }
    expect(terminal.stdout).toContain("\\u061c\\u00ad\\u200b\\u200d\\u2060\\ufeff\\udb40\\udc41");
    const parsed = JSON.parse(json.stdout) as { diagnostics: { code: string; variableName?: string }[] };
    expect(parsed.diagnostics.find((d) => d.code === "ENV001")?.variableName).toBe(hostileName);
  });

  test("a newline inside a name cannot forge an extra output line", async () => {
    fixture = await copyFixture("next-app-router");
    const forged = "X\nENV000 error app/page.tsx:1:1 - forged line\nNo issues found in 4 files.";
    await writeFile(path.join(fixture.root, "lib", "forge.ts"), `export const x = process.env[${JSON.stringify(forged)}];`);

    const terminal = await runCli(["scan"], fixture.root);
    const lines = terminal.stdout.split("\n");
    expect(lines.some((line) => line.startsWith("ENV000"))).toBe(false);
    expect(lines.filter((line) => line.startsWith("No issues found"))).toEqual([]);
    expect(terminal.stdout).toContain("X\\u000aENV000");
  });

  test("stderr is sanitized too (paths and arguments come from outside EnvSync)", async () => {
    const escape = String.fromCharCode(27);
    const run = await runCli(["scan", `missing-dir${escape}[2J`], process.cwd());
    expect(run.exitCode).toBe(2);
    expect(run.stderr.includes(escape)).toBe(false);
    expect(run.stderr).toContain("\\u001b[2J");

    const usage = await runCli(["scan", `--format=x${escape}y`], process.cwd());
    expect(usage.stderr.includes(escape)).toBe(false);
  });

  test("a config syntax error is reported by code only, never with quoted source text", async () => {
    fixture = await copyFixture("next-app-router");
    // TS1532 would normally quote the group name from the regular expression.
    await writeFile(
      path.join(fixture.root, "envsync.config.ts"),
      `const r = /(?<a>x)\\k<${FAKE_SECRET}>/;\nexport default { variables: { A: { required: 0777 } } };\n`,
    );
    const json = await runCli(["scan", "--format", "json"], fixture.root);
    const terminal = await runCli(["scan"], fixture.root);
    const diagnostics = (JSON.parse(json.stdout) as { diagnostics: { code: string; message: string }[] }).diagnostics;
    const syntax = diagnostics.find((d) => d.code === "ENV004");
    expect(syntax?.message).toMatch(/^envsync\.config\.ts has a syntax error \(TS\d+\)\.$/);
    expect(json.stdout + terminal.stdout).not.toContain(FAKE_SECRET);
  });
});

describe("project code is never executed", () => {
  test("a config with top-level side effects is parsed, not run", async () => {
    fixture = await copyFixture("broken-config");
    const runs = await scanBothFormats(fixture.root);

    expect(runs.map((run) => run.exitCode)).toEqual([1, 1, 1]);
    expect(await exists(path.join(fixture.root, EXECUTION_MARKER))).toBe(false);
    expect(await exists(path.join(process.cwd(), EXECUTION_MARKER))).toBe(false);
  });

  test("a config whose default export is an IIFE is rejected, not evaluated", async () => {
    fixture = await copyFixture("next-app-router");
    const marker = path.join(fixture.root, EXECUTION_MARKER).replaceAll("\\", "/");
    await writeFile(
      path.join(fixture.root, "envsync.config.ts"),
      `import { writeFileSync } from "node:fs";
export default (() => { writeFileSync("${marker}", "ran"); return { variables: {} }; })();`,
    );
    const run = await runCli(["scan", "--format", "json"], fixture.root);
    const diagnostics = (JSON.parse(run.stdout) as { diagnostics: { code: string }[] }).diagnostics;

    expect(diagnostics.some((d) => d.code === "ENV004")).toBe(true);
    expect(await exists(marker)).toBe(false);
  });

  test("source files and next.config with side effects are parsed, not run", async () => {
    fixture = await copyFixture("next-app-router");
    const marker = path.join(fixture.root, EXECUTION_MARKER).replaceAll("\\", "/");
    const sideEffect = `require("node:fs").writeFileSync("${marker}", "ran");\n`;
    await writeFile(path.join(fixture.root, "next.config.mjs"), `${sideEffect}export default {};`);
    await writeFile(path.join(fixture.root, "lib", "side-effect.js"), sideEffect);

    await scanBothFormats(fixture.root);
    expect(await exists(marker)).toBe(false);
  });
});

describe("filesystem boundaries", () => {
  test("a symlinked .env.example is refused instead of followed", async (context) => {
    fixture = await copyFixture("next-app-router");
    const outside = path.join(path.dirname(fixture.root), "outside.env");
    await writeFile(outside, `DATABASE_URL=${FAKE_SECRET}\n`);
    await rm(path.join(fixture.root, ".env.example"));
    try {
      await symlink(outside, path.join(fixture.root, ".env.example"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip("file symlinks are not permitted for this user on this platform");
      throw error;
    }

    const run = await runCli(["scan"], fixture.root);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("symbolic links are not followed");
    expect(run.stdout + run.stderr).not.toContain(FAKE_SECRET);
  });

  test("a directory link to outside the project is not scanned and is disclosed", async () => {
    fixture = await copyFixture("next-app-router");
    const outside = path.join(path.dirname(fixture.root), "outside-src");
    await mkdir(outside);
    await writeFile(path.join(outside, "leak.ts"), "export const x = process.env.OUTSIDE_PROJECT;");
    await symlink(outside, path.join(fixture.root, "linked"), process.platform === "win32" ? "junction" : "dir");

    const run = await runCli(["scan", "--format", "json"], fixture.root);
    const output = JSON.parse(run.stdout) as { diagnostics: unknown[]; skipped: unknown[] };
    expect(run.exitCode).toBe(0);
    expect(output.diagnostics).toEqual([]);
    expect(output.skipped).toEqual([{ path: "linked", reason: "symlink" }]);
  });

  test("oversized source files are skipped and disclosed rather than parsed", async () => {
    fixture = await copyFixture("next-app-router");
    await writeFile(path.join(fixture.root, "lib", "huge.ts"), `export const a = process.env.HUGE_FILE_REF;\n${"//".padEnd(1_100_000, "x")}\n`);

    const run = await runCli(["scan", "--format", "json"], fixture.root);
    const output = JSON.parse(run.stdout) as { diagnostics: unknown[]; skipped: unknown[] };
    expect(output.diagnostics).toEqual([]);
    expect(output.skipped).toEqual([{ path: "lib/huge.ts", reason: "too-large" }]);
  });
});
