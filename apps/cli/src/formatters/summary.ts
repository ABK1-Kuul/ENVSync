import type { Diagnostic } from "@envsync-internal/core";

/** ENV006 count: places where variables are read dynamically and therefore not checked. */
export function countDynamicAccesses(diagnostics: readonly Diagnostic[]): number {
  return diagnostics.filter((diagnostic) => diagnostic.code === "ENV006").length;
}
