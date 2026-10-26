import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DiscoveryResult } from "../src/discovery.js";
import { runDoctor, type FrameworkAdapter } from "../src/index.js";

// Discovery is stubbed so the limit paths can be tested without creating 20,000+ files.
const discovery = vi.hoisted(() => ({ result: { files: [], envFiles: [], skipped: [] } as DiscoveryResult }));

vi.mock("../src/discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/discovery.js")>();
  return { ...actual, discoverSourceFiles: async () => discovery.result };
});

const framework: FrameworkAdapter = {
  name: "Test",
  publicPrefix: "PUBLIC_",
  builtInVariables: [],
  externallyReadVariables: [],
  packageName: "test",
  frameworkConfigFiles: [],
  extractReferences: () => [],
  extractClientExposedNames: () => [],
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "envsync-doctor-limits-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sourceFiles = async () => (await runDoctor({ root, framework, gitSearchCeiling: root })).find((check) => check.id === "source-files");

describe("doctor source-files and scan limits", () => {
  test("a discovery stop at the entry limit is unknown, not a pass", async () => {
    discovery.result = { files: ["a.ts"], envFiles: [], skipped: [{ path: "z.ts", reason: "limit-reached" }] };
    expect(await sourceFiles()).toMatchObject({ status: "unknown" });
  });

  test("more source files than the scan limit is unknown, not a pass", async () => {
    discovery.result = { files: Array.from({ length: 20_001 }, (_, i) => `f${i}.ts`), envFiles: [], skipped: [] };
    const check = await sourceFiles();
    expect(check).toMatchObject({ status: "unknown" });
    expect(check?.message).toContain("will stop early");
  });

  test("exactly at the limit passes", async () => {
    discovery.result = { files: Array.from({ length: 20_000 }, (_, i) => `f${i}.ts`), envFiles: [], skipped: [] };
    expect(await sourceFiles()).toMatchObject({ status: "pass" });
  });
});
