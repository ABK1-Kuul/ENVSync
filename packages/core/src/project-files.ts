import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
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
  /** `limit-reached` is recorded once, at the first file not scanned because a scan limit was hit. */
  reason: "symlink" | "unreadable" | "too-large" | "parse-failed" | "limit-reached";
};

export type ScanLimits = { maxFiles: number; maxTotalBytes: number };

/** Bounds work on hostile or enormous trees; documented in docs/CLI.md ("Resource limits"). */
export const DEFAULT_SCAN_LIMITS: ScanLimits = { maxFiles: 20_000, maxTotalBytes: 200_000_000 };

export type SourceEvidence = {
  references: FileReferences[];
  exposures: FileExposures[];
  filesScanned: number;
  skipped: SkippedPath[];
};

/** Discovers and parses source files. Never reads `.env*` files or the EnvSync config as source. */
export async function collectSourceEvidence(
  absoluteRoot: string,
  framework: FrameworkAdapter,
  limits: ScanLimits = DEFAULT_SCAN_LIMITS,
): Promise<SourceEvidence> {
  const discovery = await discoverSourceFiles(absoluteRoot);
  const skipped: SkippedPath[] = [...discovery.skipped];
  const references: FileReferences[] = [];
  const exposures: FileExposures[] = [];
  let filesScanned = 0;
  let filesRead = 0;
  let totalBytes = 0;

  for (const file of discovery.files) {
    if (file === CONFIG_FILE_NAME) continue;
    if (filesRead >= limits.maxFiles || totalBytes >= limits.maxTotalBytes) {
      skipped.push({ path: file, reason: "limit-reached" });
      break;
    }
    const absolutePath = path.join(absoluteRoot, file);

    const read = await readRegularFile(absolutePath);
    filesRead++;
    if (!read.ok) {
      skipped.push({ path: file, reason: read.reason === "too-large" ? "too-large" : "unreadable" });
      continue;
    }
    const text = read.text;
    totalBytes += Buffer.byteLength(text, "utf8");

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
  const read = await readRegularFile(path.join(directory, fileName));
  if (read.ok) return read.text;
  switch (read.reason) {
    case "missing":
      return null;
    case "not-regular":
      throw new ScanError(
        "UNSAFE_PATH",
        `Refusing to read ${fileName} because it is not a regular file (symbolic links are not followed). Replace it with a regular file inside the project.`,
      );
    case "changed":
      throw new ScanError(
        "READ_FAILED",
        `${fileName} changed or was replaced while EnvSync was reading it, so it was not used. Run the command again once the file is no longer being written.`,
      );
    case "too-large":
      throw new ScanError("FILE_TOO_LARGE", `${fileName} is larger than ${MAX_FILE_BYTES} bytes. Check that it is the intended file.`);
    case "unreadable":
      throw new ScanError("READ_FAILED", `Cannot read ${fileName}. Check that it is readable.`);
  }
}

export type ReadFailure = { ok: false; reason: "missing" | "not-regular" | "too-large" | "changed" | "unreadable" };

export type RegularFileRead = { ok: true; text: string } | ReadFailure;

/** `readRegularFileBytes`, decoded as UTF-8. */
export async function readRegularFile(absolutePath: string, maxBytes = MAX_FILE_BYTES): Promise<RegularFileRead> {
  const read = await readRegularFileBytes(absolutePath, maxBytes);
  return read.ok ? { ok: true, text: read.bytes.toString("utf8") } : read;
}

/**
 * Reads a regular file without following links, through one verified handle: the opened file must
 * be the one `lstat` saw (same device and inode). This closes the check-then-read window in which a
 * crafted project could swap in a symlink to redirect the read (O_NOFOLLOW where the OS supports it;
 * the identity check on every platform). At most `maxBytes` are ever read, even if the file grows.
 */
export async function readRegularFileBytes(absolutePath: string, maxBytes = MAX_FILE_BYTES): Promise<{ ok: true; bytes: Buffer } | ReadFailure> {
  let before;
  try {
    before = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    return { ok: false, reason: isNotFound(error) ? "missing" : "unreadable" };
  }
  if (!before.isFile()) return { ok: false, reason: "not-regular" };
  if (before.size > BigInt(maxBytes)) return { ok: false, reason: "too-large" };

  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return { ok: false, reason: code === "ELOOP" ? "not-regular" : "unreadable" };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return { ok: false, reason: "changed" };
    if (opened.size > BigInt(maxBytes)) return { ok: false, reason: "too-large" };
    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // A file that ended early shrank while being read; a partial read is never reported as the file.
    if (offset !== buffer.length) return { ok: false, reason: "changed" };
    return { ok: true, bytes: buffer };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
