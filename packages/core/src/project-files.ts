import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FileExposures, FileReferences } from "./analyze.js";
import { discoverSourceFiles } from "./discovery.js";
import type { FrameworkAdapter } from "./framework.js";

/** Shared, read-only access to project files for scan, init and doctor. */

export const CONFIG_FILE_NAME = "envsync.config.ts";
export const ENV_EXAMPLE_FILE_NAME = ".env.example";
/** Files larger than this are skipped; real source files are far smaller, crafted ones may not be. */
export const MAX_FILE_BYTES = 1_000_000;

export type ScanErrorCode = "CONFIG_NOT_FOUND" | "UNSAFE_PATH" | "FILE_TOO_LARGE" | "READ_FAILED";

/** Problems that stop a command before analysis (as opposed to findings, which are diagnostics). */
export class ScanError extends Error {
  readonly code: ScanErrorCode;

  constructor(code: ScanErrorCode, message: string) {
    super(message);
    this.name = "ScanError";
    this.code = code;
  }
}

export type SkippedPath = {
  path: string;
  reason: "symlink" | "unreadable" | "too-large" | "parse-failed";
};

export type SourceEvidence = {
  references: FileReferences[];
  exposures: FileExposures[];
  filesScanned: number;
  skipped: SkippedPath[];
};

/** Discovers and parses source files. Never reads `.env*` files or the EnvSync config as source. */
export async function collectSourceEvidence(absoluteRoot: string, framework: FrameworkAdapter): Promise<SourceEvidence> {
  const discovery = await discoverSourceFiles(absoluteRoot);
  const skipped: SkippedPath[] = [...discovery.skipped];
  const references: FileReferences[] = [];
  const exposures: FileExposures[] = [];
  let filesScanned = 0;

  for (const file of discovery.files) {
    if (file === CONFIG_FILE_NAME) continue;
    const absolutePath = path.join(absoluteRoot, file);

    let text: string;
    try {
      if ((await stat(absolutePath)).size > MAX_FILE_BYTES) {
        skipped.push({ path: file, reason: "too-large" });
        continue;
      }
      text = await readFile(absolutePath, "utf8");
    } catch {
      skipped.push({ path: file, reason: "unreadable" });
      continue;
    }

    try {
      references.push({ file, references: framework.extractReferences(text, file) });
      if (framework.frameworkConfigFiles.includes(file)) {
        exposures.push({ file, names: framework.extractClientExposedNames(text, file) });
      }
    } catch {
      skipped.push({ path: file, reason: "parse-failed" });
      continue;
    }
    filesScanned++;
  }

  return {
    references,
    exposures,
    filesScanned,
    skipped: skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/**
 * Reads a fixed file directly inside `directory`. Returns `null` if absent; refuses symlinks,
 * non-regular files and oversized files so a crafted project cannot redirect reads elsewhere.
 */
export async function readProjectFile(directory: string, fileName: string): Promise<string | null> {
  const absolutePath = path.join(directory, fileName);
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new ScanError("READ_FAILED", `Cannot access ${fileName}. Check that it is readable.`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ScanError(
      "UNSAFE_PATH",
      `Refusing to read ${fileName} because it is not a regular file (symbolic links are not followed). Replace it with a regular file inside the project.`,
    );
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new ScanError("FILE_TOO_LARGE", `${fileName} is larger than ${MAX_FILE_BYTES} bytes. Check that it is the intended file.`);
  }
  try {
    return await readFile(absolutePath, "utf8");
  } catch {
    throw new ScanError("READ_FAILED", `Cannot read ${fileName}. Check that it is readable.`);
  }
}

export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
