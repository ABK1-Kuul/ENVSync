/**
 * Public diagnostic model. Codes and the JSON shape are a public contract (ADR-003):
 * do not rename, repurpose or remove a code once released.
 */

export const DIAGNOSTIC_CODES = ["ENV001", "ENV002", "ENV003", "ENV004", "ENV005", "ENV006", "ENV007", "ENV008", "ENV009", "ENV010", "ENV011"] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type Severity = "error" | "warning" | "info";

/**
 * `file` is root-relative with `/` separators. `value` is set only on findings about a value read
 * from a runtime env file (ENV005, ENV010), only when the caller asked for values (`includeValues`), and
 * then as a redaction marker unless the value is a malformed, non-private one (ADR-016).
 */
export type Diagnostic = {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  variableName?: string;
  suggestion?: string;
  value?: string;
  /** True when `value` is a redaction marker, not the value itself (ADR-016). */
  valueRedacted?: boolean;
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
