import { describe, expect, test } from "vitest";
import { effectiveVisibility, parseConfigSource } from "../src/index.js";

const issueSummary = (source: string) =>
  parseConfigSource(source).issues.map(({ kind, location, variableName }) => ({ kind, line: location?.line, variableName }));

describe("parseConfigSource: supported shapes", () => {
  test("reads defineConfig with literal definitions and applies defaults", () => {
    const result = parseConfigSource(`import { defineConfig } from "envsync";
export default defineConfig({
  variables: {
    DATABASE_URL: { required: true, secret: true, type: "url", description: "Primary database" },
    "QUOTED_NAME": {},
    OPTIONAL: { required: false, secret: false },
  },
});
`);

    expect(result.issues).toEqual([]);
    expect(result.variables).toEqual([
      { name: "DATABASE_URL", required: true, secret: true, type: "url", description: "Primary database", location: { line: 4, column: 5 } },
      { name: "QUOTED_NAME", required: true, type: "string", location: { line: 5, column: 5 } },
      { name: "OPTIONAL", required: false, secret: false, type: "string", location: { line: 6, column: 5 } },
    ]);
  });

  test.each([
    ["plain object", `export default { variables: { A: {} } };`],
    ["as const", `export default { variables: { A: {} } } as const;`],
    ["satisfies", `export default ({ variables: { A: {} } }) satisfies object;`],
    ["const reference", `const config = { variables: { A: {} } };\nexport default config;`],
    ["const defineConfig reference", `const config = defineConfig({ variables: { A: {} } });\nexport default config;`],
    ["defineConfig of const", `const raw = { variables: { A: {} } } as const;\nexport default defineConfig(raw);`],
  ])("accepts %s", (_label, source) => {
    const result = parseConfigSource(source);
    expect(result.issues).toEqual([]);
    expect(result.variables.map((variable) => variable.name)).toEqual(["A"]);
  });
});

describe("parseConfigSource: rejected input becomes issues, never evaluation", () => {
  test("missing default export", () => {
    expect(issueSummary(`export const config = { variables: {} };`)).toEqual([{ kind: "invalid", line: undefined, variableName: undefined }]);
  });

  test.each([
    ["function call", `export default makeConfig();`],
    ["IIFE", `export default (() => ({ variables: {} }))();`],
    ["let reference", `let c = { variables: {} };\nexport default c;`],
    ["imported value", `import c from "./other";\nexport default c;`],
    ["self-referential const", `const c = c;\nexport default c;`],
  ])("non-static default export: %s", (_label, source) => {
    const result = parseConfigSource(source);
    expect(result.variables).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.kind).toBe("invalid");
  });

  test("syntax error is reported with a location and no variables", () => {
    const result = parseConfigSource(`export default { variables: { A: { required: true } };\n`);
    expect(result.variables).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain("syntax error");
    expect(result.issues[0]?.location).toEqual({ line: expect.any(Number), column: expect.any(Number) });
  });

  test("unsupported entries are reported individually at their lines", () => {
    const source = `const key = "DYNAMIC";
const shared = {};
export default {
  variables: {
    ...shared,
    [key]: {},
    "lower-case": {},
    SHORTHAND,
    BAD_FIELD: { required: maybe },
    BAD_TYPE: { type: "datetime" },
    UNKNOWN_FIELD: { default: "x" },
    REPEATED_FIELD: { required: true, required: false },
    NOT_OBJECT: true,
  },
  extra: true,
};`;
    expect(issueSummary(source)).toEqual([
      { kind: "invalid", line: 15, variableName: undefined },
      { kind: "invalid", line: 5, variableName: undefined },
      { kind: "invalid", line: 6, variableName: undefined },
      { kind: "invalid", line: 7, variableName: "lower-case" },
      { kind: "invalid", line: 8, variableName: undefined },
      { kind: "invalid", line: 9, variableName: "BAD_FIELD" },
      { kind: "invalid", line: 10, variableName: "BAD_TYPE" },
      { kind: "invalid", line: 11, variableName: "UNKNOWN_FIELD" },
      { kind: "invalid", line: 12, variableName: "REPEATED_FIELD" },
      { kind: "invalid", line: 13, variableName: "NOT_OBJECT" },
    ]);
  });

  test("a variable with an invalid field is still declared, with defaults for that field", () => {
    const result = parseConfigSource(`export default { variables: { A: { required: maybe, type: "nope", secret: true } } };`);
    expect(result.variables).toEqual([{ name: "A", required: true, secret: true, type: "string", location: { line: 1, column: 31 } }]);
  });

  test("duplicate names are reported and the first declaration wins", () => {
    const result = parseConfigSource(`export default {
  variables: {
    A: { required: true },
    A: { required: false },
  },
};`);
    expect(result.variables).toEqual([{ name: "A", required: true, type: "string", location: { line: 3, column: 5 } }]);
    expect(result.issues).toEqual([
      expect.objectContaining({ kind: "duplicate", variableName: "A", location: { line: 4, column: 5 } }),
    ]);
    expect(result.issues[0]?.message).toContain("line 3");
  });

  test("missing or non-object variables", () => {
    expect(issueSummary(`export default {};`)).toEqual([{ kind: "invalid", line: 1, variableName: undefined }]);
    expect(issueSummary(`export default { variables: [] };`)).toEqual([{ kind: "invalid", line: 1, variableName: undefined }]);
  });

  test("messages never echo literal values from the config", () => {
    const sentinel = "ENVSYNC_FAKE_SECRET_DO_NOT_LEAK";
    const result = parseConfigSource(`export default {
  variables: {
    A: { type: "${sentinel}", description: 42, required: "${sentinel}" },
    B: { default: "${sentinel}" },
  },
  other: "${sentinel}",
};`);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.issues)).not.toContain(sentinel);
  });
});

describe("parseConfigSource: duplicates are detected before entries are collapsed", () => {
  test("identifier, quoted and computed-literal spellings of one name are the same variable", () => {
    const result = parseConfigSource(`export default {
  variables: {
    API_URL: { required: true },
    "API_URL": { required: false },
    ["API_URL"]: { secret: true },
    [\`API_URL\`]: {},
  },
};`);
    expect(result.variables).toEqual([{ name: "API_URL", required: true, type: "string", location: { line: 3, column: 5 } }]);
    expect(result.issues.map(({ kind, location, variableName, message }) => ({ kind, line: location?.line, variableName, message }))).toEqual(
      [4, 5, 6].map((line) => ({
        kind: "duplicate",
        line,
        variableName: "API_URL",
        message: "API_URL is declared more than once (first declared on line 3).",
      })),
    );
  });

  test("differently cased names are distinct variables", () => {
    const result = parseConfigSource(`export default { variables: { API_URL: {}, api_url: {} } };`);
    expect(result.issues).toEqual([]);
    expect(result.variables.map((variable) => variable.name)).toEqual(["API_URL", "api_url"]);
  });

  test("a repeated `variables` key is reported instead of silently replacing the first", () => {
    const result = parseConfigSource(`export default {
  variables: { A: {} },
  variables: { B: {} },
};`);
    expect(result.variables.map((variable) => variable.name)).toEqual(["A"]);
    expect(result.issues).toEqual([expect.objectContaining({ kind: "duplicate", location: { line: 3, column: 3 } })]);
  });

  test("results are identical across runs", () => {
    const source = `export default { variables: { B: {}, A: {}, B: {}, A: {} } };`;
    expect(parseConfigSource(source)).toEqual(parseConfigSource(source));
  });
});

describe("parseConfigSource: top-level code is reported, never run or ignored silently", () => {
  const topLevelIssues = (source: string) =>
    parseConfigSource(source).issues.map(({ kind, location, message }) => ({ kind, line: location?.line, message }));

  test("allowed: imports, types, inert declarations, functions, re-exports, ambient declarations", () => {
    const source = `import { defineConfig } from "envsync";
import type { Config } from "envsync";
type Name = string;
interface Extra { a: string }
const isProd = process.env.NODE_ENV === "production";
const shared = { required: true } as const;
function helper() { return mutate(); }
export { helper };
export * from "./other";
declare global { var x: string }
;
export const config = defineConfig({ variables: { A: { required: true } } });
export default config;`;
    expect(parseConfigSource(source)).toEqual({
      variables: [{ name: "A", required: true, type: "string", location: { line: 12, column: 51 } }],
      issues: [],
    });
  });

  test.each([
    ["call statement", `writeFileSync("marker", "x");`],
    ["mutation of the config", `config.variables.EXTRA = { required: true };`],
    ["Object.assign", `Object.assign(config.variables, { EXTRA: {} });`],
    ["delete", `delete config.variables.A;`],
    ["if block", `if (process.env.CI) { config.variables.CI_ONLY = {}; }`],
    ["loop", `for (const name of names) {}`],
    ["class", `class Plugin { static { run(); } }`],
    ["enum", `enum Mode { A }`],
    ["import =", `import fs = require("node:fs");`],
    ["call in a const initializer", `const extra = loadVariables();`],
    ["new in a const initializer", `const date = new Date();`],
    ["assignment in an initializer", `let counter = 0; const next = (counter = 1);`],
    ["IIFE in an initializer", `const value = (() => 1)();`],
    ["tagged template", "const q = sql`select 1`;"],
    ["await", `const data = await fetchConfig();`],
    ["increment", `let n = 0; const m = n++;`],
  ])("%s", (_label, statement) => {
    const issues = topLevelIssues(`const config = { variables: { A: {} } };\n${statement}\nexport default config;`);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0]).toMatchObject({ kind: "invalid", line: 2 });
    expect(issues[0]?.message).toMatch(/never runs|not supported/);
  });

  test("statements are reported but the literal config is still read, so other findings stay accurate", () => {
    const result = parseConfigSource(`const config = { variables: { A: {} } };
config.variables.B = {};
export default config;`);
    expect(result.variables.map((variable) => variable.name)).toEqual(["A"]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.suggestion).toContain("read as data");
  });

  test("`export =` and a second default export are reported", () => {
    expect(topLevelIssues(`export = { variables: {} };`)).toEqual([
      { kind: "invalid", line: 1, message: "`export =` is not supported. Use `export default`." },
      { kind: "invalid", line: undefined, message: "envsync.config.ts has no default export." },
    ]);
    expect(topLevelIssues(`export default { variables: {} };\nexport default { variables: { X: {} } };`)).toEqual([
      { kind: "invalid", line: 2, message: "envsync.config.ts has more than one default export. Only the first one is used." },
    ]);
  });

  test("defineConfig is never called: its argument is read as a literal", () => {
    // Even if defineConfig would transform its input at runtime, EnvSync reads only the literal argument.
    const result = parseConfigSource(`export default defineConfig({ variables: { A: {} } });`);
    expect(result).toEqual({ variables: [{ name: "A", required: true, type: "string", location: { line: 1, column: 44 } }], issues: [] });
  });
});

describe("visibility", () => {
  test("is parsed, and implies `secret` when only visibility is given", () => {
    const { variables, issues } = parseConfigSource(
      'export default { variables: { A: { visibility: "plain" }, B: { visibility: "sensitive" }, C: { visibility: "secret" }, D: { secret: true, visibility: "secret" } } };',
    );
    expect(issues).toEqual([]);
    expect(variables.map(({ name, secret, visibility }) => ({ name, secret, visibility }))).toEqual([
      { name: "A", secret: false, visibility: "plain" },
      { name: "B", secret: true, visibility: "sensitive" },
      { name: "C", secret: true, visibility: "secret" },
      { name: "D", secret: true, visibility: "secret" },
    ]);
    expect(variables.map(effectiveVisibility)).toEqual(["plain", "sensitive", "secret", "secret"]);
    expect(effectiveVisibility({ secret: false })).toBe("plain");
    expect(effectiveVisibility({})).toBeUndefined();
  });

  test("an unknown visibility or one that disagrees with `secret` is ENV004 material", () => {
    const { issues } = parseConfigSource('export default { variables: { A: { visibility: "public" }, B: { secret: false, visibility: "secret" } } };');
    expect(issues.map(({ variableName, message }) => `${variableName}: ${message}`)).toEqual([
      "A: `visibility` for A must be one of: plain, sensitive, secret.",
      'B: B sets both `secret: false` and `visibility: "secret"`, which disagree.',
    ]);
  });
});
