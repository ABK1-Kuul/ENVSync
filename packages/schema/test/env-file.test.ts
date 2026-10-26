import { describe, expect, test } from "vitest";
import { parseEnvFile } from "../src/index.js";

const values = (text: string) => Object.fromEntries(parseEnvFile(text).entries.map(({ name, value }) => [name, value]));

describe("parseEnvFile", () => {
  test("reads names, values and lines like dotenv", () => {
    const result = parseEnvFile(`# comment
PLAIN=hello world
export EXPORTED=1
SPACED = padded
INLINE=value # comment
HASH_IN_QUOTES="a#b"
EMPTY=
SINGLE='it''s $HOME \\n'
DOUBLE="line\\nbreak"
BACKTICK=\`x\`
`);
    expect(result.entries).toEqual([
      { name: "PLAIN", line: 2, value: "hello world" },
      { name: "EXPORTED", line: 3, value: "1" },
      { name: "SPACED", line: 4, value: "padded" },
      { name: "INLINE", line: 5, value: "value" },
      { name: "HASH_IN_QUOTES", line: 6, value: "a#b", quote: '"' },
      { name: "EMPTY", line: 7, value: "" },
      { name: "SINGLE", line: 8, value: "it''s $HOME \\n", quote: "'" },
      { name: "DOUBLE", line: 9, value: "line\nbreak", quote: '"' },
      { name: "BACKTICK", line: 10, value: "x", quote: "`" },
    ]);
    expect(result.invalidLines).toEqual([]);
  });

  test("quoted values may span lines; line numbers after them stay correct", () => {
    const result = parseEnvFile('KEY="-----BEGIN\nmiddle\nEND-----"\nNEXT=2\r\nLAST=3');
    expect(result.entries).toEqual([
      { name: "KEY", line: 1, value: "-----BEGIN\nmiddle\nEND-----", quote: '"' },
      { name: "NEXT", line: 4, value: "2" },
      { name: "LAST", line: 5, value: "3" },
    ]);
  });

  test("an unclosed quote, or text after the closing quote, is read as an unquoted value", () => {
    expect(values('A="open\nB=2\nC="x" junk\n')).toEqual({ A: '"open', B: "2", C: '"x" junk' });
  });

  test("`KEY: value` (colon and a blank) is an assignment, as in dotenv; `KEY:value` is not", () => {
    expect(values("A: 1\nB:\tx # note\nC:nope\n")).toEqual({ A: "1", B: "x" });
    expect(parseEnvFile("C:nope\n").invalidLines).toEqual([1]);
  });

  test("escaped quotes do not close a value", () => {
    expect(values('A="say \\"hi\\""\n')).toEqual({ A: 'say \\"hi\\"' });
  });

  test("the last assignment wins and earlier ones are reported as duplicates", () => {
    const result = parseEnvFile("A=1\nB=2\nA=3\n");
    expect(result.entries).toEqual([
      { name: "B", line: 2, value: "2" },
      { name: "A", line: 3, value: "3" },
    ]);
    expect(result.duplicates).toEqual([{ name: "A", line: 3, firstLine: 1 }]);
  });

  test("lines that are not assignments are reported by line number and skipped", () => {
    const result = parseEnvFile("\uFEFFnot an assignment\n=nokey\nGOOD=1\n");
    expect(result.invalidLines).toEqual([1, 2]);
    expect(values("\uFEFFGOOD=1")).toEqual({ GOOD: "1" });
  });

  test("lines of an unquoted PEM block are key material, never assignments", () => {
    const result = parseEnvFile("KEY=-----BEGIN PRIVATE KEY-----\nAbCdEf0123==\nGhIj=\n-----END PRIVATE KEY-----\nNEXT=1\n");
    expect(result.entries).toEqual([
      { name: "KEY", line: 1, value: "-----BEGIN PRIVATE KEY-----" },
      { name: "NEXT", line: 5, value: "1" },
    ]);
    expect(result.invalidLines).toEqual([]);
  });

  test("stays linear on hostile input (many unclosed or far-closing quotes, long tails, no '#')", () => {
    const started = performance.now();
    parseEnvFile([`A="\\"\n`.repeat(100_000), 'Z="end"\n', "B=x".repeat(50_000)].join(""));
    parseEnvFile(`${"Q='\n".repeat(150_000)}'\n`);
    // Every line opens a quote; the only closing quote is followed by a long tail with no newline.
    parseEnvFile(`${"A='\n".repeat(100_000)}'x${"y".repeat(500_000)}`);
    parseEnvFile(`K=-----BEGIN PRIVATE KEY-----\n${"QUJD=\n".repeat(150_000)}`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
