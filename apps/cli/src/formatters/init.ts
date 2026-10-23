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
  if (plan.skippedNames.length > 0) {
    lines.push(`Note: ${plan.skippedNames.length} referenced name(s) are not valid variable names and were left out.`);
  }

  const pending = plan.changes.filter((change) => change.action !== "unchanged");
  if (written === null) {
    lines.push(pending.length === 0 ? "Nothing to change." : "Run `envsync init --write` to apply these changes.");
  } else {
    lines.push(written.length === 0 ? "Nothing to change." : `Wrote ${written.join(", ")}. Review the files before committing.`);
  }

  return `${lines.map(sanitizeForOutput).join("\n")}\n`;
}
