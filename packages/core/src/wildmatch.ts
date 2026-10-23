/**
 * Git-compatible wildmatch for `.gitignore` patterns (the `WM_PATHNAME` mode git uses for ignore
 * rules), implemented without regular expressions.
 *
 * Patterns are compiled to tokens and matched by tracking the set of reachable text positions, so
 * each token costs O(text length): matching is O(pattern × text) for any input, and hostile
 * patterns such as `*a*a*a*a*b` cannot cause catastrophic backtracking.
 *
 * Semantics follow git's wildmatch.c:
 * - `?` and `*` never match `/`; `[...]` classes never match `/`.
 * - `**` is special only as a whole path segment: leading `**\/`, trailing `/**`, or `/**\/`.
 *   Elsewhere it behaves like `*`.
 * - Classes support ranges, `!`/`^` negation, a leading `]` as a literal, backslash escapes and
 *   POSIX classes like `[:alpha:]`. An unterminated class or invalid POSIX class makes the whole
 *   pattern match nothing, as in git.
 * - A trailing unescaped backslash makes the pattern match nothing.
 */

type ClassItem = { from: string; to: string } | { posix: PosixClass };
type PosixClass = "alnum" | "alpha" | "blank" | "cntrl" | "digit" | "graph" | "lower" | "print" | "punct" | "space" | "upper" | "xdigit";

type Token =
  | { kind: "literal"; char: string }
  | { kind: "any" } // ?
  | { kind: "star" } // * within one segment
  | { kind: "class"; negated: boolean; items: ClassItem[] }
  | { kind: "dirs" } // `**/`: zero or more whole directories ("", "a/", "a/b/", ...)
  | { kind: "rest" }; // `/**` tail: one or more characters of anything

export type CompiledPattern = { tokens: Token[]; matchesNothing: boolean; ignoreCase: boolean };

const POSIX_CLASSES = new Set<string>(["alnum", "alpha", "blank", "cntrl", "digit", "graph", "lower", "print", "punct", "space", "upper", "xdigit"]);

export function compileWildmatch(pattern: string, ignoreCase: boolean): CompiledPattern {
  const tokens: Token[] = [];
  const nothing = { tokens: [], matchesNothing: true, ignoreCase };
  const chars = Array.from(pattern);
  let i = 0;

  while (i < chars.length) {
    const char = chars[i] as string;
    if (char === "\\") {
      if (i + 1 >= chars.length) return nothing;
      tokens.push({ kind: "literal", char: chars[i + 1] as string });
      i += 2;
    } else if (char === "?") {
      tokens.push({ kind: "any" });
      i++;
    } else if (char === "*") {
      let end = i;
      while (chars[end] === "*") end++;
      const starCount = end - i;
      const atSegmentStart = i === 0 || chars[i - 1] === "/";
      const atSegmentEnd = end === chars.length || chars[end] === "/";
      if (starCount >= 2 && atSegmentStart && atSegmentEnd) {
        if (end === chars.length) {
          // `**` at the very end: after a `/` it means "everything inside"; alone it matches anything.
          tokens.push(i === 0 ? { kind: "dirs" } : { kind: "rest" });
          if (i === 0) tokens.push({ kind: "rest" });
          i = end;
        } else {
          // `**/` (leading or after `/`): zero or more directories.
          tokens.push({ kind: "dirs" });
          i = end + 1;
        }
      } else {
        tokens.push({ kind: "star" });
        i = end;
      }
    } else if (char === "[") {
      const parsed = parseClass(chars, i);
      if (parsed === null) return nothing;
      tokens.push(parsed.token);
      i = parsed.next;
    } else {
      tokens.push({ kind: "literal", char });
      i++;
    }
  }
  return { tokens: collapse(tokens), matchesNothing: false, ignoreCase };
}

/** Whether `text` (a `/`-separated relative path or a base name) matches the compiled pattern. */
export function wildmatch(compiled: CompiledPattern, text: string): boolean {
  if (compiled.matchesNothing) return false;
  const chars = Array.from(compiled.ignoreCase ? text.toLowerCase() : text);
  const n = chars.length;
  let reachable = new Uint8Array(n + 1);
  reachable[0] = 1;

  for (const token of compiled.tokens) {
    const next = new Uint8Array(n + 1);
    switch (token.kind) {
      case "literal": {
        const expected = compiled.ignoreCase ? token.char.toLowerCase() : token.char;
        for (let p = 0; p < n; p++) if (reachable[p] && chars[p] === expected) next[p + 1] = 1;
        break;
      }
      case "any":
        for (let p = 0; p < n; p++) if (reachable[p] && chars[p] !== "/") next[p + 1] = 1;
        break;
      case "class":
        for (let p = 0; p < n; p++) {
          if (reachable[p] && chars[p] !== "/" && classMatches(token, chars[p] as string, compiled.ignoreCase)) next[p + 1] = 1;
        }
        break;
      case "star": {
        // Reachable from any earlier reachable position without crossing a `/`.
        let open = false;
        for (let p = 0; p <= n; p++) {
          if (reachable[p]) open = true;
          if (open) next[p] = 1;
          if (chars[p] === "/") open = false;
        }
        break;
      }
      case "dirs": {
        // Zero directories, or any number of whole `segment/` groups.
        let seen = false;
        for (let p = 0; p <= n; p++) {
          if (reachable[p]) {
            seen = true;
            next[p] = 1;
          }
          if (seen && p > 0 && chars[p - 1] === "/") next[p] = 1;
        }
        break;
      }
      case "rest": {
        // One or more characters of anything (used after a literal `/`).
        let seen = false;
        for (let p = 0; p <= n; p++) {
          if (seen) next[p] = 1;
          if (reachable[p]) seen = true;
        }
        break;
      }
    }
    reachable = next;
  }
  return reachable[n] === 1;
}

// Adjacent `*` tokens are equivalent to one; collapsing keeps token count proportional to meaning.
function collapse(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    if (token.kind === "star" && last?.kind === "star") continue;
    out.push(token);
  }
  return out;
}

function parseClass(chars: string[], start: number): { token: Token; next: number } | null {
  let i = start + 1;
  let negated = false;
  if (chars[i] === "!" || chars[i] === "^") {
    negated = true;
    i++;
  }
  const items: ClassItem[] = [];
  let first = true;
  while (i < chars.length) {
    let char = chars[i] as string;
    if (char === "]" && !first) return { token: { kind: "class", negated, items }, next: i + 1 };
    first = false;

    if (char === "[" && chars[i + 1] === ":") {
      const close = findPosixEnd(chars, i + 2);
      if (close === -1) {
        // Not a POSIX class after all: `[` is a literal member.
        items.push({ from: "[", to: "[" });
        i++;
        continue;
      }
      const name = chars.slice(i + 2, close).join("");
      if (!POSIX_CLASSES.has(name)) return null; // git: malformed class aborts the match
      items.push({ posix: name as PosixClass });
      i = close + 2;
      continue;
    }

    if (char === "\\") {
      i++;
      if (i >= chars.length) return null;
      char = chars[i] as string;
    }
    if (chars[i + 1] === "-" && chars[i + 2] !== undefined && chars[i + 2] !== "]") {
      let to = chars[i + 2] as string;
      let skip = 3;
      if (to === "\\") {
        if (chars[i + 3] === undefined) return null;
        to = chars[i + 3] as string;
        skip = 4;
      }
      items.push({ from: char, to });
      i += skip;
    } else {
      items.push({ from: char, to: char });
      i++;
    }
  }
  return null; // unterminated
}

function findPosixEnd(chars: string[], from: number): number {
  for (let i = from; i + 1 < chars.length; i++) {
    if (chars[i] === ":" && chars[i + 1] === "]") return i;
    if (chars[i] === "]") return -1;
  }
  return -1;
}

function classMatches(token: Extract<Token, { kind: "class" }>, char: string, ignoreCase: boolean): boolean {
  const candidates = ignoreCase ? [char, char.toLowerCase(), char.toUpperCase()] : [char];
  const hit = token.items.some((item) =>
    "posix" in item ? candidates.some((c) => posixMatches(item.posix, c)) : candidates.some((c) => c >= item.from && c <= item.to),
  );
  return hit !== token.negated;
}

function posixMatches(name: PosixClass, char: string): boolean {
  const code = char.codePointAt(0) as number;
  switch (name) {
    case "alnum":
      return /^[A-Za-z0-9]$/.test(char);
    case "alpha":
      return /^[A-Za-z]$/.test(char);
    case "blank":
      return char === " " || char === "\t";
    case "cntrl":
      return code < 0x20 || code === 0x7f;
    case "digit":
      return /^[0-9]$/.test(char);
    case "graph":
      return code > 0x20 && code < 0x7f;
    case "lower":
      return /^[a-z]$/.test(char);
    case "print":
      return code >= 0x20 && code < 0x7f;
    case "punct":
      return code > 0x20 && code < 0x7f && !/^[A-Za-z0-9]$/.test(char);
    case "space":
      return /^[ \t\n\v\f\r]$/.test(char);
    case "upper":
      return /^[A-Z]$/.test(char);
    case "xdigit":
      return /^[0-9A-Fa-f]$/.test(char);
  }
}
