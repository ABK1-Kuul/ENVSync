/**
 * Git-compatible wildmatch for `.gitignore` patterns (the `WM_PATHNAME` mode git uses for ignore
 * rules), implemented without regular expressions.
 *
 * Like git, it works on UTF-8 bytes, not characters: `?` matches one byte and classes compare byte
 * values. Case folding (`core.ignorecase`) is chosen per match, so callers can evaluate both
 * settings when the effective value is unknown, and it reproduces git's asymmetry exactly:
 * - the path's ASCII upper-case letters are folded to lower case;
 * - plain pattern letters are folded too, but letters written after a backslash (`\E`) and single
 *   class members (`[E]`) are compared as written, so they never match a folded path letter;
 * - a class range also accepts the upper-case form of a lower-case path letter.
 *
 * Patterns are compiled to tokens and matched by tracking the set of reachable byte positions, so
 * each token costs O(text length): matching is O(pattern × text) for any input, and hostile
 * patterns such as `*a*a*a*a*b` cannot cause catastrophic backtracking.
 *
 * Semantics follow git's wildmatch.c and dir.c:
 * - `?`, `*` and `[...]` never match `/`.
 * - `**` is special only as a whole path segment: leading `**\/`, trailing `/**`, or `/**\/`.
 *   Elsewhere it behaves like `*`.
 * - Classes support ranges, `!`/`^` negation, a leading `]` as a literal, backslash escapes and
 *   POSIX classes like `[:alpha:]`. An unterminated class or invalid POSIX class makes the whole
 *   pattern match nothing, as in git.
 * - A trailing unescaped backslash makes the pattern match nothing.
 * - For path patterns (`compileGitPathPattern`), the literal prefix before the first wildcard is
 *   compared separately and the rest is matched on its own, as git's `match_pathname` does in git
 *   2.46 and older. That is why `apps**\/x` also matches `apps/web/x` there: after the prefix, `**`
 *   starts the pattern. Newer git matches the whole pattern; gitignore.ts evaluates both.
 */

type ClassItem = { from: number; to: number; single: boolean } | { posix: PosixClass };
type PosixClass = "alnum" | "alpha" | "blank" | "cntrl" | "digit" | "graph" | "lower" | "print" | "punct" | "space" | "upper" | "xdigit";

type Token =
  /** `escaped`: written after a backslash, so never case-folded (as in git). */
  | { kind: "literal"; byte: number; escaped: boolean }
  | { kind: "any" } // ?
  | { kind: "star" } // * within one segment
  | { kind: "class"; negated: boolean; items: ClassItem[] }
  | { kind: "dirs" } // `**/`: zero or more whole directories ("", "a/", "a/b/", ...)
  | { kind: "rest" }; // `/**` tail: one or more bytes of anything

export type CompiledPattern = {
  tokens: Token[];
  matchesNothing: boolean;
  /** Path patterns only: bytes compared literally (folded when ignoring case) before `tokens`. */
  literalPrefix?: Buffer;
};

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

/** Compiles a pattern matched against a whole string (git's basename matching). */
export function compileWildmatch(pattern: string): CompiledPattern {
  return compileBytes(Buffer.from(pattern, "utf8"));
}

/**
 * Compiles a pattern matched against a `/`-separated path (git's `match_pathname`): the literal
 * prefix up to the first `*`, `?`, `[` or `\` is compared on its own, then the rest is matched as
 * an independent pattern.
 */
export function compileGitPathPattern(pattern: string): CompiledPattern {
  const bytes = Buffer.from(pattern, "utf8");
  let prefixLength = 0;
  while (prefixLength < bytes.length && !isWildcardByte(bytes[prefixLength] as number)) prefixLength++;
  const compiled = compileBytes(bytes.subarray(prefixLength));
  return prefixLength === 0 ? compiled : { ...compiled, literalPrefix: Buffer.from(bytes.subarray(0, prefixLength)) };
}

function compileBytes(bytes: Buffer): CompiledPattern {
  const tokens: Token[] = [];
  const nothing: CompiledPattern = { tokens: [], matchesNothing: true };
  let i = 0;

  while (i < bytes.length) {
    const byte = bytes[i] as number;
    if (byte === BACKSLASH) {
      if (i + 1 >= bytes.length) return nothing;
      tokens.push({ kind: "literal", byte: bytes[i + 1] as number, escaped: true });
      i += 2;
    } else if (byte === QUESTION) {
      tokens.push({ kind: "any" });
      i++;
    } else if (byte === STAR) {
      let end = i;
      while (bytes[end] === STAR) end++;
      const starCount = end - i;
      const atSegmentStart = i === 0 || bytes[i - 1] === SLASH;
      // git also accepts an escaped slash (`\/`) as the end of the segment.
      const escapedSlash = bytes[end] === BACKSLASH && bytes[end + 1] === SLASH;
      const atSegmentEnd = end === bytes.length || bytes[end] === SLASH || escapedSlash;
      if (starCount >= 2 && atSegmentStart && atSegmentEnd) {
        if (end === bytes.length) {
          // `**` at the very end: after a `/` it means "everything inside"; alone it matches anything.
          if (i === 0) tokens.push({ kind: "dirs" });
          tokens.push({ kind: "rest" });
          i = end;
        } else {
          // `**/` (leading or after `/`): zero or more directories.
          tokens.push({ kind: "dirs" });
          i = end + (escapedSlash ? 2 : 1);
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
      tokens.push({ kind: "literal", byte, escaped: false });
      i++;
    }
  }
  return { tokens: collapse(tokens), matchesNothing: false };
}

/** Whether `text` matches; `ignoreCase` applies git's `WM_CASEFOLD` rules (see the file comment). */
export function wildmatch(compiled: CompiledPattern, text: string, ignoreCase: boolean): boolean {
  if (compiled.matchesNothing) return false;
  let bytes: Buffer = Buffer.from(text, "utf8");

  if (compiled.literalPrefix) {
    const prefix = compiled.literalPrefix;
    if (prefix.length > bytes.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      const a = prefix[i] as number;
      const b = bytes[i] as number;
      if (ignoreCase ? foldAscii(a) !== foldAscii(b) : a !== b) return false;
    }
    bytes = bytes.subarray(prefix.length);
    if (compiled.tokens.length === 0) return bytes.length === 0;
  }

  const n = bytes.length;
  // The path is folded once; pattern bytes are folded (or not) per token, as git does.
  const text8 = ignoreCase ? Uint8Array.from(bytes, foldAscii) : bytes;
  let reachable = new Uint8Array(n + 1);
  reachable[0] = 1;

  for (const token of compiled.tokens) {
    const next = new Uint8Array(n + 1);
    switch (token.kind) {
      case "literal": {
        const expected = ignoreCase && !token.escaped ? foldAscii(token.byte) : token.byte;
        for (let p = 0; p < n; p++) if (reachable[p] && text8[p] === expected) next[p + 1] = 1;
        break;
      }
      case "any":
        for (let p = 0; p < n; p++) if (reachable[p] && text8[p] !== SLASH) next[p + 1] = 1;
        break;
      case "class":
        for (let p = 0; p < n; p++) {
          if (reachable[p] && text8[p] !== SLASH && classMatches(token, text8[p] as number, ignoreCase)) next[p + 1] = 1;
        }
        break;
      case "star": {
        // Reachable from any earlier reachable position without crossing a `/`.
        let open = false;
        for (let p = 0; p <= n; p++) {
          if (reachable[p]) open = true;
          if (open) next[p] = 1;
          if (text8[p] === SLASH) open = false;
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
          if (seen && p > 0 && text8[p - 1] === SLASH) next[p] = 1;
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
    if (!next.includes(1)) return false; // nothing reachable: no later token can match
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
        items.push({ from: OPEN_BRACKET, to: OPEN_BRACKET, single: true });
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
      items.push({ from: byte, to, single: false });
      i += skip;
    } else {
      items.push({ from: byte, to: byte, single: true });
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

/** `byte` is the path byte, already folded to lower case when ignoring case. */
function classMatches(token: Extract<Token, { kind: "class" }>, byte: number, ignoreCase: boolean): boolean {
  const isLower = byte >= 0x61 && byte <= 0x7a;
  const hit = token.items.some((item) => {
    if ("posix" in item) {
      // git: with case folding, [:upper:] also accepts a lower-case (folded) letter.
      return posixMatches(item.posix, byte) || (ignoreCase && item.posix === "upper" && isLower);
    }
    // Single members are compared as written (never folded), exactly like git.
    if (item.single) return byte === item.from;
    // git compares a range start as a single member first, so even a reversed range like [e-a]
    // matches its first character.
    if (byte === item.from || (byte >= item.from && byte <= item.to)) return true;
    const upper = byte - 0x20;
    return ignoreCase && isLower && upper >= item.from && upper <= item.to;
  });
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
      // git's isspace: space, tab, LF and CR only (not vertical tab or form feed).
      return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
    case "upper":
      return isUpper;
    case "xdigit":
      return isDigit || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
  }
}

function isWildcardByte(byte: number): boolean {
  return byte === STAR || byte === QUESTION || byte === OPEN_BRACKET || byte === BACKSLASH;
}

function foldAscii(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}
