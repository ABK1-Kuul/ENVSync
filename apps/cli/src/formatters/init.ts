import type { InitPlan } from "@envsync-internal/core";
import { sanitizeForOutput } from "./sanitize.js";

/** Shows exactly what `init` would write. Existing file contents are never displayed. */
export function formatInitPlan(plan: InitPlan, written: readonly string[] | null): string {
  const lines: string[] = [written === null ? "EnvSync init preview (no files were written)" : "EnvSync init", ""];

  for (const change of plan.changes) {
    if (change.action === "unchanged") {
      lines.push(`Unchanged ${change.path}: ${change.reason}`, "");
      continue;
    }
    if (change.action === "blocked") {
      lines.push(`Cannot update ${change.path}: ${change.reason}`, "");
      continue;
    }
    const heading =
      change.action === "create"
        ? `Create ${change.path}:`
        : `Append ${plan.exampleAdditions.length} ${plan.exampleAdditions.length === 1 ? "entry" : "entries"} to ${change.path} (existing lines are kept as they are):`;
    lines.push(heading);
    for (const line of change.content.replace(/\r?\n$/, "").split(/\r?\n/)) lines.push(`  | ${line}`);
    lines.push("");
  }

  if (plan.configIssueCount > 0) {
    lines.push(`Note: the existing config has ${plan.configIssueCount} problem(s). Run \`envsync scan\` to see them.`);
  }
  if (plan.dynamicAccessCount > 0) {
    lines.push(
      `Note: ${plan.dynamicAccessCount} dynamic process.env ${plan.dynamicAccessCount === 1 ? "access" : "accesses"} could not be resolved to names; declare those variables by hand.`,
    );
  }
  if (plan.notScanned > 0) {
    lines.push(
      `Note: ${plan.notScanned} ${plan.notScanned === 1 ? "path was" : "paths were"} not scanned (run \`envsync scan\` to list them), so some variables may be missing from this plan.`,
    );
  }
  if (plan.skippedNames.length > 0) {
    lines.push(`Note: ${plan.skippedNames.length} referenced name(s) are not valid variable names and were left out.`);
  }
  for (const group of plan.caseCollisions) {
    lines.push(`Note: ${group.join(" and ")} differ only by letter case; \`envsync scan\` reports this (ENV007) because they collide on Windows.`);
  }

  const blocked = plan.changes.some((change) => change.action === "blocked");
  const pending = plan.changes.filter((change) => change.action === "create" || change.action === "append");
  if (written === null) {
    lines.push(
      blocked
        ? "Fix the problem above, then run `envsync init` again. `--write` will refuse to change anything until then."
        : pending.length === 0
          ? "Nothing to change."
          : "Run `envsync init --write` to apply these changes. Files are checked again when writing.",
    );
  } else {
    lines.push(written.length === 0 ? "Nothing to change." : `Wrote ${written.join(", ")}. Review the files before committing.`);
  }

  return `${lines.map(sanitizeForOutput).join("\n")}\n`;
}
