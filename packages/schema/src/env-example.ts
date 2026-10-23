import { isValidVariableName } from "./validation.js";

/**
 * Reads variable *names* from `.env.example`. Values are never stored or returned: even an example
 * file may contain a real secret pasted by mistake, so the parser drops everything after `=`.
 */

export type EnvExampleEntry = { name: string; line: number };

export type EnvExampleDuplicate = { name: string; line: number; firstLine: number };

export type ParsedEnvExample = {
  entries: EnvExampleEntry[];
  duplicates: EnvExampleDuplicate[];
  /** Line numbers of non-blank, non-comment lines that are not `KEY=value` entries. */
  invalidLines: number[];
  /**
   * Line where a quoted value starts that is never closed. Everything after it is part of that
   * value (as dotenv reads it), so later lines, including appended ones, are not entries.
   */
  unterminatedQuoteLine?: number;
};

const ENTRY = /^(?:export\s+)?([^=\s]+)\s*=(.*)$/;

export function parseEnvExample(text: string): ParsedEnvExample {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // byte-order mark
  const lines = body.split(/\r\n|\n|\r/);
  const entries: EnvExampleEntry[] = [];
  const duplicates: EnvExampleDuplicate[] = [];
  const invalidLines: number[] = [];
  const firstLines = new Map<string, number>();
  let unterminatedQuoteLine: number | undefined;

  let index = 0;
  while (index < lines.length) {
    const lineNumber = index + 1;
    const trimmed = (lines[index] as string).trim();
    index++;
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const match = ENTRY.exec(trimmed);
    const name = match?.[1];
    if (match === null || name === undefined || !isValidVariableName(name)) {
      invalidLines.push(lineNumber);
      continue;
    }

    // A quoted value may span several lines; skip its continuation lines so they are not read as entries.
    const value = (match[2] as string).trimStart();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && !hasClosingQuote(value.slice(1), quote)) {
      while (index < lines.length && !hasClosingQuote(lines[index] as string, quote)) index++;
      if (index >= lines.length) unterminatedQuoteLine = lineNumber;
      index++;
    }

    const firstLine = firstLines.get(name);
    if (firstLine === undefined) {
      firstLines.set(name, lineNumber);
      entries.push({ name, line: lineNumber });
    } else {
      duplicates.push({ name, line: lineNumber, firstLine });
    }
  }

  return { entries, duplicates, invalidLines, ...(unterminatedQuoteLine === undefined ? {} : { unterminatedQuoteLine }) };
}

function hasClosingQuote(text: string, quote: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") {
      i++;
    } else if (text[i] === quote) {
      return true;
    }
  }
  return false;
}
