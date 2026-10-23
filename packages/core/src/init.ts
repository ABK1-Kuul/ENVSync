import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
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
import { collectSourceEvidence, CONFIG_FILE_NAME, ENV_EXAMPLE_FILE_NAME, readProjectFile } from "./project-files.js";
import { parseConfigSafely } from "./scan.js";

/**
 * `envsync init`: preview-first generation of a starter config and `.env.example`.
 *
 * - Planning is read-only. Applying is a separate, explicit step.
 * - Existing files are never overwritten or rewritten: the config is only ever created, and
 *   `.env.example` only ever gains appended placeholder lines.
 * - Generated content holds names, comments and empty placeholders only. `.env`/`.env.*` files
 *   are never read, so no local value can be copied.
 */

export type FileChange =
  | { path: string; action: "create"; content: string }
  /** `baseHash` fingerprints the file as previewed; the existing content itself is never kept or shown. */
  | { path: string; action: "append"; content: string; baseHash: string }
  | { path: string; action: "unchanged"; reason: string };

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
};

export type InitErrorCode = "FILE_CHANGED" | "WRITE_FAILED";

export class InitError extends Error {
  readonly code: InitErrorCode;

  constructor(code: InitErrorCode, message: string) {
    super(message);
    this.name = "InitError";
    this.code = code;
  }
}

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
  const exampleText = await readProjectFile(absoluteRoot, ENV_EXAMPLE_FILE_NAME);
  if (exampleText === null) {
    exampleAdditions = contractNames;
    changes.push({ path: ENV_EXAMPLE_FILE_NAME, action: "create", content: renderEnvExample(contractNames) });
  } else {
    const listed = new Set(parseEnvExample(exampleText).entries.map((entry) => entry.name));
    exampleAdditions = contractNames.filter((name) => !listed.has(name));
    changes.push(
      exampleAdditions.length === 0
        ? { path: ENV_EXAMPLE_FILE_NAME, action: "unchanged", reason: "already lists every declared variable." }
        : {
            path: ENV_EXAMPLE_FILE_NAME,
            action: "append",
            content: renderEnvExampleAppend(exampleText, exampleAdditions),
            baseHash: fingerprint(exampleText),
          },
    );
  }

  return {
    changes,
    configVariables,
    exampleAdditions,
    skippedNames: [...skippedNames].sort(compare),
    dynamicAccessCount,
    configIssueCount,
  };
}

/**
 * Applies a plan produced by `planInit` for the same root. Creates use exclusive mode, so a file
 * that appeared after the preview is never overwritten; appends are refused if the file changed.
 * Returns the paths that were written, in order.
 */
export async function applyInitPlan(root: string, plan: InitPlan): Promise<string[]> {
  const absoluteRoot = path.resolve(root);
  const written: string[] = [];

  for (const change of plan.changes) {
    const absolutePath = path.join(absoluteRoot, change.path);
    if (change.action === "create") {
      try {
        await writeFile(absolutePath, change.content, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        throw writeError(error, change.path, written);
      }
      written.push(change.path);
    } else if (change.action === "append") {
      const current = await readProjectFile(absoluteRoot, change.path);
      if (current === null || fingerprint(current) !== change.baseHash) {
        throw new InitError(
          "FILE_CHANGED",
          `${change.path} changed after the preview, so nothing was appended to it.${appliedNote(written)} Run \`envsync init\` again to review the new preview.`,
        );
      }
      try {
        // O_NOFOLLOW (where the OS supports it) closes the gap between the check above and the write.
        const handle = await open(absolutePath, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
        try {
          await handle.appendFile(change.content, "utf8");
        } finally {
          await handle.close();
        }
      } catch (error) {
        throw writeError(error, change.path, written);
      }
      written.push(change.path);
    }
  }
  return written;
}

function writeError(error: unknown, filePath: string, written: readonly string[]): InitError {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown error";
  if (code === "EEXIST") {
    return new InitError(
      "FILE_CHANGED",
      `${filePath} was created after the preview, so it was left untouched.${appliedNote(written)} Run \`envsync init\` again to review the new preview.`,
    );
  }
  return new InitError("WRITE_FAILED", `Could not write ${filePath} (${code}).${appliedNote(written)} Check permissions and try again.`);
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
