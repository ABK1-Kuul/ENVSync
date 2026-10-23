import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * The primary security boundary is structural: shipped code has no way to load or run project code
 * and no network access. Catching parser crashes is only defense in depth. This test fails if any
 * product source gains an API that could evaluate code, spawn processes or open connections.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRODUCT_SOURCE_DIRS = ["packages/core/src", "packages/schema/src", "packages/parser-next/src", "apps/cli/src"];

const FORBIDDEN: [string, RegExp][] = [
  ["eval", /\beval\s*\(/],
  ["Function constructor", /\bnew\s+Function\b|\bFunction\s*\(/],
  ["dynamic import", /\bimport\s*\(/],
  ["require", /\brequire\s*\(|\bcreateRequire\b/],
  ["vm / process / worker / network modules", /from\s+["'](?:node:)?(?:vm|child_process|cluster|worker_threads|http|https|http2|net|tls|dgram|dns|inspector)["']/],
  ["fetch / sockets", /\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b/],
  // Bare calls only: `regex.exec(...)` is legitimate, and `cp.exec(...)` is caught by the module rule above.
  ["process spawning", /(?<![.\w])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/],
  ["TypeScript program emit or module loading", /\bts\.(?:createProgram|createWatchProgram|sys\.require)\b/],
];

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("product source cannot execute project code or reach the network", async () => {
  const files = (await Promise.all(PRODUCT_SOURCE_DIRS.map((dir) => listSourceFiles(path.join(REPO_ROOT, dir))))).flat();

  test("finds the product source files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test.each(FORBIDDEN)("no %s", async (_label, pattern) => {
    const offenders: string[] = [];
    for (const file of files) {
      if (pattern.test(await readFile(file, "utf8"))) offenders.push(path.relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  test("the only TypeScript compiler entry points used are parse-only", async () => {
    const used = new Set<string>();
    for (const file of files) {
      for (const match of (await readFile(file, "utf8")).matchAll(/\bts\.(create\w+|transpile\w*)\b/g)) used.add(match[1] as string);
    }
    // createSourceFile parses; transpileModule is used only for syntax diagnostics and its output is discarded.
    expect([...used].sort()).toEqual(["createSourceFile", "transpileModule"]);
  });
});
