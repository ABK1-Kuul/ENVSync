import { createHash } from "node:crypto";
import { readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyInitPlan, InitError, planInit } from "@envsync-internal/core";
import { nextFramework } from "@envsync-internal/parser-next";
import { afterEach, describe, expect, test } from "vitest";
import { copyFixture, FAKE_SECRET, runCli, type FixtureCopy } from "../helpers.js";

let fixture: FixtureCopy | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

const CONFIG = "envsync.config.ts";
const EXAMPLE = ".env.example";

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const result: Record<string, string> = {};
  for (const entry of entries.filter((e) => e.isFile())) {
    const full = path.join(entry.parentPath, entry.name);
    result[path.relative(root, full)] = createHash("sha256").update(await readFile(full)).digest("hex");
  }
  return result;
}

/** A fixture with source files only: no config and no .env.example. */
async function bareProject(): Promise<string> {
  fixture = await copyFixture("next-app-router");
  await rm(path.join(fixture.root, CONFIG));
  await rm(path.join(fixture.root, EXAMPLE));
  return fixture.root;
}

describe("envsync init: preview", () => {
  test("previews both files and writes nothing", async () => {
    const root = await bareProject();
    const before = await snapshot(root);

    const run = await runCli(["init"], root);

    expect(run.exitCode).toBe(0);
    expect(await snapshot(root)).toEqual(before);
    expect(run.stdout).toContain("EnvSync init preview (no files were written)");
    expect(run.stdout).toContain(`Create ${CONFIG}:`);
    expect(run.stdout).toContain(`Create ${EXAMPLE}:`);
    expect(run.stdout).toContain("Run `envsync init --write` to apply these changes.");
  });

  test("declares statically referenced names, sorted, excluding framework built-ins", async () => {
    const plan = await planInit({ root: await bareProject(), framework: nextFramework });
    expect(plan.configVariables).toEqual(["AUTH_SECRET", "DATABASE_URL", "LOG_LEVEL", "NEXT_PUBLIC_SITE_URL"]);
    expect(plan.exampleAdditions).toEqual(plan.configVariables);
    expect(plan.dynamicAccessCount).toBe(0);
  });

  test("reports dynamic access and invalid names it could not turn into declarations", async () => {
    const root = await bareProject();
    await writeFile(path.join(root, "lib", "dynamic.ts"), 'export const a = process.env[key]; export const b = process.env["not-valid"];');
    const run = await runCli(["init"], root);
    expect(run.stdout).toContain("1 dynamic process.env access could not be resolved");
    expect(run.stdout).toContain("1 referenced name(s) are not valid variable names");
    expect(run.stdout).not.toContain("not-valid=");
  });
});

describe("envsync init --write", () => {
  test("creates both files, and the result passes `envsync scan`", async () => {
    const root = await bareProject();
    const run = await runCli(["init", "--write"], root);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`Wrote ${CONFIG}, ${EXAMPLE}.`);

    const scan = await runCli(["scan", "--strict"], root);
    expect(scan).toMatchObject({ exitCode: 0, stdout: "No issues found in 4 files.\n" });
  });

  test("running again changes nothing (idempotent)", async () => {
    const root = await bareProject();
    await runCli(["init", "--write"], root);
    const before = await snapshot(root);

    const again = await runCli(["init", "--write"], root);
    expect(again.stdout).toContain(`Unchanged ${CONFIG}`);
    expect(again.stdout).toContain(`Unchanged ${EXAMPLE}: already lists every declared variable.`);
    expect(again.stdout).toContain("Nothing to change.");
    expect(await snapshot(root)).toEqual(before);
  });

  test("never modifies an existing config; appends only missing placeholders to .env.example", async () => {
    fixture = await copyFixture("next-pages-router");
    const root = fixture.root;
    const configBefore = await readFile(path.join(root, CONFIG), "utf8");
    const exampleBefore = await readFile(path.join(root, EXAMPLE), "utf8");

    const run = await runCli(["init", "--write"], root);

    expect(run.exitCode).toBe(0);
    expect(await readFile(path.join(root, CONFIG), "utf8")).toBe(configBefore);
    const exampleAfter = await readFile(path.join(root, EXAMPLE), "utf8");
    expect(exampleAfter.startsWith(exampleBefore)).toBe(true);
    expect(exampleAfter.slice(exampleBefore.length)).toBe("# Added by `envsync init`\nSTRIPE_KEY=\nUNUSED_FLAG=\n");
  });

  test("preserves CRLF line endings when appending", async () => {
    fixture = await copyFixture("next-app-router");
    await writeFile(path.join(fixture.root, EXAMPLE), "DATABASE_URL=\r\nAUTH_SECRET=");
    await runCli(["init", "--write"], fixture.root);
    expect(await readFile(path.join(fixture.root, EXAMPLE), "utf8")).toBe(
      "DATABASE_URL=\r\nAUTH_SECRET=\r\n# Added by `envsync init`\r\nNEXT_PUBLIC_SITE_URL=\r\nLOG_LEVEL=\r\n",
    );
  });

  test("refuses to overwrite a config created after the preview", async () => {
    const root = await bareProject();
    const plan = await planInit({ root, framework: nextFramework });
    await writeFile(path.join(root, CONFIG), "// written by someone else\n");

    const error = await applyInitPlan(root, plan).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InitError);
    expect(error).toMatchObject({ code: "FILE_CHANGED" });
    expect((error as Error).message).toContain("No files were changed.");
    expect(await readFile(path.join(root, CONFIG), "utf8")).toBe("// written by someone else\n");
  });

  test("refuses to append when .env.example changed after the preview", async () => {
    fixture = await copyFixture("next-pages-router");
    const root = fixture.root;
    const plan = await planInit({ root, framework: nextFramework });
    await writeFile(path.join(root, EXAMPLE), "EDITED_MEANWHILE=\n");

    const run = await applyInitPlan(root, plan).catch((caught: unknown) => caught);
    expect(run).toMatchObject({ code: "FILE_CHANGED" });
    expect(await readFile(path.join(root, EXAMPLE), "utf8")).toBe("EDITED_MEANWHILE=\n");
  });

  test("refuses a symlinked .env.example (exit 2) and writes nothing", async (context) => {
    const root = await bareProject();
    const outside = path.join(path.dirname(root), "outside.env");
    await writeFile(outside, "OUTSIDE=\n");
    try {
      await symlink(outside, path.join(root, EXAMPLE), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip("file symlinks are not permitted for this user on this platform");
      throw error;
    }
    const before = await snapshot(root);

    const run = await runCli(["init", "--write"], root);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("symbolic links are not followed");
    expect(await snapshot(root)).toEqual(before);
    expect(await readFile(outside, "utf8")).toBe("OUTSIDE=\n");
  });
});

describe("envsync init never copies values", () => {
  test("values in real env files and in an existing .env.example never reach output or generated files", async () => {
    fixture = await copyFixture("next-app-router");
    const root = fixture.root;
    await rm(path.join(root, CONFIG));
    for (const name of [".env", ".env.local", ".env.development.local"]) {
      await writeFile(path.join(root, name), `DATABASE_URL=postgres://u:${FAKE_SECRET}@db/app\nAUTH_SECRET=${FAKE_SECRET}\n`);
    }
    await writeFile(path.join(root, EXAMPLE), `DATABASE_URL=${FAKE_SECRET}\n`);

    const preview = await runCli(["init"], root);
    const write = await runCli(["init", "--write"], root);

    for (const run of [preview, write]) expect(run.stdout + run.stderr).not.toContain(FAKE_SECRET);
    expect(await readFile(path.join(root, CONFIG), "utf8")).not.toContain(FAKE_SECRET);
    const example = await readFile(path.join(root, EXAMPLE), "utf8");
    // The pre-existing line is the user's and is kept; nothing EnvSync appended contains a value.
    expect(example.split(FAKE_SECRET)).toHaveLength(2);
    expect(example.slice(`DATABASE_URL=${FAKE_SECRET}\n`.length)).toBe(
      "# Added by `envsync init`\nAUTH_SECRET=\nLOG_LEVEL=\nNEXT_PUBLIC_SITE_URL=\n",
    );
  });
});
