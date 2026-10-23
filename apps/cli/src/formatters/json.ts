import type { Diagnostic, ScanResult, SeverityCounts } from "@envsync-internal/core";
import { sanitizeJsonDocument } from "./sanitize.js";

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
      strict,
      exitCode,
    },
    diagnostics: result.diagnostics.map(toJsonDiagnostic),
    skipped: result.skipped.map(({ path, reason }) => ({ path, reason })),
  };
  // JSON.stringify escapes C0 controls but not DEL, C1, invisible or bidi characters; escaping them
  // keeps the document identical once parsed while making raw `cat` output safe.
  return `${sanitizeJsonDocument(JSON.stringify(output, null, 2))}\n`;
}

// Fixed key order and explicit fields keep the output stable even if the internal type grows.
function toJsonDiagnostic(diagnostic: Diagnostic): Record<string, string | number> {
  const entry: Record<string, string | number> = {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
  };
  if (diagnostic.file !== undefined) entry.file = diagnostic.file;
  if (diagnostic.line !== undefined) entry.line = diagnostic.line;
  if (diagnostic.column !== undefined) entry.column = diagnostic.column;
  if (diagnostic.variableName !== undefined) entry.variableName = diagnostic.variableName;
  if (diagnostic.suggestion !== undefined) entry.suggestion = diagnostic.suggestion;
  return entry;
}
