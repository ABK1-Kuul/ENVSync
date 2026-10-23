import { isUnsafeCodePoint } from "@envsync-internal/core";

/**
 * Makes repository-controlled text inert for display: control, invisible and bidi characters
 * become `\uXXXX` escapes (surrogate-pair escapes above U+FFFF, which are also valid JSON).
 * Newlines are escaped too, so a crafted file or variable name cannot fake extra output lines.
 * Apply it per output line, after the line is assembled.
 */
export function sanitizeForOutput(text: string): string {
  return escapeUnsafe(text, false);
}

/** For a complete JSON document: keeps its structural newlines; string contents are already escaped by JSON.stringify. */
export function sanitizeJsonDocument(json: string): string {
  return escapeUnsafe(json, true);
}

function escapeUnsafe(text: string, allowNewline: boolean): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (!isUnsafeCodePoint(code, { allowNewline })) {
      out += char;
    } else if (code > 0xffff) {
      for (let i = 0; i < char.length; i++) out += `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`;
    } else {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}
