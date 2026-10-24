import type { DoctorCheck } from "@envsync-internal/core";
import { JSON_SCHEMA_VERSION } from "./json.js";
import { sanitizeForOutput, sanitizeJsonDocument } from "./sanitize.js";

export type DoctorCounts = { pass: number; warn: number; fail: number; unknown: number; skip: number };

export function countChecks(checks: readonly DoctorCheck[]): DoctorCounts {
  const counts: DoctorCounts = { pass: 0, warn: 0, fail: 0, unknown: 0, skip: 0 };
  for (const check of checks) counts[check.status]++;
  return counts;
}

export function formatDoctorTerminal(checks: readonly DoctorCheck[], counts: DoctorCounts, strict: boolean): string {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${check.status.toUpperCase().padEnd(7)}  ${check.id}: ${check.message}`);
    if (check.suggestion && check.status !== "pass") lines.push(`         Suggestion: ${check.suggestion}`);
  }
  const parts = [
    `${counts.fail} ${counts.fail === 1 ? "failure" : "failures"}`,
    `${counts.warn} ${counts.warn === 1 ? "warning" : "warnings"}`,
    ...(counts.unknown > 0 ? [`${counts.unknown} unknown`] : []),
    `${counts.pass} passed`,
    ...(counts.skip > 0 ? [`${counts.skip} skipped`] : []),
  ];
  lines.push("", `Doctor: ${parts.join(", ")}.`);
  if (counts.unknown > 0) lines.push("Unknown means EnvSync could not establish the result; treat it as unverified, not as a pass.");
  if (strict && counts.fail === 0 && counts.warn + counts.unknown > 0) {
    lines.push("Strict mode: warnings and unknown results cause a non-zero exit code.");
  }
  return `${lines.map(sanitizeForOutput).join("\n")}\n`;
}

export function formatDoctorJson(checks: readonly DoctorCheck[], counts: DoctorCounts, strict: boolean, exitCode: number): string {
  const output = {
    schemaVersion: JSON_SCHEMA_VERSION,
    summary: { ...counts, strict, exitCode },
    checks: checks.map((check) => ({
      id: check.id,
      status: check.status,
      message: check.message,
      ...(check.suggestion !== undefined ? { suggestion: check.suggestion } : {}),
    })),
  };
  return `${sanitizeJsonDocument(JSON.stringify(output, null, 2))}\n`;
}
