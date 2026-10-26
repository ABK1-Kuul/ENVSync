import type { Diagnostic, ScanResult, SeverityCounts } from "@envsync-internal/core";
import { sanitizeForOutput } from "./sanitize.js";
import { countDynamicAccesses } from "./summary.js";

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
    // Present only with --show-values, redacted unless the value is a malformed, non-private one (ADR-016).
    // Sanitized with the rest of the line, so newlines in a value are escaped.
    if (diagnostic.value !== undefined) lines.push(`  Value: ${diagnostic.value}`);
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
  if (result.envFiles.length > 0) {
    lines.push(`Env files read: ${result.envFiles.join(", ")}. Environment: ${result.envContext}.`);
  }
  if (!result.complete) {
    // A clean result must not look complete when some paths were never read.
    const stoppedAtLimit = result.skipped.some((entry) => entry.reason === "limit-reached");
    lines.push(
      stoppedAtLimit
        ? `Scan incomplete: scanning stopped at a limit, so at least ${plural(result.skipped.length, "path")} (listed above) and possibly many more were not scanned; findings may be missing.`
        : `Scan incomplete: ${plural(result.skipped.length, "path")} not scanned (listed above), so findings may be missing.`,
    );
  }
  const dynamic = countDynamicAccesses(result.diagnostics);
  if (dynamic > 0) {
    // Not a failure (a limit of static analysis), but never hidden: those reads were not checked.
    lines.push(`Dynamic process.env access in ${plural(dynamic, "place")} (ENV006): variables read there were not checked.`);
  }
  if (strict && counts.errors === 0 && exitCode !== 0) {
    if (counts.warnings > 0) lines.push("Strict mode: warnings cause a non-zero exit code.");
    if (!result.complete) lines.push("Strict mode: an incomplete scan causes a non-zero exit code.");
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
