import type { Diagnostic, ScanResult, SeverityCounts } from "@envsync-internal/core";
import { sanitizeJsonDocument } from "./sanitize.js";
import { countDynamicAccesses } from "./summary.js";

/** Version of the JSON output contract. Bump only with a documented breaking change. */
export const JSON_SCHEMA_VERSION = 1;

export function formatJson(result: ScanResult, counts: SeverityCounts, strict: boolean, exitCode: number): string {
  const output = {
    schemaVersion: JSON_SCHEMA_VERSION,
    summary: {
      errors: counts.errors,
      warnings: counts.warnings,
      infos: counts.infos,
      filesScanned: result.filesScanned,
      envFilesRead: result.envFiles.length,
      // Environment context whose files decided ENV008 (development, preview, production or test).
      envContext: result.envContext,
      // false when any path in `skipped` was not scanned: findings may be incomplete.
      complete: result.complete,
      // ENV006 count: places where variables were read dynamically and therefore not checked.
      dynamicAccesses: countDynamicAccesses(result.diagnostics),
      strict,
      exitCode,
    },
    diagnostics: result.diagnostics.map(toJsonDiagnostic),
    envFiles: result.envFiles,
    skipped: result.skipped.map(({ path, reason }) => ({ path, reason })),
  };
  // JSON.stringify escapes C0 controls but not DEL, C1, invisible or bidi characters; escaping them
  // keeps the document identical once parsed while making raw `cat` output safe.
  return `${sanitizeJsonDocument(JSON.stringify(output, null, 2))}\n`;
}

// Fixed key order and explicit fields keep the output stable even if the internal type grows.
function toJsonDiagnostic(diagnostic: Diagnostic): Record<string, string | number | boolean> {
  const entry: Record<string, string | number | boolean> = {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
  };
  if (diagnostic.file !== undefined) entry.file = diagnostic.file;
  if (diagnostic.line !== undefined) entry.line = diagnostic.line;
  if (diagnostic.column !== undefined) entry.column = diagnostic.column;
  if (diagnostic.variableName !== undefined) entry.variableName = diagnostic.variableName;
  if (diagnostic.suggestion !== undefined) entry.suggestion = diagnostic.suggestion;
  // Present only with --show-values.
  if (diagnostic.value !== undefined) entry.value = diagnostic.value;
  if (diagnostic.valueRedacted === true) entry.valueRedacted = true;
  return entry;
}
