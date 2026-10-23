import { describe, expect, test } from "vitest";
import { parseEnvExample } from "../src/index.js";

describe("parseEnvExample", () => {
  test("reads names and line numbers, skipping blanks and comments", () => {
    const result = parseEnvExample(`# Database
DATABASE_URL=

  # indented comment
export AUTH_SECRET=changeme
NEXT_PUBLIC_SITE_URL = http://localhost:3000
EMPTY_QUOTED=""
`);
    expect(result).toEqual({
      entries: [
        { name: "DATABASE_URL", line: 2 },
        { name: "AUTH_SECRET", line: 5 },
        { name: "NEXT_PUBLIC_SITE_URL", line: 6 },
        { name: "EMPTY_QUOTED", line: 7 },
      ],
      duplicates: [],
      invalidLines: [],
    });
  });

  test("handles CRLF, CR and a byte-order mark", () => {
    expect(parseEnvExample(String.fromCharCode(0xfeff) + "A=1\r\nB=2\rC=3").entries.map((entry) => entry.name)).toEqual(["A", "B", "C"]);
  });

  test("reports every repeat against the first line, in file order, before entries are collapsed", () => {
    const result = parseEnvExample("A=\nB=\nexport A=x\nB=\nA = y\n");
    expect(result.entries).toEqual([
      { name: "A", line: 1 },
      { name: "B", line: 2 },
    ]);
    expect(result.duplicates).toEqual([
      { name: "A", line: 3, firstLine: 1 },
      { name: "B", line: 4, firstLine: 2 },
      { name: "A", line: 5, firstLine: 1 },
    ]);
  });

  test("names are case-sensitive, so differently cased names are not duplicates", () => {
    expect(parseEnvExample("API_URL=\napi_url=\n").duplicates).toEqual([]);
  });

  test("reports lines that are not KEY=value entries", () => {
    expect(parseEnvExample("JUST_A_NAME\n1BAD=x\nlower-case=x\n=nothing\nOK=1\n").invalidLines).toEqual([1, 2, 3, 4]);
  });

  test("skips continuation lines of multi-line quoted values", () => {
    const result = parseEnvExample(`PRIVATE_KEY="-----BEGIN KEY-----
NOT_A_KEY=inside the value
-----END KEY-----"
NEXT=1
SINGLE='a
B=still inside'
ESCAPED="a \\" B=still inside
"
LAST=1
`);
    expect(result.entries.map((entry) => entry.name)).toEqual(["PRIVATE_KEY", "NEXT", "SINGLE", "ESCAPED", "LAST"]);
    expect(result.entries.find((entry) => entry.name === "LAST")?.line).toBe(9);
  });

  test("reports the line where a never-closed quoted value starts", () => {
    expect(parseEnvExample('A=1\nB="open\nC=2\n').unterminatedQuoteLine).toBe(2);
    expect(parseEnvExample('A="closed\nstill"\nB=1\n').unterminatedQuoteLine).toBeUndefined();
  });

  test("an unterminated quoted value consumes the rest of the file instead of inventing entries", () => {
    expect(parseEnvExample('A="never closed\nB=1\nC=2\n').entries.map((entry) => entry.name)).toEqual(["A"]);
  });

  test("never returns values", () => {
    const sentinel = "ENVSYNC_FAKE_SECRET_DO_NOT_LEAK";
    const result = parseEnvExample(`TOKEN=${sentinel}\nTOKEN="${sentinel}"\nbad line ${sentinel}\nMULTI="${sentinel}\n${sentinel}"\n`);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
});
