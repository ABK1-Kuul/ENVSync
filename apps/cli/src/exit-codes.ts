import type { SeverityCounts } from "@envsync-internal/core";

/** Documented in docs/CLI.md. Changing these is a breaking change for CI users. */
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;

/** Errors always fail. Warnings fail only in strict mode. Info never fails. */
export function exitCodeFor(counts: SeverityCounts, strict: boolean): number {
  if (counts.errors > 0) return EXIT_FINDINGS;
  if (strict && counts.warnings > 0) return EXIT_FINDINGS;
  return EXIT_OK;
}
