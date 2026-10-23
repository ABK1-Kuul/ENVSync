// Characters a hostile repository could smuggle in through file or variable names to rewrite the
// terminal (ANSI/C1 control sequences) or visually reorder text (Unicode bidi overrides).
// Expressed as numeric code points so no invisible characters live in this source file.
// Newlines are kept because formatters add them structurally.
function isUnsafe(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Makes repository-controlled text inert for display. Also valid inside JSON strings. */
export function sanitizeForOutput(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    out += isUnsafe(code) ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }
  return out;
}
