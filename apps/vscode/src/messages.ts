import type { EnvEdit } from "@envsync-internal/env-edit";

/**
 * Messages from the table webview. The webview renders file content, so its messages are validated
 * like any other untrusted input before the extension acts on them.
 */

export type WebviewMessage =
  | { type: "ready" }
  | { type: "edit"; version: number; edit: EnvEdit }
  | { type: "reveal"; version: number; name: string }
  | { type: "openText" };

const MAX_TEXT = 100_000;

export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.type) {
    case "ready":
    case "openText":
      return { type: raw.type };
    case "reveal":
      return isVersion(raw.version) && isText(raw.name) ? { type: "reveal", version: raw.version, name: raw.name } : undefined;
    case "edit": {
      const edit = parseEdit(raw.edit);
      return isVersion(raw.version) && edit !== undefined ? { type: "edit", version: raw.version, edit } : undefined;
    }
    default:
      return undefined;
  }
}

function parseEdit(raw: unknown): EnvEdit | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.kind) {
    case "set":
    case "add":
      return isText(raw.name) && isText(raw.value, true) ? { kind: raw.kind, name: raw.name, value: raw.value } : undefined;
    case "rename":
      return isText(raw.from) && isText(raw.to) ? { kind: "rename", from: raw.from, to: raw.to } : undefined;
    case "remove":
      return isText(raw.name) ? { kind: "remove", name: raw.name } : undefined;
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isText(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT && (allowEmpty || value.length > 0);
}
