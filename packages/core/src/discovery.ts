import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Source discovery for the scan pipeline (steps 1–2 in ARCHITECTURE.md).
 *
 * Security properties:
 * - Only directory listings and the root's metadata are read; file contents are never opened.
 * - Symbolic links (and Windows junctions) are never followed, so nothing outside the root is visited.
 * - Environment files (`.env`, `.env.*`) are never returned, including `.env.example`,
 *   which is handled by its own parser rather than the source scanner.
 */

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] as const;

export const EXCLUDED_DIRECTORIES = [".git", "node_modules", ".next", "dist", "build", "out", "coverage"] as const;

// Generated type declarations (e.g. Next.js's `next-env.d.ts`) never contain runtime env access.
const DECLARATION_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"] as const;

export type DiscoveryErrorCode = "ROOT_NOT_FOUND" | "ROOT_NOT_DIRECTORY" | "ROOT_UNREADABLE";

export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;

  constructor(code: DiscoveryErrorCode, message: string) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
  }
}

export type SkippedEntry = {
  /** Root-relative path using `/` separators. */
  path: string;
  /** `limit-reached`: listing stopped here because the entry limit was hit (recorded once). */
  reason: "symlink" | "unreadable" | "limit-reached";
};

export type DiscoveryResult = {
  /** Root-relative source file paths using `/` separators, sorted by code unit. */
  files: string[];
  /** Entries that were deliberately not traversed, sorted by path. */
  skipped: SkippedEntry[];
};

/** Bounds work on hostile or enormous trees; documented in docs/CLI.md ("Resource limits"). */
export const MAX_DISCOVERY_ENTRIES = 200_000;

/** Lists source files under `root` that are eligible for static env-reference analysis. */
export async function discoverSourceFiles(root: string, maxEntries = MAX_DISCOVERY_ENTRIES): Promise<DiscoveryResult> {
  const absoluteRoot = path.resolve(root);
  await assertDirectory(absoluteRoot);

  const files: string[] = [];
  const skipped: SkippedEntry[] = [];
  const pending: string[] = [absoluteRoot];
  let visited = 0;

  traversal: for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === absoluteRoot) {
        throw new DiscoveryError("ROOT_UNREADABLE", `Cannot read project root ${absoluteRoot} (${errorCode(error)}). Check that you have permission to list it.`);
      }
      skipped.push({ path: toRelative(absoluteRoot, directory), reason: "unreadable" });
      continue;
    }
    // Sorted, so which entries fall within the limit does not depend on file-system order.
    entries.sort((a, b) => compareCodeUnits(a.name, b.name));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (++visited > maxEntries) {
        skipped.push({ path: toRelative(absoluteRoot, entryPath), reason: "limit-reached" });
        break traversal;
      }
      if (entry.isSymbolicLink()) {
        skipped.push({ path: toRelative(absoluteRoot, entryPath), reason: "symlink" });
      } else if (entry.isDirectory()) {
        if (!isExcludedDirectory(entry.name)) pending.push(entryPath);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        files.push(toRelative(absoluteRoot, entryPath));
      }
    }
  }

  return {
    files: files.sort(compareCodeUnits),
    skipped: skipped.sort((a, b) => compareCodeUnits(a.path, b.path)),
  };
}

async function assertDirectory(absoluteRoot: string): Promise<void> {
  let stats;
  try {
    stats = await stat(absoluteRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new DiscoveryError("ROOT_NOT_FOUND", `Project root ${absoluteRoot} does not exist. Pass the path to your project directory.`);
    }
    throw new DiscoveryError("ROOT_UNREADABLE", `Cannot access project root ${absoluteRoot} (${errorCode(error)}). Check that the path is correct and readable.`);
  }
  if (!stats.isDirectory()) {
    throw new DiscoveryError("ROOT_NOT_DIRECTORY", `Project root ${absoluteRoot} is not a directory. Pass the directory that contains your project, not a file.`);
  }
}

// Names are compared case-insensitively because Windows and macOS filesystems usually are.
function isExcludedDirectory(name: string): boolean {
  return (EXCLUDED_DIRECTORIES as readonly string[]).includes(name.toLowerCase());
}

function isSourceFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (isEnvFile(lower)) return false;
  if (DECLARATION_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  return (SOURCE_EXTENSIONS as readonly string[]).includes(path.extname(lower));
}

function isEnvFile(lowerName: string): boolean {
  return lowerName === ".env" || lowerName.startsWith(".env.");
}

function toRelative(absoluteRoot: string, absolutePath: string): string {
  return path.relative(absoluteRoot, absolutePath).split(path.sep).join("/");
}

// Locale-independent ordering so output is identical across machines.
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "unknown error";
}
