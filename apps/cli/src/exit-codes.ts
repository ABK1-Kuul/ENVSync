import type { SeverityCounts } from "@envsync-internal/core";

/** Documented in docs/CLI.md. Changing these is a breaking change for CI users. */
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;

/**
 * Errors always fail. With `strict`, warnings fail and so does an incomplete scan (any path that
 * was not scanned): strict mode must never report success for files it did not check.
 * Info never fails.
 */
export function exitCodeFor(counts: SeverityCounts, strict: boolean, complete: boolean): number {
  if (counts.errors > 0) return EXIT_FINDINGS;
  if (strict && (counts.warnings > 0 || !complete)) return EXIT_FINDINGS;
  return EXIT_OK;
}
