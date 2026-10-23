import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scanProject, ScanError, type FrameworkAdapter } from "../src/index.js";
import { collectSourceEvidence } from "../src/project-files.js";

const parserControl = vi.hoisted(() => ({ throwOnParse: false }));

vi.mock("@envsync-internal/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@envsync-internal/schema")>();
  return {
    ...actual,
    parseConfigSource: (...args: Parameters<typeof actual.parseConfigSource>) => {
      if (parserControl.throwOnParse) throw new RangeError("Maximum call stack size exceeded");
      return actual.parseConfigSource(...args);
    },
  };
});

const framework: FrameworkAdapter = {
  name: "Test",
  publicPrefix: "PUBLIC_",
  builtInVariables: [],
  externallyReadVariables: [],
  packageName: "test-framework",
  frameworkConfigFiles: [],
  extractReferences: (text) => (text.includes("THROW") ? (() => { throw new RangeError("boom"); })() : []),
  extractClientExposedNames: () => [],
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "envsync-scan-"));
  parserControl.throwOnParse = false;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scanProject", () => {
  test("throws CONFIG_NOT_FOUND when the config is absent", async () => {
    await expect(scanProject({ root, framework })).rejects.toMatchObject({ name: "ScanError", code: "CONFIG_NOT_FOUND" });
  });

  test("a config directory instead of a file is refused", async () => {
    await mkdir(path.join(root, "envsync.config.ts"));
    const error = await scanProject({ root, framework }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScanError);
    expect(error).toMatchObject({ code: "UNSAFE_PATH" });
  });

  test("a parser crash on the config becomes ENV004, not an unhandled error", async () => {
    await writeFile(path.join(root, "envsync.config.ts"), "export default { variables: {} };");
    parserControl.throwOnParse = true;

    const result = await scanProject({ root, framework });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "ENV004", severity: "error", message: "envsync.config.ts could not be parsed." }),
    ]);
  });

  test("a parser crash on a source file skips that file and discloses it", async () => {
    await writeFile(path.join(root, "envsync.config.ts"), "export default { variables: {} };");
    await writeFile(path.join(root, "ok.ts"), "");
    await writeFile(path.join(root, "bad.ts"), "THROW");

    const result = await scanProject({ root, framework });
    expect(result.filesScanned).toBe(1);
    expect(result.skipped).toEqual([{ path: "bad.ts", reason: "parse-failed" }]);
  });

  test("file-count and total-size limits stop the scan and are disclosed once", async () => {
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) await writeFile(path.join(root, name), "x".repeat(10));
    const byCount = await collectSourceEvidence(root, framework, { maxFiles: 2, maxTotalBytes: 1_000 });
    expect(byCount.filesScanned).toBe(2);
    expect(byCount.skipped).toEqual([{ path: "c.ts", reason: "limit-reached" }]);

    const bySize = await collectSourceEvidence(root, framework, { maxFiles: 100, maxTotalBytes: 15 });
    expect(bySize.filesScanned).toBe(2);
    expect(bySize.skipped).toEqual([{ path: "c.ts", reason: "limit-reached" }]);
  });

  test("the config file itself is not scanned as source", async () => {
    await writeFile(path.join(root, "envsync.config.ts"), "THROW");
    const result = await scanProject({ root, framework });
    expect(result.skipped).toEqual([]);
    expect(result.filesScanned).toBe(0);
  });
});
