import type { Diagnostic as ScanDiagnostic } from "@envsync-internal/core";

/** A scan finding placed in one file, ready to become an editor diagnostic. Pure. */
export type FileFinding = {
  /** Root-relative path with `/` separators. */
  file: string;
  /** Zero-based, as editors count. */
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
};

/** Groups scan findings by file. Project-level findings (no file) are attached to the config file. */
export function groupFindings(diagnostics: readonly ScanDiagnostic[], configFile: string): Map<string, FileFinding[]> {
  const byFile = new Map<string, FileFinding[]>();
  for (const diagnostic of diagnostics) {
    const file = diagnostic.file ?? configFile;
    const findings = byFile.get(file) ?? [];
    findings.push({
      file,
      line: Math.max(0, (diagnostic.line ?? 1) - 1),
      column: Math.max(0, (diagnostic.column ?? 1) - 1),
      severity: diagnostic.severity,
      code: diagnostic.code,
      // Messages never contain values (core guarantees it); the suggestion helps fix the finding.
      message: diagnostic.suggestion === undefined ? diagnostic.message : `${diagnostic.message} ${diagnostic.suggestion}`,
    });
    byFile.set(file, findings);
  }
  return byFile;
}
