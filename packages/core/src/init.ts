import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  isValidVariableName,
  parseEnvExample,
  renderConfig,
  renderEnvExample,
  renderEnvExampleAppend,
  type GeneratedVariable,
} from "@envsync-internal/schema";
import type { FrameworkAdapter } from "./framework.js";
import { collectSourceEvidence, CONFIG_FILE_NAME, ENV_EXAMPLE_FILE_NAME, MAX_FILE_BYTES, readProjectFile } from "./project-files.js";
import { parseConfigSafely } from "./scan.js";

/**
 * `envsync init`: preview-first generation of a starter config and `.env.example`.
 *
 * - Planning is read-only. `--write` re-plans and applies in the same run; it does not replay an
 *   earlier preview, so the files are checked again at write time.
 * - Existing files are never overwritten or rewritten: the config is only ever created, and
 *   `.env.example` only ever gains appended placeholder lines.
 * - Generated content holds names, comments and empty placeholders only. `.env`/`.env.*` files
 *   are never read, so no local value can be copied.
 */

export type FileChange =
  | { path: string; action: "create"; content: string }
  /** `baseHash` fingerprints the file as planned; the existing content itself is never kept or shown. */
  | { path: string; action: "append"; content: string; baseHash: string }
  | { path: string; action: "unchanged"; reason: string }
  /** A change that is needed but cannot be made safely; `--write` refuses the whole plan. */
  | { path: string; action: "blocked"; reason: string };

export type InitPlan = {
  changes: FileChange[];
  /** Names that would be declared in a newly created config. */
  configVariables: string[];
  /** Names that would be added to `.env.example`. */
  exampleAdditions: string[];
  /** References whose names cannot be valid variable names and were left out. */
  skippedNames: string[];
  dynamicAccessCount: number;
  /** Problems found in an existing config (run `scan` for details). */
  configIssueCount: number;
  /** Groups of names in `.env.example` (after the change) that differ only by letter case. */
  caseCollisions: string[][];
};

export type InitErrorCode = "FILE_CHANGED" | "WRITE_FAILED" | "BLOCKED";

export class InitError extends Error {
  readonly code: InitErrorCode;

  constructor(code: InitErrorCode, message: string) {
    super(message);
    this.name = "InitError";
    this.code = code;
  }
}

const WRITABLE_PATHS = new Set([CONFIG_FILE_NAME, ENV_EXAMPLE_FILE_NAME]);

export async function planInit({ root, framework }: { root: string; framework: FrameworkAdapter }): Promise<InitPlan> {
  const absoluteRoot = path.resolve(root);
  const evidence = await collectSourceEvidence(absoluteRoot, framework);
  const builtIns = new Set(framework.builtInVariables);

  const firstReferences = new Map<string, { file: string; line: number }>();
  const skippedNames = new Set<string>();
  let dynamicAccessCount = 0;
  for (const { file, references } of [...evidence.references].sort((a, b) => compare(a.file, b.file))) {
    for (const reference of references) {
      if (reference.kind === "dynamic") {
        dynamicAccessCount++;
      } else if (!isValidVariableName(reference.name)) {
        skippedNames.add(reference.name);
      } else if (!builtIns.has(reference.name) && !firstReferences.has(reference.name)) {
        firstReferences.set(reference.name, { file, line: reference.line });
      }
    }
  }

  const changes: FileChange[] = [];
  let contractNames: string[];
  let configVariables: string[] = [];
  let configIssueCount = 0;

  const configText = await readProjectFile(absoluteRoot, CONFIG_FILE_NAME);
  if (configText === null) {
    configVariables = [...firstReferences.keys()].sort(compare);
    const generated: GeneratedVariable[] = configVariables.map((name) => ({
      name,
      firstReference: firstReferences.get(name) as { file: string; line: number },
    }));
    changes.push({ path: CONFIG_FILE_NAME, action: "create", content: renderConfig(generated) });
    contractNames = configVariables;
  } else {
    const config = parseConfigSafely(configText);
    configIssueCount = config.issues.length;
    contractNames = config.variables.map((variable) => variable.name);
    changes.push({
      path: CONFIG_FILE_NAME,
      action: "unchanged",
      reason: "already exists. EnvSync never rewrites it; edit it by hand and use `envsync scan` to check it.",
    });
  }

  let exampleAdditions: string[] = [];
  let existingNames: string[] = [];
  const exampleText = await readProjectFile(absoluteRoot, ENV_EXAMPLE_FILE_NAME);
  if (configIssueCount > 0) {
    // A broken config may have lost declarations; planning from it would give a false "complete".
    changes.push({
      path: ENV_EXAMPLE_FILE_NAME,
      action: "unchanged",
      reason: `not checked because ${CONFIG_FILE_NAME} has ${configIssueCount} problem(s). Fix them (see \`envsync scan\`), then run init again.`,
    });
  } else if (exampleText === null) {
    exampleAdditions = contractNames;
    changes.push({ path: ENV_EXAMPLE_FILE_NAME, action: "create", content: renderEnvExample(contractNames) });
  } else {
    const parsed = parseEnvExample(exampleText);
    existingNames = parsed.entries.map((entry) => entry.name);
    const listed = new Set(existingNames);
    exampleAdditions = contractNames.filter((name) => !listed.has(name));
    changes.push(planExampleAppend(exampleText, parsed.unterminatedQuoteLine, exampleAdditions));
  }

  return {
    changes,
    configVariables,
    exampleAdditions,
    skippedNames: [...skippedNames].sort(compare),
    dynamicAccessCount,
    configIssueCount,
    caseCollisions: caseOnlyGroups([...existingNames, ...exampleAdditions]),
  };
}

function planExampleAppend(exampleText: string, unterminatedQuoteLine: number | undefined, additions: string[]): FileChange {
  if (additions.length === 0) {
    return { path: ENV_EXAMPLE_FILE_NAME, action: "unchanged", reason: "already lists every declared variable." };
  }
  if (unterminatedQuoteLine !== undefined) {
    return {
      path: ENV_EXAMPLE_FILE_NAME,
      action: "blocked",
      reason: `line ${unterminatedQuoteLine} starts a quoted value that is never closed, so appended lines would become part of that value. Close the quote, then run init again.`,
    };
  }
  const content = renderEnvExampleAppend(exampleText, additions);
  // Guarantees idempotency: the appended names must read back as entries.
  const readBack = new Set(parseEnvExample(exampleText + content).entries.map((entry) => entry.name));
  if (!additions.every((name) => readBack.has(name))) {
    return {
      path: ENV_EXAMPLE_FILE_NAME,
      action: "blocked",
      reason: "appended placeholders would not be read as separate entries. Check the end of the file for an unfinished line, then run init again.",
    };
  }
  return { path: ENV_EXAMPLE_FILE_NAME, action: "append", content, baseHash: fingerprint(exampleText) };
}

/**
 * Applies a plan produced by `planInit` for the same root.
 * - Refuses the whole plan if any change is blocked or targets an unexpected path.
 * - Creates open the target exclusively, so a file that appeared since planning is never
 *   overwritten; if writing fails, the incomplete file is removed.
 * - Appends go through one verified handle: same file as checked (device and inode), regular,
 *   single hard link, content unchanged since planning. A failed write is rolled back by
 *   truncating to the original size.
 * Returns the paths that were written, in order.
 */
export async function applyInitPlan(root: string, plan: InitPlan): Promise<string[]> {
  const absoluteRoot = path.resolve(root);
  for (const change of plan.changes) {
    if (!WRITABLE_PATHS.has(change.path)) throw new InitError("BLOCKED", `Refusing to write unexpected path ${change.path}. No files were changed.`);
    if (change.action === "blocked") throw new InitError("BLOCKED", `Cannot update ${change.path}: ${change.reason} No files were changed.`);
  }

  const written: string[] = [];
  for (const change of plan.changes) {
    const absolutePath = path.join(absoluteRoot, change.path);
    if (change.action === "create") {
      await createExclusively(absolutePath, change.path, change.content, written);
      written.push(change.path);
    } else if (change.action === "append") {
      await appendVerified(absolutePath, change.path, change.content, change.baseHash, written);
      written.push(change.path);
    }
  }
  return written;
}

async function createExclusively(absolutePath: string, displayPath: string, content: string, written: readonly string[]): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, "wx");
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new InitError(
        "FILE_CHANGED",
        `${displayPath} was created after planning, so it was left untouched.${appliedNote(written)} Run \`envsync init\` again to review the new preview.`,
      );
    }
    throw new InitError("WRITE_FAILED", `Could not create ${displayPath} (${errorCode(error)}).${appliedNote(written)} Check permissions and try again.`);
  }

  try {
    await writeAll(handle, Buffer.from(content, "utf8"));
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    // The file is ours (exclusive create), so removing it cannot destroy anyone else's work.
    const removed = await unlink(absolutePath).then(
      () => true,
      () => false,
    );
    throw new InitError(
      "WRITE_FAILED",
      `Writing ${displayPath} failed (${errorCode(error)}). ${removed ? "The incomplete file was removed." : `An incomplete ${displayPath} may remain; delete it before running init again.`}${appliedNote(written)}`,
    );
  }
}

async function appendVerified(absolutePath: string, displayPath: string, content: string, baseHash: string, written: readonly string[]): Promise<void> {
  const changed = (detail: string) =>
    new InitError(
      "FILE_CHANGED",
      `${displayPath} ${detail}, so nothing was appended to it.${appliedNote(written)} Run \`envsync init\` again to review the new preview.`,
    );

  let before;
  try {
    before = await lstat(absolutePath, { bigint: true });
  } catch {
    throw changed("no longer exists");
  }
  if (!before.isFile()) throw changed("is no longer a regular file (symbolic links are not followed)");
  // Appending to a hard-linked file would also change the other link, which may be outside the project.
  if (before.nlink !== 1n) throw changed("has more than one hard link");

  let handle: FileHandle;
  try {
    // O_NOFOLLOW/O_NONBLOCK exist on POSIX only; the identity check below covers every platform.
    // No O_APPEND: on Windows it opens an append-only handle that cannot truncate, which would make
    // rollback impossible. Writes go to the verified end offset explicitly instead.
    handle = await open(absolutePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (errorCode(error) === "ELOOP") throw changed("was replaced by a symbolic link");
    throw new InitError("WRITE_FAILED", `Could not open ${displayPath} (${errorCode(error)}).${appliedNote(written)} Check permissions and try again.`);
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n) {
      throw changed("was replaced while being checked");
    }
    if (opened.size > BigInt(MAX_FILE_BYTES)) throw changed("is larger than the size limit");

    const originalSize = Number(opened.size);
    const existing = Buffer.alloc(originalSize);
    let offset = 0;
    while (offset < originalSize) {
      const { bytesRead } = await handle.read(existing, offset, originalSize - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== originalSize || fingerprint(existing.toString("utf8")) !== baseHash) throw changed("changed after planning");

    try {
      await writeAll(handle, Buffer.from(content, "utf8"), originalSize);
    } catch (error) {
      const restored = await handle.truncate(originalSize).then(
        () => true,
        () => false,
      );
      throw new InitError(
        "WRITE_FAILED",
        `Appending to ${displayPath} failed (${errorCode(error)}). ${restored ? "Its original content was restored." : `${displayPath} may end with a partial line; check its end before running init again.`}${appliedNote(written)}`,
      );
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Writes all of `data`, sequentially (`start` null) or starting at a fixed file offset. */
async function writeAll(handle: FileHandle, data: Buffer, start: number | null = null): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, start === null ? null : start + offset);
    if (bytesWritten <= 0) throw Object.assign(new Error("no progress while writing"), { code: "EIO" });
    offset += bytesWritten;
  }
}

function caseOnlyGroups(names: readonly string[]): string[][] {
  const groups = new Map<string, Set<string>>();
  for (const name of names) {
    const key = name.toUpperCase();
    const group = groups.get(key) ?? new Set<string>();
    group.add(name);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.size > 1).map((group) => [...group]);
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown error";
}

function appliedNote(written: readonly string[]): string {
  return written.length > 0 ? ` Already written: ${written.join(", ")}.` : " No files were changed.";
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
