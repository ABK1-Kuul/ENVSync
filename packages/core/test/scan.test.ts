import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scanProject, ScanError, type FrameworkAdapter } from "../src/index.js";

const parserControl = vi.hoisted(() => ({ throwOnParse: false }));

vi.mock("@envsync/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@envsync/schema")>();
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

  test("the config file itself is not scanned as source", async () => {
    await writeFile(path.join(root, "envsync.config.ts"), "THROW");
    const result = await scanProject({ root, framework });
    expect(result.skipped).toEqual([]);
    expect(result.filesScanned).toBe(0);
  });
});
