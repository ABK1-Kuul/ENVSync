/**
 * Git-compatible wildmatch for `.gitignore` patterns (the `WM_PATHNAME` mode git uses for ignore
 * rules), implemented without regular expressions.
 *
 * Like git, it works on UTF-8 bytes, not characters: `?` matches one byte, classes compare byte
 * values, and case folding (`core.ignorecase`) applies to ASCII letters only.
 *
 * Patterns are compiled to tokens and matched by tracking the set of reachable byte positions, so
 * each token costs O(text length): matching is O(pattern × text) for any input, and hostile
 * patterns such as `*a*a*a*a*b` cannot cause catastrophic backtracking.
 *
 * Semantics follow git's wildmatch.c:
 * - `?`, `*` and `[...]` never match `/`.
 * - `**` is special only as a whole path segment: leading `**\/`, trailing `/**`, or `/**\/`.
 *   Elsewhere it behaves like `*`.
 * - Classes support ranges, `!`/`^` negation, a leading `]` as a literal, backslash escapes and
 *   POSIX classes like `[:alpha:]`. An unterminated class or invalid POSIX class makes the whole
 *   pattern match nothing, as in git.
 * - A trailing unescaped backslash makes the pattern match nothing.
 * Known deviation (documented): git strips a pattern's literal prefix before matching, which makes
 * e.g. `apps**\/x` also match `apps/web/x`; here it matches only within one segment, so this
 * rarely-used form errs towards "not ignored".
 */

type ClassItem = { from: number; to: number } | { posix: PosixClass };
type PosixClass = "alnum" | "alpha" | "blank" | "cntrl" | "digit" | "graph" | "lower" | "print" | "punct" | "space" | "upper" | "xdigit";

type Token =
  | { kind: "literal"; byte: number }
  | { kind: "any" } // ?
  | { kind: "star" } // * within one segment
  | { kind: "class"; negated: boolean; items: ClassItem[] }
  | { kind: "dirs" } // `**/`: zero or more whole directories ("", "a/", "a/b/", ...)
  | { kind: "rest" }; // `/**` tail: one or more bytes of anything

export type CompiledPattern = { tokens: Token[]; matchesNothing: boolean; ignoreCase: boolean };

const SLASH = 0x2f;
const STAR = 0x2a;
const QUESTION = 0x3f;
const BACKSLASH = 0x5c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COLON = 0x3a;
const BANG = 0x21;
const CARET = 0x5e;
const DASH = 0x2d;

const POSIX_CLASSES = new Set<string>(["alnum", "alpha", "blank", "cntrl", "digit", "graph", "lower", "print", "punct", "space", "upper", "xdigit"]);

export function compileWildmatch(pattern: string, ignoreCase: boolean): CompiledPattern {
  const tokens: Token[] = [];
  const nothing = { tokens: [], matchesNothing: true, ignoreCase };
  const bytes = Buffer.from(pattern, "utf8");
  let i = 0;

  while (i < bytes.length) {
    const byte = bytes[i] as number;
    if (byte === BACKSLASH) {
      if (i + 1 >= bytes.length) return nothing;
      tokens.push({ kind: "literal", byte: bytes[i + 1] as number });
      i += 2;
    } else if (byte === QUESTION) {
      tokens.push({ kind: "any" });
      i++;
    } else if (byte === STAR) {
      let end = i;
      while (bytes[end] === STAR) end++;
      const starCount = end - i;
      const atSegmentStart = i === 0 || bytes[i - 1] === SLASH;
      const atSegmentEnd = end === bytes.length || bytes[end] === SLASH;
      if (starCount >= 2 && atSegmentStart && atSegmentEnd) {
        if (end === bytes.length) {
          // `**` at the very end: after a `/` it means "everything inside"; alone it matches anything.
          if (i === 0) tokens.push({ kind: "dirs" });
          tokens.push({ kind: "rest" });
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
    } else if (byte === OPEN_BRACKET) {
      const parsed = parseClass(bytes, i);
      if (parsed === null) return nothing;
      tokens.push(parsed.token);
      i = parsed.next;
    } else {
      tokens.push({ kind: "literal", byte });
      i++;
    }
  }
  return { tokens: collapse(tokens), matchesNothing: false, ignoreCase };
}

/** Whether `text` (a `/`-separated relative path or a base name) matches the compiled pattern. */
export function wildmatch(compiled: CompiledPattern, text: string): boolean {
  if (compiled.matchesNothing) return false;
  const bytes = Buffer.from(text, "utf8");
  const n = bytes.length;
  const fold = (byte: number) => (compiled.ignoreCase ? foldAscii(byte) : byte);
  let reachable = new Uint8Array(n + 1);
  reachable[0] = 1;

  for (const token of compiled.tokens) {
    const next = new Uint8Array(n + 1);
    let any = false;
    switch (token.kind) {
      case "literal": {
        const expected = fold(token.byte);
        for (let p = 0; p < n; p++) {
          if (reachable[p] && fold(bytes[p] as number) === expected) next[p + 1] = 1;
        }
        break;
      }
      case "any":
        for (let p = 0; p < n; p++) if (reachable[p] && bytes[p] !== SLASH) next[p + 1] = 1;
        break;
      case "class":
        for (let p = 0; p < n; p++) {
          if (reachable[p] && bytes[p] !== SLASH && classMatches(token, bytes[p] as number, compiled.ignoreCase)) next[p + 1] = 1;
        }
        break;
      case "star": {
        // Reachable from any earlier reachable position without crossing a `/`.
        let open = false;
        for (let p = 0; p <= n; p++) {
          if (reachable[p]) open = true;
          if (open) next[p] = 1;
          if (bytes[p] === SLASH) open = false;
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
          if (seen && p > 0 && bytes[p - 1] === SLASH) next[p] = 1;
        }
        break;
      }
      case "rest": {
        // One or more bytes of anything (used after a literal `/`).
        let seen = false;
        for (let p = 0; p <= n; p++) {
          if (seen) next[p] = 1;
          if (reachable[p]) seen = true;
        }
        break;
      }
    }
    for (let p = 0; p <= n && !any; p++) any = next[p] === 1;
    if (!any) return false; // nothing reachable: no later token can match
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

function parseClass(bytes: Buffer, start: number): { token: Token; next: number } | null {
  let i = start + 1;
  let negated = false;
  if (bytes[i] === BANG || bytes[i] === CARET) {
    negated = true;
    i++;
  }
  const items: ClassItem[] = [];
  let first = true;
  while (i < bytes.length) {
    let byte = bytes[i] as number;
    if (byte === CLOSE_BRACKET && !first) return { token: { kind: "class", negated, items }, next: i + 1 };
    first = false;

    if (byte === OPEN_BRACKET && bytes[i + 1] === COLON) {
      const close = findPosixEnd(bytes, i + 2);
      if (close === -1) {
        // Not a POSIX class after all: `[` is a literal member.
        items.push({ from: OPEN_BRACKET, to: OPEN_BRACKET });
        i++;
        continue;
      }
      const name = bytes.toString("latin1", i + 2, close);
      if (!POSIX_CLASSES.has(name)) return null; // git: malformed class aborts the match
      items.push({ posix: name as PosixClass });
      i = close + 2;
      continue;
    }

    if (byte === BACKSLASH) {
      i++;
      if (i >= bytes.length) return null;
      byte = bytes[i] as number;
    }
    if (bytes[i + 1] === DASH && bytes[i + 2] !== undefined && bytes[i + 2] !== CLOSE_BRACKET) {
      let to = bytes[i + 2] as number;
      let skip = 3;
      if (to === BACKSLASH) {
        if (bytes[i + 3] === undefined) return null;
        to = bytes[i + 3] as number;
        skip = 4;
      }
      items.push({ from: byte, to });
      i += skip;
    } else {
      items.push({ from: byte, to: byte });
      i++;
    }
  }
  return null; // unterminated
}

function findPosixEnd(bytes: Buffer, from: number): number {
  for (let i = from; i + 1 < bytes.length; i++) {
    if (bytes[i] === COLON && bytes[i + 1] === CLOSE_BRACKET) return i;
    if (bytes[i] === CLOSE_BRACKET) return -1;
  }
  return -1;
}

function classMatches(token: Extract<Token, { kind: "class" }>, byte: number, ignoreCase: boolean): boolean {
  // Case folding in classes: ASCII letters only, tried in both cases (as git's WM_CASEFOLD does).
  const candidates = ignoreCase && isAsciiLetter(byte) ? [byte, byte ^ 0x20] : [byte];
  const hit = token.items.some((item) =>
    "posix" in item ? candidates.some((c) => posixMatches(item.posix, c)) : candidates.some((c) => c >= item.from && c <= item.to),
  );
  return hit !== token.negated;
}

function posixMatches(name: PosixClass, byte: number): boolean {
  const isDigit = byte >= 0x30 && byte <= 0x39;
  const isUpper = byte >= 0x41 && byte <= 0x5a;
  const isLower = byte >= 0x61 && byte <= 0x7a;
  switch (name) {
    case "alnum":
      return isDigit || isUpper || isLower;
    case "alpha":
      return isUpper || isLower;
    case "blank":
      return byte === 0x20 || byte === 0x09;
    case "cntrl":
      return byte < 0x20 || byte === 0x7f;
    case "digit":
      return isDigit;
    case "graph":
      return byte > 0x20 && byte < 0x7f;
    case "lower":
      return isLower;
    case "print":
      return byte >= 0x20 && byte < 0x7f;
    case "punct":
      return byte > 0x20 && byte < 0x7f && !isDigit && !isUpper && !isLower;
    case "space":
      return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
    case "upper":
      return isUpper;
    case "xdigit":
      return isDigit || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
  }
}

function isAsciiLetter(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function foldAscii(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}
