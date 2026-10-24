import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyInitPlan, planInit, readRegularFile, type FrameworkAdapter } from "../src/index.js";

// Injects a write failure (as with a full disk) into file handles opened for one file name, and can
// run a hook after each `lstat` to simulate a swap in a check-then-open window. The hook returns
// true once it has acted, which disarms it.
const failure = vi.hoisted(() => ({
  fileName: "",
  afterLstat: undefined as undefined | ((file: string) => Promise<boolean>),
  /** Runs once, right before the injected write error is thrown. */
  onWriteFailure: undefined as undefined | (() => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const result = await actual.lstat(...args);
      const hook = failure.afterLstat;
      if (hook && (await hook(String(args[0])))) failure.afterLstat = undefined;
      return result;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (failure.fileName === "" || path.basename(String(args[0])) !== failure.fileName) return handle;
      let writes = 0;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "write") {
            return async (buffer: Buffer, offset: number, _length: number, position: number | null) => {
              // Write a few bytes first (where the product asked) so there is real partial data to clean up.
              if (writes++ === 0) return target.write(buffer, offset, Math.min(5, buffer.length - offset), position);
              const hook = failure.onWriteFailure;
              failure.onWriteFailure = undefined;
              await hook?.();
              throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const framework: FrameworkAdapter = {
  name: "Test",
  publicPrefix: "PUBLIC_",
  builtInVariables: [],
  externallyReadVariables: [],
  packageName: "test",
  frameworkConfigFiles: [],
  extractReferences: () => [{ kind: "static", name: "API_URL", line: 1, column: 1 }],
  extractClientExposedNames: () => [],
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "envsync-init-failures-"));
  await writeFile(path.join(root, "index.ts"), "");
  failure.fileName = "";
});
afterEach(async () => {
  failure.fileName = "";
  failure.afterLstat = undefined;
  failure.onWriteFailure = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("partial writes are cleaned up and reported accurately", () => {
  test("a failed create removes the incomplete file", async () => {
    const plan = await planInit({ root, framework });
    failure.fileName = "envsync.config.ts";

    const error = await applyInitPlan(root, plan).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "WRITE_FAILED" });
    expect((error as Error).message).toContain("The incomplete file was removed.");
    expect((error as Error).message).toContain("No files were changed.");
    expect(await readdir(root)).toEqual(["index.ts"]);
  });

  test("a file replaced between the check and the open is refused, even with identical content", async () => {
    await writeFile(path.join(root, ".env.example"), "OTHER=\n");
    await writeFile(path.join(root, "envsync.config.ts"), "export default { variables: { API_URL: {} } };");
    const plan = await planInit({ root, framework });
    const target = path.join(root, ".env.example");
    // lstat calls on .env.example during apply: (1) preflight link count, (2) preflight read,
    // (3) appendVerified's check right before it opens the file. Swap after the third.
    let calls = 0;
    failure.afterLstat = async (file) => {
      if (path.basename(file) !== ".env.example" || ++calls < 3) return false;
      // Same bytes, different file (new inode): only the identity check can tell.
      const { rename } = await import("node:fs/promises");
      await rename(target, path.join(root, "moved-away"));
      await writeFile(target, "OTHER=\n");
      return true;
    };

    const error = await applyInitPlan(root, plan).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "FILE_CHANGED" });
    expect((error as Error).message).toContain("was replaced while being checked");
    expect(await readFile(target, "utf8")).toBe("OTHER=\n");
  });

  test("cleanup after a failed create never deletes a file that replaced EnvSync's", async () => {
    const plan = await planInit({ root, framework });
    const target = path.join(root, "envsync.config.ts");
    failure.fileName = "envsync.config.ts";
    // Between the failed write and the cleanup, another process puts its own file at the path.
    failure.onWriteFailure = async () => {
      const { rename } = await import("node:fs/promises");
      await rename(target, path.join(root, "envsync-original"));
      await writeFile(target, "// someone else's file\n");
    };

    const error = await applyInitPlan(root, plan).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "WRITE_FAILED" });
    expect((error as Error).message).toContain("may remain; check it");
    expect(await readFile(target, "utf8")).toBe("// someone else's file\n");
  });

  test("reads refuse a file swapped between the check and the open", async () => {
    const target = path.join(root, ".env.example");
    await writeFile(target, "ORIGINAL=\n");
    failure.afterLstat = async () => {
      const { rename } = await import("node:fs/promises");
      await rename(target, path.join(root, "moved-away"));
      await writeFile(target, "SWAPPED=\n");
      return true;
    };
    expect(await readRegularFile(target)).toEqual({ ok: false, reason: "changed" });
    expect(await readRegularFile(target)).toEqual({ ok: true, text: "SWAPPED=\n" });
  });

  test("a failed append restores the original content and reports what was already written", async () => {
    await writeFile(path.join(root, ".env.example"), "OTHER=\n");
    const plan = await planInit({ root, framework });
    failure.fileName = ".env.example";

    const error = await applyInitPlan(root, plan).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "WRITE_FAILED" });
    expect((error as Error).message).toContain("Its original content was restored.");
    expect((error as Error).message).toContain("Already written: envsync.config.ts.");
    expect(await readFile(path.join(root, ".env.example"), "utf8")).toBe("OTHER=\n");
  });
});
