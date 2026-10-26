import { parseEnvFile } from "@envsync-internal/schema";
import { describe, expect, test } from "vitest";
import { applyEnvEdit, minimalReplacement, serializeValue, type EnvEdit } from "../src/index.js";

function edited(text: string, edit: EnvEdit): string {
  const result = applyEnvEdit(text, edit);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  // The minimal replacement must produce exactly the same text.
  const { start, end, text: inserted } = result.replacement;
  expect(text.slice(0, start) + inserted + text.slice(end)).toBe(result.text);
  return result.text;
}

const value = (text: string, name: string) => parseEnvFile(text).entries.find((entry) => entry.name === name)?.value;

describe("set", () => {
  test("changes only the value, keeping comments, blank lines, order, export, indentation and separators", () => {
    const before = "# Database\n\nexport DATABASE_URL=postgres://old\n  API_URL = https://a.example\nPORT: 3000\n# end\n";
    expect(edited(before, { kind: "set", name: "DATABASE_URL", value: "postgres://new" })).toBe(
      "# Database\n\nexport DATABASE_URL=postgres://new\n  API_URL = https://a.example\nPORT: 3000\n# end\n",
    );
    expect(edited(before, { kind: "set", name: "API_URL", value: "https://b.example" })).toContain("  API_URL = https://b.example\n");
    expect(edited(before, { kind: "set", name: "PORT", value: "4000" })).toContain("PORT: 4000\n");
  });

  test("keeps an inline comment, CRLF line endings and a byte-order mark", () => {
    const before = "\uFEFFA=1 # the first\r\nB='x'  # quoted\r\n";
    const after = edited(before, { kind: "set", name: "A", value: "2" });
    expect(after).toBe("\uFEFFA=2 # the first\r\nB='x'  # quoted\r\n");
    expect(edited(after, { kind: "set", name: "B", value: "y z" })).toBe("\uFEFFA=2 # the first\r\nB='y z'  # quoted\r\n");
  });

  test("replaces a multi-line value entirely and edits the assignment that takes effect", () => {
    const before = 'KEY="line1\nline2"\nNEXT=1\nKEY=override\n';
    const after = edited(before, { kind: "set", name: "KEY", value: "final" });
    expect(after).toBe('KEY="line1\nline2"\nNEXT=1\nKEY=final\n');
    const single = edited('KEY="line1\nline2"\nNEXT=1\n', { kind: "set", name: "KEY", value: "one" });
    expect(single).toBe("KEY=one\nNEXT=1\n");
  });

  test("quotes values as needed so they read back exactly", () => {
    const cases = ["plain", "", "has space", "a#b", "$HOME/x", "it's", "line1\nline2", " padded ", "-----BEGIN PRIVATE KEY-----", "`tick`", 'say "hi"'];
    for (const next of cases) {
      const after = edited("V=old\n", { kind: "set", name: "V", value: next });
      expect(value(after, "V")).toBe(next);
    }
  });

  test("refuses a value that cannot be written exactly, without echoing it", () => {
    const impossible = "it's \"both\"\nand `more` $X";
    const result = applyEnvEdit("V=old\n", { kind: "set", name: "V", value: impossible });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("edit the raw text instead") });
    expect(JSON.stringify(result)).not.toContain("both");
  });

  test("refuses unknown names", () => {
    expect(applyEnvEdit("A=1\n", { kind: "set", name: "B", value: "x" })).toEqual({ ok: false, reason: "B is not set in this file." });
  });
});

describe("add", () => {
  test("appends at the end, keeping the file's line ending and final-newline style", () => {
    expect(edited("A=1\n", { kind: "add", name: "B", value: "2" })).toBe("A=1\nB=2\n");
    expect(edited("A=1", { kind: "add", name: "B", value: "2" })).toBe("A=1\nB=2");
    expect(edited("A=1\r\n", { kind: "add", name: "B", value: "x y" })).toBe("A=1\r\nB='x y'\r\n");
    expect(edited("", { kind: "add", name: "B", value: "2" })).toBe("B=2\n");
  });

  test("refuses invalid names and names already set", () => {
    expect(applyEnvEdit("A=1\n", { kind: "add", name: "1BAD", value: "x" })).toMatchObject({ ok: false });
    expect(applyEnvEdit("A=1\n", { kind: "add", name: "A", value: "x" })).toEqual({ ok: false, reason: "A is already set in this file." });
  });
});

describe("rename", () => {
  test("renames every assignment of the name and keeps values and comments", () => {
    const before = "export OLD_NAME=\"a b\" # note\nOTHER=1\nOLD_NAME=c\n";
    expect(edited(before, { kind: "rename", from: "OLD_NAME", to: "NEW_NAME" })).toBe("export NEW_NAME=\"a b\" # note\nOTHER=1\nNEW_NAME=c\n");
  });

  test("refuses a target that exists or is invalid", () => {
    expect(applyEnvEdit("A=1\nB=2\n", { kind: "rename", from: "A", to: "B" })).toEqual({ ok: false, reason: "B is already set in this file." });
    expect(applyEnvEdit("A=1\n", { kind: "rename", from: "A", to: "has space" })).toMatchObject({ ok: false });
  });
});

describe("remove", () => {
  test("removes every assignment, including multi-line ones, and nothing else", () => {
    const before = '# keep\nA=1\nKEY="x\ny"\nB=2\nKEY=z\n';
    expect(edited(before, { kind: "remove", name: "KEY" })).toBe("# keep\nA=1\nB=2\n");
  });

  test("removing the last line of a file without a final line break leaves no dangling break", () => {
    expect(edited("A=1\nB=2", { kind: "remove", name: "B" })).toBe("A=1");
    expect(edited("A=1", { kind: "remove", name: "A" })).toBe("");
    expect(edited("A=1\r\nB=2\r\n", { kind: "remove", name: "A" })).toBe("B=2\r\n");
  });
});

describe("safety", () => {
  test("an edit never changes another variable's value", () => {
    // B's value contains what looks like an assignment on its continuation line.
    const before = 'A=1\nB="first\nC=not-a-variable"\n';
    const after = edited(before, { kind: "set", name: "A", value: "2" });
    expect(parseEnvFile(after).entries.map((entry) => entry.name)).toEqual(["A", "B"]);
    expect(value(after, "B")).toBe(value(before, "B"));
  });

  test("serializeValue prefers no quotes, then single, double, backtick; undefined when impossible", () => {
    expect(serializeValue("abc")).toBe("abc");
    expect(serializeValue("$X")).toBe("'$X'");
    expect(serializeValue("it's")).toBe("it's"); // reads back exactly without quotes
    expect(serializeValue("'quoted'")).toBe(`"'quoted'"`);
    expect(serializeValue("two words")).toBe("'two words'");
    expect(serializeValue("a\nb")).toBe('"a\\nb"');
    expect(serializeValue("it's \"x\"")).toBe("`it's \"x\"`");
    expect(serializeValue("it's\n\"x\"")).toBeUndefined();
  });

  test("minimalReplacement covers only what differs", () => {
    expect(minimalReplacement("A=1\nB=2\nC=3\n", "A=1\nB=22\nC=3\n")).toEqual({ start: 7, end: 7, text: "2" });
    expect(minimalReplacement("same", "same")).toEqual({ start: 4, end: 4, text: "" });
  });
});
