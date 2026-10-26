/**
 * Reads runtime env files (`.env`, `.env.local`, `.env.production`, ...) with their values,
 * following the dotenv rules Next.js uses: optional `export`, `#` comments, single, double and
 * backtick quotes (quoted values may span lines), `\n`/`\r` escapes in double quotes only, and the
 * last assignment of a name wins.
 *
 * Values are returned so they can be checked; callers decide whether any value is ever displayed.
 * Hand-written and linear in the input size: dotenv's own regular expression can backtrack badly on
 * crafted input.
 */

export type EnvFileEntry = {
  name: string;
  /** Line where the assignment starts (1-based). */
  line: number;
  value: string;
  /** The quote character around the value, if any. */
  quote?: "'" | '"' | "`";
};

export type EnvFileDuplicate = { name: string; line: number; firstLine: number };

export type ParsedEnvFile = {
  /** One entry per name, holding the value that takes effect (the last assignment). */
  entries: EnvFileEntry[];
  duplicates: EnvFileDuplicate[];
  /** Line numbers of non-blank, non-comment lines that are not assignments (dotenv ignores them). */
  invalidLines: number[];
};

const KEY_CHAR = /[\w.-]/;
const QUOTES = new Set(["'", '"', "`"]);

/** One assignment as written, including repeats of a name; for editors that need to know where it is. */
export type EnvAssignment = EnvFileEntry & {
  /** Last line the assignment occupies (a quoted value or unquoted PEM block may span lines). */
  endLine: number;
  exported: boolean;
};

export type ParsedEnvAssignments = { assignments: EnvAssignment[]; invalidLines: number[] };

export function parseEnvFile(text: string): ParsedEnvFile {
  const { assignments, invalidLines } = parseEnvAssignments(text);
  const byName = new Map<string, EnvFileEntry>();
  const firstLines = new Map<string, number>();
  const duplicates: EnvFileDuplicate[] = [];
  for (const { name, line, value, quote } of assignments) {
    const firstLine = firstLines.get(name);
    if (firstLine === undefined) firstLines.set(name, line);
    else duplicates.push({ name, line, firstLine });
    byName.delete(name); // keep entries ordered by the assignment that takes effect
    byName.set(name, { name, line, value, ...(quote === undefined ? {} : { quote }) });
  }
  return { entries: [...byName.values()].sort((a, b) => a.line - b.line), duplicates, invalidLines };
}

/**
 * Every assignment in order, with the line range it occupies. Lines are counted as `parseEnvFile`
 * counts them: `\r\n`, `\n` and a lone `\r` each end a line.
 */
export function parseEnvAssignments(text: string): ParsedEnvAssignments {
  const body = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
  const assignments: EnvAssignment[] = [];
  const invalidLines: number[] = [];

  let position = 0;
  let line = 1;
  while (position < body.length) {
    const lineEnd = indexOrEnd(body, "\n", position);
    const startLine = line;
    let cursor = skipBlanks(body, position, lineEnd);

    if (cursor === lineEnd || body[cursor] === "#") {
      ({ position, line } = nextLine(lineEnd, line));
      continue;
    }
    const exported = body.startsWith("export", cursor) && /[ \t]/.test(body[cursor + 6] ?? "");
    if (exported) cursor = skipBlanks(body, cursor + 6, lineEnd);

    const keyStart = cursor;
    while (cursor < lineEnd && KEY_CHAR.test(body[cursor] as string)) cursor++;
    const name = body.slice(keyStart, cursor);
    cursor = skipBlanks(body, cursor, lineEnd);
    // dotenv accepts `KEY=value` and `KEY: value` (the colon must be followed by a blank).
    const colonSeparator = body[cursor] === ":" && (body[cursor + 1] === " " || body[cursor + 1] === "\t");
    if (name === "" || (body[cursor] !== "=" && !colonSeparator)) {
      invalidLines.push(startLine);
      ({ position, line } = nextLine(lineEnd, line));
      continue;
    }
    cursor = skipBlanks(body, cursor + 1, lineEnd);

    let value: string;
    let quote: EnvFileEntry["quote"];
    let end = lineEnd;
    const quoted = QUOTES.has(body[cursor] ?? "") ? readQuoted(body, cursor) : undefined;
    if (quoted !== undefined) {
      quote = body[cursor] as EnvFileEntry["quote"];
      value = quote === '"' ? quoted.value.replace(/\\n/g, "\n").replace(/\\r/g, "\r") : quoted.value;
      end = indexOrEnd(body, "\n", quoted.close);
      for (let i = position; i < quoted.close; i++) if (body[i] === "\n") line++;
    } else {
      // Unquoted (or a quote that is never closed, or followed by more text): up to `#`, trimmed.
      const text = body.slice(cursor, lineEnd);
      const hash = text.indexOf("#");
      value = (hash === -1 ? text : text.slice(0, hash)).trim();
      const wrapped = /^(['"`])([\s\S]*)\1$/.exec(value);
      if (wrapped) {
        quote = wrapped[1] as EnvFileEntry["quote"];
        value = wrapped[2] as string;
      }
      // An unquoted PEM block pasted across lines: dotenv keeps only the first line, and the
      // following base64 lines are key material, not assignments. Skip them (and the END line) so a
      // base64 line ending in `=` is not read as a variable name. Only lines that look like key
      // material are skipped: the first other line ends the block and is parsed normally, so a
      // block without an END line cannot swallow real assignments that dotenv would read.
      if (/^-----BEGIN [A-Z0-9 ]+-----$/.test(value)) {
        let next = lineEnd;
        while (next < body.length) {
          const following = indexOrEnd(body, "\n", next + 1);
          const content = body.slice(next + 1, following).trim();
          const isEnd = content.includes("-----END ");
          if (!isEnd && !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) break;
          line++;
          end = following;
          if (isEnd) break;
          next = following;
        }
      }
    }

    assignments.push({ name, line: startLine, endLine: line, value, ...(quote === undefined ? {} : { quote }), exported });

    ({ position, line } = nextLine(end, line));
  }

  return { assignments, invalidLines };
}

/**
 * A quoted value that closes, followed only by blanks or a comment on its last line.
 * Returns the content and the index of the closing quote; `undefined` otherwise (dotenv then reads
 * the line as an unquoted value).
 *
 * Linear overall: an opening quote follows `=` or a blank, never a backslash, so a scan from an
 * earlier opening quote stops at or before any later one. Scans for one quote character therefore
 * never overlap.
 */
function readQuoted(body: string, open: number): { value: string; close: number } | undefined {
  const quote = body[open] as string;
  let close = open + 1;
  while (close < body.length) {
    if (body[close] === "\\" && body[close + 1] === quote) close += 2;
    else if (body[close] === quote) break;
    else close++;
  }
  if (close >= body.length) return undefined;
  const lineEnd = indexOrEnd(body, "\n", close);
  const rest = skipBlanks(body, close + 1, lineEnd);
  if (rest !== lineEnd && body[rest] !== "#") return undefined;
  return { value: body.slice(open + 1, close), close };
}

function skipBlanks(body: string, from: number, limit: number): number {
  let index = from;
  while (index < limit && (body[index] === " " || body[index] === "\t")) index++;
  return index;
}

function indexOrEnd(body: string, search: string, from: number): number {
  const index = body.indexOf(search, from);
  return index === -1 ? body.length : index;
}

function nextLine(lineEnd: number, line: number): { position: number; line: number } {
  return { position: lineEnd + 1, line: line + 1 };
}
