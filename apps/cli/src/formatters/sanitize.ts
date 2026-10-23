// Characters a hostile repository could smuggle in through file or variable names to rewrite the
// terminal (ANSI/C1 control sequences) or visually reorder text (Unicode bidi overrides).
// Newlines are excluded because formatters add them structurally.
const UNSAFE_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;

function escapeCharacter(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/** Makes repository-controlled text inert for display. Also valid inside JSON strings. */
export function sanitizeForOutput(text: string): string {
  return text.replace(UNSAFE_CHARACTERS, escapeCharacter);
}
