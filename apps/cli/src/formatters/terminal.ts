import type { Diagnostic, ScanResult, SeverityCounts } from "@envsync/core";
import { sanitizeForOutput } from "./sanitize.js";

/**
 * Plain-text output. Severity is always spelled out, so nothing depends on color,
 * and only ASCII punctuation is used so CI logs and legacy consoles render it correctly.
 */
export function formatTerminal(result: ScanResult, counts: SeverityCounts, strict: boolean, exitCode: number): string {
  const lines: string[] = [];

  for (const diagnostic of result.diagnostics) {
    const location = formatLocation(diagnostic);
    lines.push(`${diagnostic.code} ${diagnostic.severity}${location ? ` ${location}` : ""} - ${diagnostic.message}`);
    if (diagnostic.suggestion) lines.push(`  Suggestion: ${diagnostic.suggestion}`);
  }

  if (result.skipped.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Not scanned:");
    for (const entry of result.skipped) lines.push(`  ${entry.path} (${entry.reason})`);
  }

  if (lines.length > 0) lines.push("");
  const files = `${result.filesScanned} ${result.filesScanned === 1 ? "file" : "files"}`;
  if (result.diagnostics.length === 0) {
    lines.push(`No issues found in ${files}.`);
  } else {
    lines.push(
      `Found ${plural(counts.errors, "error")}, ${plural(counts.warnings, "warning")} and ${counts.infos} info in ${files}.`,
    );
  }
  if (strict && counts.errors === 0 && counts.warnings > 0 && exitCode !== 0) {
    lines.push("Strict mode: warnings cause a non-zero exit code.");
  }

  return `${lines.map(sanitizeForOutput).join("\n")}\n`;
}

function formatLocation(diagnostic: Diagnostic): string {
  if (diagnostic.file === undefined) return "";
  if (diagnostic.line === undefined) return diagnostic.file;
  return diagnostic.column === undefined
    ? `${diagnostic.file}:${diagnostic.line}`
    : `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
