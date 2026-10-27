import { applyEnvEdit, type EnvEdit, type TextReplacement } from "@envsync-internal/env-edit";
import type { ParsedConfig } from "@envsync-internal/schema";
import { isSafeToDisplay } from "./model.js";

/**
 * Turns a table edit into a text replacement, or explains why not. An edit made against an older
 * version of the document (the file changed after the table was drawn, in another editor or on disk)
 * is rejected rather than merged, so it can never overwrite a change the user has not seen.
 */

export type EditDecision =
  | { kind: "apply"; replacement: TextReplacement; label: string }
  | { kind: "conflict" }
  | { kind: "refused"; reason: string };

export function decideEdit(documentText: string, documentVersion: number, requestVersion: number, edit: EnvEdit): EditDecision {
  if (requestVersion !== documentVersion) return { kind: "conflict" };
  const result = applyEnvEdit(documentText, edit);
  if (!result.ok) return { kind: "refused", reason: result.reason };
  if (result.replacement.start === result.replacement.end && result.replacement.text === "") {
    return { kind: "refused", reason: "Nothing to change." };
  }
  return { kind: "apply", replacement: result.replacement, label: describeEdit(edit) };
}

/**
 * How an edit is shown before it is applied. A diff displays the whole file before and after the
 * change, so it is used only when both versions are safe to display in full (see
 * `isSafeToDisplay`); otherwise the confirmation names the change and shows no values.
 */
export function confirmationMode(beforeText: string, afterText: string, config: ParsedConfig | null): "diff" | "dialog" {
  return isSafeToDisplay(beforeText, config) && isSafeToDisplay(afterText, config) ? "diff" : "dialog";
}

// Shown in VS Code's edit preview; names only, never values.
export function describeEdit(edit: EnvEdit): string {
  switch (edit.kind) {
    case "set":
      return `EnvSync: change the value of ${edit.name}`;
    case "add":
      return `EnvSync: add ${edit.name}`;
    case "rename":
      return `EnvSync: rename ${edit.from} to ${edit.to}`;
    case "remove":
      return `EnvSync: remove ${edit.name}`;
  }
}
