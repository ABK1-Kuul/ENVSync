import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Source discovery for the scan pipeline: the first step, before any file is read.
 *
 * Security properties:
 * - Only directory listings and the root's metadata are read; file contents are never opened.
 * - Symbolic links (and Windows junctions) are never followed, so nothing outside the root is visited.
 * - Environment files (`.env`, `.env.*`) are never returned, including `.env.example`,
 *   which is handled by its own parser rather than the source scanner.
 */

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] as const;

/** Never scanned, at any depth: version control, dependencies and the Next.js build cache. */
export const ALWAYS_EXCLUDED_DIRECTORIES = [".git", "node_modules", ".next"] as const;

/**
 * Generated output, skipped at any depth except inside a Next.js `app/` or `pages/` directory,
 * where these names are ordinary route segments (`app/build/page.tsx` is the `/build` route).
 */
export const GENERATED_OUTPUT_DIRECTORIES = ["dist", "build", "out", "coverage"] as const;

export const EXCLUDED_DIRECTORIES = [...ALWAYS_EXCLUDED_DIRECTORIES, ...GENERATED_OUTPUT_DIRECTORIES] as const;

const ROUTE_DIRECTORIES = new Set(["app", "pages"]);

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
        // Only links that could have been scanned make the scan incomplete; a linked
        // node_modules, image or .env file would never have been read anyway.
        if (couldBeScanned(entry.name, directory, absoluteRoot)) skipped.push({ path: toRelative(absoluteRoot, entryPath), reason: "symlink" });
      } else if (entry.isDirectory()) {
        if (!isExcludedDirectory(entry.name, directory, absoluteRoot)) pending.push(entryPath);
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
function isExcludedDirectory(name: string, parent: string, absoluteRoot: string): boolean {
  const lower = name.toLowerCase();
  if ((ALWAYS_EXCLUDED_DIRECTORIES as readonly string[]).includes(lower)) return true;
  if (!(GENERATED_OUTPUT_DIRECTORIES as readonly string[]).includes(lower)) return false;
  return !isInsideRouteDirectory(parent, absoluteRoot);
}

/**
 * Whether `directory` is inside the project's Next.js route tree: `app/` or `pages/` at the project
 * root or under `src/` (case-insensitive). Other directories that happen to be named `app`, like
 * `packages/app/dist`, keep the generated-output exclusion.
 */
function isInsideRouteDirectory(directory: string, absoluteRoot: string): boolean {
  const segments = path.relative(absoluteRoot, directory).split(path.sep).map((segment) => segment.toLowerCase());
  const routeStart = segments[0] === "src" ? 1 : 0;
  return ROUTE_DIRECTORIES.has(segments[routeStart] ?? "");
}

/**
 * Without following a link its target type is unknown, so a link is assumed relevant unless its
 * name is clearly not scanned: an env file, an excluded directory, a type declaration, or a
 * known non-source extension. Directory names often contain dots (`api.v2`, `[...slug]`), so
 * "has an extension" alone is not enough to treat a link as an ignorable file.
 */
function couldBeScanned(name: string, parent: string, absoluteRoot: string): boolean {
  const lower = name.toLowerCase();
  if (isEnvFile(lower)) return false;
  if (isSourceFile(name)) return true;
  if (isExcludedDirectory(name, parent, absoluteRoot)) return false;
  if (DECLARATION_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  return !NON_SOURCE_EXTENSIONS.has(path.extname(lower));
}

const NON_SOURCE_EXTENSIONS = new Set([
  // images, fonts, media
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".avif", ".bmp", ".tif", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".wav", ".webm", ".ogg", ".mov", ".pdf",
  // documents, styles, data
  ".md", ".mdx", ".txt", ".css", ".scss", ".sass", ".less", ".json", ".yml", ".yaml", ".toml",
  ".xml", ".csv", ".html", ".map", ".lock", ".log",
  // archives
  ".zip", ".gz", ".tgz", ".tar",
]);

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
