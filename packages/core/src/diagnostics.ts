/**
 * Public diagnostic model. Codes and the JSON shape are a public contract (ADR-003):
 * do not rename, repurpose or remove a code once released.
 */

export const DIAGNOSTIC_CODES = ["ENV001", "ENV002", "ENV003", "ENV004", "ENV005", "ENV006", "ENV007"] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type Severity = "error" | "warning" | "info";

/** Never carries an environment-variable value. `file` is root-relative with `/` separators. */
export type Diagnostic = {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  variableName?: string;
  suggestion?: string;
};

export type SeverityCounts = { errors: number; warnings: number; infos: number };

export function countBySeverity(diagnostics: readonly Diagnostic[]): SeverityCounts {
  const counts: SeverityCounts = { errors: 0, warnings: 0, infos: 0 };
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") counts.errors++;
    else if (diagnostic.severity === "warning") counts.warnings++;
    else counts.infos++;
  }
  return counts;
}

/** Deterministic order: by file (project-level findings last), position, code, then variable. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  if (a.file !== b.file) {
    if (a.file === undefined) return 1;
    if (b.file === undefined) return -1;
    return compareStrings(a.file, b.file);
  }
  return (
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    compareStrings(a.code, b.code) ||
    compareStrings(a.variableName ?? "", b.variableName ?? "")
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
