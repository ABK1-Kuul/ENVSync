import { isValidVariableName, parseEnvAssignments, parseEnvFile, type EnvAssignment } from "@envsync-internal/schema";

/**
 * Format-preserving edits to env files (`.env`, `.env.local`, ...), for editors.
 *
 * Only the lines of the assignment being changed are rewritten; comments, blank lines, ordering,
 * `export` prefixes, indentation, separators, inline comments, line endings and a byte-order mark
 * are kept. Every result is re-parsed and checked: the edited variable must read back exactly as
 * intended and every other variable must keep its value. Anything that cannot be written safely is
 * refused with a reason, never approximated. Pure: no I/O.
 */

export type EnvEdit =
  | { kind: "set"; name: string; value: string }
  | { kind: "add"; name: string; value: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "remove"; name: string };

/** Replace `text.slice(start, end)` with `text`, as a single minimal change. */
export type TextReplacement = { start: number; end: number; text: string };

export type EnvEditResult = { ok: true; text: string; replacement: TextReplacement } | { ok: false; reason: string };

export function applyEnvEdit(original: string, edit: EnvEdit): EnvEditResult {
  const document = splitDocument(original);
  const { assignments } = parseEnvAssignments(original);
  const named = (name: string) => assignments.filter((assignment) => assignment.name === name);

  // Next.js expands `$NAME` / `${NAME}`, and whether quoting prevents it depends on its version, so
  // a written value containing `$` might not read back as typed. Edit those as text.
  if ((edit.kind === "set" || edit.kind === "add") && edit.value.includes("$")) {
    return refuse("Values containing `$` can be read as references to other variables; edit this one as text.");
  }
  const touched = edit.kind === "rename" ? edit.from : edit.kind === "add" ? undefined : edit.name;
  if (touched !== undefined) {
    // An unquoted key block spans lines by EnvSync's reading only; dotenv reads just its first line.
    if (named(touched).some((assignment) => assignment.quote === undefined && assignment.endLine > assignment.line)) {
      return refuse(`${describe(touched)} spans an unquoted multi-line block; edit it as text.`);
    }
    // Renaming or removing a variable that others reference would silently change their values.
    if (edit.kind !== "set" && isReferenced(touched, assignments)) {
      return refuse(`${describe(touched)} is referenced by another variable (as $${describe(touched)}); edit as text.`);
    }
  }

  let edited: Document;
  switch (edit.kind) {
    case "set": {
      const targets = named(edit.name);
      const target = targets[targets.length - 1]; // the assignment that takes effect
      if (target === undefined) return refuse(`${describe(edit.name)} is not set in this file.`);
      const line = rewriteValue(document, target, edit.value);
      if (typeof line !== "string") return line;
      edited = replaceLines(document, target.line, target.endLine, [line]);
      break;
    }
    case "add": {
      if (!isValidVariableName(edit.name)) return refuse("Use letters, digits and underscores only, not starting with a digit.");
      if (named(edit.name).length > 0) return refuse(`${edit.name} is already set in this file.`);
      const value = serializeValue(edit.value);
      if (value === undefined) return unrepresentable();
      edited = appendLine(document, `${edit.name}=${value}`);
      break;
    }
    case "rename": {
      if (!isValidVariableName(edit.to)) return refuse("Use letters, digits and underscores only, not starting with a digit.");
      const targets = named(edit.from);
      if (targets.length === 0) return refuse(`${describe(edit.from)} is not set in this file.`);
      if (edit.to !== edit.from && named(edit.to).length > 0) return refuse(`${edit.to} is already set in this file.`);
      edited = document;
      for (const target of targets) {
        const first = edited.lines[target.line - 1] as string;
        const match = ASSIGNMENT_PREFIX.exec(first);
        if (match === null || match[2] !== edit.from) return refuse("This line cannot be edited safely; edit the raw text instead.");
        const renamed = `${match[1]}${edit.to}${first.slice((match[1] as string).length + edit.from.length)}`;
        edited = replaceLines(edited, target.line, target.line, [renamed]);
      }
      break;
    }
    case "remove": {
      const targets = named(edit.name);
      if (targets.length === 0) return refuse(`${describe(edit.name)} is not set in this file.`);
      edited = document;
      // Bottom-up, so earlier line numbers stay valid.
      for (const target of [...targets].reverse()) edited = replaceLines(edited, target.line, target.endLine, []);
      break;
    }
  }

  const text = joinDocument(edited);
  const problem = verify(original, text, edit);
  if (problem !== undefined) return refuse(problem);
  return { ok: true, text, replacement: minimalReplacement(original, text) };
}

/**
 * A value as it would be written after `NAME=`, or `undefined` if it cannot be represented so that
 * dotenv (and Next.js's variable expansion) reads back exactly the same text.
 */
export function serializeValue(value: string): string | undefined {
  if (value === "") return "";
  const multiLine = /[\r\n]/.test(value);
  const expandable = value.includes("$"); // Next.js expands $VAR in unquoted and double-quoted values
  const plain =
    !multiLine &&
    !expandable &&
    /^[^\s'"`#][^#\s]*$/.test(value) && // anything with blanks is quoted, for readability and other tools
    !value.startsWith("-----BEGIN "); // an unquoted PEM header starts a key block
  if (plain) return value;
  if (!multiLine && !value.includes("'")) return `'${value}'`;
  if (!expandable && !value.includes('"') && !value.includes("\\")) return `"${value.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
  if (!multiLine && !value.includes("`")) return `\`${value}\``;
  return undefined;
}

// Indentation, optional `export`, the name, and the separator (`=` or `: `) with its blanks.
const ASSIGNMENT_PREFIX = /^(\s*(?:export[ \t]+)?)([\w.-]+)([ \t]*(?:=|:[ \t])[ \t]*)/;

function rewriteValue(document: Document, target: EnvAssignment, value: string): string | Extract<EnvEditResult, { ok: false }> {
  const serialized = serializeValue(value);
  if (serialized === undefined) return unrepresentable();
  const first = document.lines[target.line - 1] as string;
  const match = ASSIGNMENT_PREFIX.exec(first);
  if (match === null || match[2] !== target.name) return refuse("This line cannot be edited safely; edit the raw text instead.");
  const prefix = match[0];
  // Keep the inline comment: on the same line for a one-line value, or after the closing quote of a
  // multi-line one.
  const suffix =
    target.line === target.endLine
      ? inlineComment(first.slice(prefix.length))
      : closingLineComment(document.lines[target.endLine - 1] as string, target.quote);
  return `${prefix}${serialized}${suffix}`;
}

/** The ` # comment` after the closing quote on the last line of a multi-line quoted value, or "". */
function closingLineComment(lastLine: string, quote: string | undefined): string {
  if (quote === undefined) return "";
  for (let i = 0; i < lastLine.length; i++) {
    if (quote === '"' && lastLine[i] === "\\" && lastLine[i + 1] === quote) i++;
    else if (lastLine[i] === quote) {
      const after = lastLine.slice(i + 1);
      return /^\s*#/.test(after) ? after : "";
    }
  }
  return "";
}

/** Whether any other assignment's value refers to `name` as `$NAME` or `${NAME}`. */
function isReferenced(name: string, assignments: readonly EnvAssignment[]): boolean {
  const reference = new RegExp(`\\$(?:\\{${escapeRegExp(name)}[}:\\-+?]|${escapeRegExp(name)}(?![\\w]))`);
  return assignments.some((assignment) => assignment.name !== name && reference.test(assignment.value));
}

function escapeRegExp(text: string): string {
  // `$&` deliberately inserts the matched character after a backslash.
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The trailing ` # comment` after a single-line value (with the blanks before it), or "". */
function inlineComment(rest: string): string {
  const quote = rest[0];
  if (quote === "'" || quote === '"' || quote === "`") {
    for (let i = 1; i < rest.length; i++) {
      if (quote === '"' && rest[i] === "\\" && rest[i + 1] === quote) i++;
      else if (rest[i] === quote) {
        const after = rest.slice(i + 1);
        return /^\s*(#.*)?$/.test(after) ? after.replace(/^\s*$/, "") : "";
      }
    }
    return "";
  }
  const hash = rest.indexOf("#");
  if (hash < 0) return "";
  const blanks = /\s*$/.exec(rest.slice(0, hash))?.[0] ?? "";
  return `${blanks === "" ? " " : blanks}${rest.slice(hash)}`;
}

/** The edited variable reads back as intended, and nothing else changed meaning. */
function verify(before: string, after: string, edit: EnvEdit): string | undefined {
  const old = valuesByName(before);
  const now = valuesByName(after);
  const expected = new Map(old);
  switch (edit.kind) {
    case "set":
    case "add":
      expected.set(edit.name, edit.value);
      break;
    case "rename": {
      const value = old.get(edit.from) as string;
      expected.delete(edit.from);
      expected.set(edit.to, value);
      break;
    }
    case "remove":
      expected.delete(edit.name);
      break;
  }
  if (now.size !== expected.size) return "The edit would change other variables; edit the raw text instead.";
  for (const [name, value] of expected) {
    if (now.get(name) !== value) {
      return touches(edit, name)
        ? "This value cannot be written back exactly; edit the raw text instead."
        : "The edit would change other variables; edit the raw text instead.";
    }
  }
  return undefined;
}

function valuesByName(text: string): Map<string, string> {
  return new Map(parseEnvFile(text).entries.map(({ name, value }) => [name, value]));
}

function touches(edit: EnvEdit, name: string): boolean {
  return edit.kind === "rename" ? name === edit.to || name === edit.from : name === edit.name;
}

function refuse(reason: string): Extract<EnvEditResult, { ok: false }> {
  return { ok: false, reason };
}

function unrepresentable(): Extract<EnvEditResult, { ok: false }> {
  return refuse("This value mixes quotes, line breaks and `$` in a way an env file cannot hold exactly; edit the raw text instead.");
}

// Names come from the user's own file; keep messages short and never include values.
function describe(name: string): string {
  return isValidVariableName(name) ? name : "This variable";
}

// --- Line-preserving document model -------------------------------------------------------------

type Document = { bom: string; lines: string[]; breaks: string[]; newline: string };

/** Lines and the exact line break after each (`\r\n`, `\n`, `\r`, or "" for the last line). */
function splitDocument(text: string): Document {
  const bom = text.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const parts = text.slice(bom.length).split(/(\r\n|\n|\r)/);
  const lines: string[] = [];
  const breaks: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i] as string);
    breaks.push(parts[i + 1] ?? "");
  }
  const newline = breaks.find((value) => value !== "") ?? "\n";
  return { bom, lines, breaks, newline };
}

function joinDocument(document: Document): string {
  let text = document.bom;
  document.lines.forEach((line, index) => {
    text += line + (document.breaks[index] as string);
  });
  return text;
}

/** Replaces lines `from..to` (1-based, inclusive); the line break after `to` is kept. */
function replaceLines(document: Document, from: number, to: number, replacement: string[]): Document {
  const lines = [...document.lines];
  const breaks = [...document.breaks];
  const lastBreak = breaks[to - 1] as string;
  const newBreaks = replacement.map((_, index) => (index === replacement.length - 1 ? lastBreak : document.newline));
  if (replacement.length === 0) {
    // Removing the final line: drop the break that ended the line before it instead.
    if (to === lines.length && from > 1) {
      lines.splice(from - 1, to - from + 1);
      breaks.splice(from - 1, to - from + 1);
      breaks[from - 2] = lastBreak;
      return { ...document, lines, breaks };
    }
  }
  lines.splice(from - 1, to - from + 1, ...replacement);
  breaks.splice(from - 1, to - from + 1, ...newBreaks);
  if (lines.length === 0) return { ...document, lines: [""], breaks: [""] };
  return { ...document, lines, breaks };
}

/**
 * Adds a line at the end. A file that ends with a line break (or is empty) keeps ending with one;
 * a file without a final line break gets one before the new line and none after it.
 */
function appendLine(document: Document, line: string): Document {
  const lines = [...document.lines];
  const breaks = [...document.breaks];
  const last = lines.length - 1;
  if (lines[last] === "") {
    lines.splice(last, 1, line, "");
    breaks.splice(last, 1, document.newline, "");
  } else {
    breaks[last] = document.newline;
    lines.push(line);
    breaks.push("");
  }
  return { ...document, lines, breaks };
}

/** The smallest single replacement that turns `before` into `after` (common prefix and suffix kept). */
export function minimalReplacement(before: string, after: string): TextReplacement {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return { start, end: endBefore, text: after.slice(start, endAfter) };
}
