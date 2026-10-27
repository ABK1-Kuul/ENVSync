import { matchesType, secretValueFormat } from "@envsync-internal/core";
import { effectiveVisibility, parseEnvAssignments, type ParsedConfig, type VariableDefinition } from "@envsync-internal/schema";

/**
 * The table shown for one env file. Pure: built from the file's text and, when found, the app's
 * parsed `envsync.config.ts`. Values that should stay out of sight (Secret/Sensitive variables,
 * private-looking names, credential-shaped values) are never put in the model; the editor asks for
 * one explicitly when the user reveals it.
 */

export type RowIssue = "duplicate" | "undeclared" | "type-mismatch" | "credential-in-public";

export type TableRow = {
  name: string;
  line: number;
  /** `undefined` when masked; the webview shows a placeholder and offers "reveal". */
  value?: string;
  masked: boolean;
  /** Why the value is masked, for the tooltip. */
  maskReason?: string;
  visibility?: "plain" | "sensitive" | "secret";
  type?: string;
  required?: boolean;
  description?: string;
  issues: RowIssue[];
};

export type TableModel = {
  /** Document version the model was built from; edits must name it (conflict detection). */
  version: number;
  fileName: string;
  environment: string;
  /** False when no envsync.config.ts was found for this file. */
  hasConfig: boolean;
  rows: TableRow[];
  invalidLines: number[];
};

export type ModelInput = {
  text: string;
  version: number;
  fileName: string;
  environment: string;
  /** `null` when no envsync.config.ts was found: every value is then masked (nothing says which are secret). */
  config: ParsedConfig | null;
  publicPrefix: string;
};

const NO_CONFIG_REASON = "No envsync.config.ts was found for this file, so every value is hidden until revealed.";

const PRIVATE_NAME = /SECRET|PASS|PWD|TOKEN|PRIVATE|CREDENTIAL|KEY|AUTH|SALT|DSN|JWT|SIGN|CERT|SESSION|COOKIE/i;

export function buildTableModel(input: ModelInput): TableModel {
  const { assignments, invalidLines } = parseEnvAssignments(input.text);
  const declared = new Map<string, VariableDefinition>((input.config?.variables ?? []).map((definition) => [definition.name, definition]));
  const counts = new Map<string, number>();
  for (const { name } of assignments) counts.set(name, (counts.get(name) ?? 0) + 1);

  // One row per name, at the assignment that takes effect (the last one).
  const effective = new Map(assignments.map((assignment) => [assignment.name, assignment]));
  const rows = [...effective.values()]
    .sort((a, b) => a.line - b.line)
    .map((assignment): TableRow => {
      const definition = declared.get(assignment.name);
      const visibility = definition === undefined ? undefined : effectiveVisibility(definition);
      const mask = input.config === null ? NO_CONFIG_REASON : maskReason(assignment.name, assignment.value, visibility);
      const issues: RowIssue[] = [];
      if ((counts.get(assignment.name) ?? 0) > 1) issues.push("duplicate");
      if (input.config !== null && definition === undefined) issues.push("undeclared");
      if (definition !== undefined && assignment.value.trim() !== "" && matchesType(assignment.value, definition.type, assignment.quote) === false) {
        issues.push("type-mismatch");
      }
      if (assignment.name.startsWith(input.publicPrefix) && definition?.secret !== false && secretValueFormat(assignment.value) !== undefined) {
        issues.push("credential-in-public");
      }
      return {
        name: assignment.name,
        line: assignment.line,
        ...(mask === undefined ? { value: assignment.value } : {}),
        masked: mask !== undefined,
        ...(mask === undefined ? {} : { maskReason: mask }),
        ...(visibility === undefined ? {} : { visibility }),
        ...(definition === undefined ? {} : { type: definition.type, required: definition.required }),
        ...(definition?.description === undefined ? {} : { description: definition.description }),
        issues,
      };
    });

  return {
    version: input.version,
    fileName: input.fileName,
    environment: input.environment,
    hasConfig: input.config !== null,
    rows,
    invalidLines,
  };
}

function maskReason(name: string, value: string, visibility: string | undefined): string | undefined {
  if (visibility === "secret" || visibility === "sensitive") return `Declared ${visibility} in envsync.config.ts.`;
  const format = secretValueFormat(value);
  if (format !== undefined) return `The value looks like ${format}.`;
  if (PRIVATE_NAME.test(name)) return "The name suggests a private value.";
  return undefined;
}

/**
 * Whether the whole text could be shown (for example in a diff) without displaying anything that
 * would be masked in the table. Stricter than the rows: every assignment counts, including repeats
 * that are shadowed by a later one, and every other non-blank line must be a harmless comment.
 * Lines that are not assignments, comments holding `=` (often commented-out values) or anything
 * credential-shaped make the text unsafe. With no config, nothing is safe (every value is masked).
 */
export function isSafeToDisplay(text: string, config: ParsedConfig | null): boolean {
  if (config === null) return false;
  const declared = new Map<string, VariableDefinition>(config.variables.map((definition) => [definition.name, definition]));
  const { assignments, invalidLines } = parseEnvAssignments(text);
  if (invalidLines.length > 0) return false;
  const covered = new Set<number>();
  for (const assignment of assignments) {
    const definition = declared.get(assignment.name);
    const visibility = definition === undefined ? undefined : effectiveVisibility(definition);
    if (maskReason(assignment.name, assignment.value, visibility) !== undefined) return false;
    for (let line = assignment.line; line <= assignment.endLine; line++) covered.add(line);
  }
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\n|\r/);
  return lines.every((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || covered.has(index + 1)) return true;
    // Only remaining case: a comment (anything else would be an invalid line).
    return !trimmed.includes("=") && !trimmed.split(/\s+/).some((word) => secretValueFormat(word) !== undefined);
  });
}

/** The current value of `name` (the assignment that takes effect), for an explicit reveal. */
export function revealValue(text: string, name: string): string | undefined {
  const { assignments } = parseEnvAssignments(text);
  for (let i = assignments.length - 1; i >= 0; i--) {
    if (assignments[i]?.name === name) return assignments[i]?.value;
  }
  return undefined;
}
