import type { DoctorCheck } from "@envsync-internal/core";
import { JSON_SCHEMA_VERSION } from "./json.js";
import { sanitizeForOutput } from "./sanitize.js";

export type DoctorCounts = { pass: number; warn: number; fail: number; skip: number };

export function countChecks(checks: readonly DoctorCheck[]): DoctorCounts {
  const counts: DoctorCounts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) counts[check.status]++;
  return counts;
}

export function formatDoctorTerminal(checks: readonly DoctorCheck[], counts: DoctorCounts): string {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${check.status.toUpperCase().padEnd(4)}  ${check.id}: ${check.message}`);
    if (check.suggestion && check.status !== "pass") lines.push(`      Suggestion: ${check.suggestion}`);
  }
  lines.push(
    "",
    `Doctor: ${counts.fail} ${counts.fail === 1 ? "failure" : "failures"}, ${counts.warn} ${counts.warn === 1 ? "warning" : "warnings"}, ${counts.pass} passed${counts.skip > 0 ? `, ${counts.skip} skipped` : ""}.`,
  );
  return `${lines.map(sanitizeForOutput).join("\n")}\n`;
}

export function formatDoctorJson(checks: readonly DoctorCheck[], counts: DoctorCounts, exitCode: number): string {
  const output = {
    schemaVersion: JSON_SCHEMA_VERSION,
    summary: { ...counts, exitCode },
    checks: checks.map((check) => ({
      id: check.id,
      status: check.status,
      message: check.message,
      ...(check.suggestion !== undefined ? { suggestion: check.suggestion } : {}),
    })),
  };
  return `${sanitizeForOutput(JSON.stringify(output, null, 2))}\n`;
}
