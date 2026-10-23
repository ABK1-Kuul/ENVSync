import { describe, expect, test } from "vitest";
import { parseConfigSource, parseEnvExample, renderConfig, renderEnvExample, renderEnvExampleAppend } from "../src/index.js";

describe("renderConfig", () => {
  test("round-trips through the static config parser with no issues", () => {
    const text = renderConfig([
      { name: "API_URL", firstReference: { file: "src/api.ts", line: 3 } },
      { name: "DATABASE_URL" },
    ]);
    const parsed = parseConfigSource(text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.variables.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: "API_URL", required: true },
      { name: "DATABASE_URL", required: true },
    ]);
    expect(text).toContain("// First referenced at src/api.ts:3");
  });

  test("an empty list produces a valid config", () => {
    expect(parseConfigSource(renderConfig([]))).toEqual({ variables: [], issues: [] });
  });

  test("hostile file paths cannot break out of the comment and inject config", () => {
    const hostile = "src/x.ts\nINJECTED: { required: false },\u2028ALSO: {},\u202e";
    const text = renderConfig([{ name: "SAFE", firstReference: { file: hostile, line: 1 } }]);
    const parsed = parseConfigSource(text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.variables.map((variable) => variable.name)).toEqual(["SAFE"]);
    expect(text).not.toMatch(/[\u2028\u202e]/);
  });

  test("refuses invalid names instead of emitting them", () => {
    expect(() => renderConfig([{ name: "BAD-NAME }, evil: {" }])).toThrow(/invalid variable name/);
    expect(() => renderEnvExample(["OK", "NOT OK"])).toThrow(/invalid variable name/);
  });
});

describe("renderEnvExample", () => {
  test("lists empty placeholders that parse back to the same names", () => {
    const text = renderEnvExample(["B", "A"]);
    expect(parseEnvExample(text).entries.map((entry) => entry.name)).toEqual(["B", "A"]);
    for (const line of text.split("\n").filter((line) => line && !line.startsWith("#"))) {
      expect(line).toMatch(/^[A-Z_]+=$/);
    }
  });
});

describe("renderEnvExampleAppend", () => {
  test.each([
    ["LF with trailing newline", "A=\n", "# Added by `envsync init`\nB=\n"],
    ["LF without trailing newline", "A=", "\n# Added by `envsync init`\nB=\n"],
    ["CRLF", "A=\r\n", "# Added by `envsync init`\r\nB=\r\n"],
    ["CRLF without trailing newline", "A=\r\nC=", "\r\n# Added by `envsync init`\r\nB=\r\n"],
    ["empty file", "", "# Added by `envsync init`\nB=\n"],
  ])("%s", (_label, existing, expected) => {
    const appended = renderEnvExampleAppend(existing, ["B"]);
    expect(appended).toBe(expected);
    expect(parseEnvExample(existing + appended).entries.map((entry) => entry.name)).toContain("B");
  });
});
