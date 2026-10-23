import { parseConfigSource, parseEnvExample, type ParsedConfig, type VariableDefinition } from "@envsync-internal/schema";
import { describe, expect, test } from "vitest";
import { analyze, type AnalysisInput, type ExtractedReference } from "../src/index.js";

const framework = { name: "Next.js", publicPrefix: "NEXT_PUBLIC_", builtInVariables: ["NODE_ENV"], externallyReadVariables: ["PORT"] };

function variable(name: string, overrides: Partial<Omit<VariableDefinition, "name">> = {}, line = 1): VariableDefinition {
  return { name, required: true, type: "string", location: { line, column: 5 }, ...overrides };
}

function input(overrides: Partial<AnalysisInput> & { variables?: VariableDefinition[]; example?: string | null }): AnalysisInput {
  const { variables = [], example = "", ...rest } = overrides;
  const config: ParsedConfig = { variables, issues: [] };
  return {
    configFile: "envsync.config.ts",
    config,
    envExampleFile: ".env.example",
    envExample: example === null ? null : parseEnvExample(example),
    references: [],
    exposures: [],
    framework,
    ...rest,
  };
}

const ref = (name: string, line = 1, column = 1): ExtractedReference => ({ kind: "static", name, line, column });
const codes = (diagnostics: ReturnType<typeof analyze>) => diagnostics.map((d) => `${d.code}:${d.severity}:${d.variableName ?? "-"}`);

describe("analyze", () => {
  test("a consistent project produces no diagnostics", () => {
    const result = analyze(
      input({
        variables: [variable("API_URL"), variable("OPTIONAL", { required: false })],
        example: "API_URL=\n",
        references: [{ file: "a.ts", references: [ref("API_URL"), ref("OPTIONAL"), ref("NODE_ENV")] }],
      }),
    );
    expect(result).toEqual([]);
  });

  test("ENV001: undeclared reference reported once at the first location with a count", () => {
    const result = analyze(
      input({
        references: [
          { file: "b.ts", references: [ref("MISSING", 9, 3)] },
          { file: "a.ts", references: [ref("MISSING", 4, 2), ref("MISSING", 5, 2)] },
        ],
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({ code: "ENV001", severity: "error", file: "a.ts", line: 4, column: 2, variableName: "MISSING" }),
    ]);
    expect(result[0]?.message).toContain("2 other places");
  });

  test("ENV001 is not reported for framework built-ins", () => {
    expect(analyze(input({ references: [{ file: "a.ts", references: [ref("NODE_ENV")] }] }))).toEqual([]);
  });

  test("ENV002: required variable missing from .env.example, or no .env.example at all", () => {
    const declared = [variable("API_URL", {}, 3), variable("OPTIONAL", { required: false }, 4)];
    const references = [{ file: "a.ts", references: [ref("API_URL"), ref("OPTIONAL")] }];

    const missingEntry = analyze(input({ variables: declared, references, example: "OTHER=\n" }));
    expect(missingEntry).toEqual([
      expect.objectContaining({ code: "ENV002", severity: "error", file: "envsync.config.ts", line: 3, variableName: "API_URL" }),
    ]);
    expect(missingEntry[0]?.message).toContain("absent from .env.example");

    const noFile = analyze(input({ variables: declared, references, example: null }));
    expect(codes(noFile)).toEqual(["ENV002:error:API_URL"]);
    expect(noFile[0]?.message).toContain("was not found");
  });

  test("ENV003: a warning when analysis is complete, downgraded to info when dynamic access exists", () => {
    const quiet = analyze(input({ variables: [variable("UNUSED", { required: false })] }));
    expect(codes(quiet)).toEqual(["ENV003:warning:UNUSED"]);
    expect(quiet[0]?.message).not.toContain("dynamic process.env");
    expect(quiet[0]?.suggestion).toContain("external: true");

    const withDynamic = analyze(
      input({
        variables: [variable("UNUSED", { required: false })],
        references: [{ file: "a.ts", references: [{ kind: "dynamic", line: 1, column: 1 }] }],
      }),
    );
    expect(codes(withDynamic)).toEqual(["ENV006:info:-", "ENV003:info:UNUSED"]);
    expect(withDynamic[1]?.message).toContain("1 dynamic process.env access that may read it, so this is less certain");
  });

  test("ENV003 is not reported for `external: true` or for variables the framework reads itself", () => {
    const result = analyze(
      input({
        variables: [variable("WEBHOOK_URL", { required: false, external: true }), variable("PORT", { required: false })],
      }),
    );
    expect(result).toEqual([]);
  });

  test("ENV007 warning: names that differ only by case collide on Windows, in config and .env.example", () => {
    const result = analyze(
      input({
        variables: [variable("API_URL", {}, 3), variable("api_url", {}, 4)],
        example: "API_URL=\nApi_Url=\napi_url=\n",
        references: [{ file: "a.ts", references: [ref("API_URL"), ref("api_url")] }],
      }),
    );
    const collisions = result.filter((d) => d.code === "ENV007");
    expect(collisions.map(({ severity, file, line, variableName }) => ({ severity, file, line, variableName }))).toEqual([
      { severity: "warning", file: ".env.example", line: 2, variableName: "Api_Url" },
      { severity: "warning", file: ".env.example", line: 3, variableName: "api_url" },
      { severity: "warning", file: "envsync.config.ts", line: 4, variableName: "api_url" },
    ]);
    expect(collisions[2]?.message).toBe(
      "api_url differs from API_URL (line 3 of envsync.config.ts) only by letter case. Windows treats environment variable names case-insensitively, so they collide there.",
    );
  });

  test("ENV003 is not reported for a variable exposed through framework config", () => {
    const result = analyze(
      input({
        variables: [variable("BUILD_ID", { required: false })],
        exposures: [{ file: "next.config.js", names: [{ name: "BUILD_ID", line: 3, column: 5 }] }],
      }),
    );
    expect(result).toEqual([]);
  });

  test("ENV004 and ENV007 come from config issues; .env.example duplicates are ENV007 warnings", () => {
    const config = parseConfigSource(`export default { variables: { "bad-name": {}, A: {}, A: {} } };`);
    const result = analyze({
      ...input({ example: "A=\nA=\n", references: [{ file: "a.ts", references: [ref("A")] }] }),
      config,
    });
    expect(codes(result)).toEqual(["ENV007:warning:A", "ENV004:error:bad-name", "ENV007:error:A"]);
    expect(result[0]).toMatchObject({ file: ".env.example", line: 2 });
  });

  test("ENV005: secret with a public prefix, and secret exposed through framework config, are errors", () => {
    const result = analyze(
      input({
        variables: [variable("NEXT_PUBLIC_ADMIN_PASSWORD", { secret: true }, 2), variable("STRIPE_KEY", { secret: true }, 3)],
        example: "NEXT_PUBLIC_ADMIN_PASSWORD=\nSTRIPE_KEY=\n",
        references: [{ file: "a.ts", references: [ref("NEXT_PUBLIC_ADMIN_PASSWORD"), ref("STRIPE_KEY")] }],
        exposures: [{ file: "next.config.js", names: [{ name: "STRIPE_KEY", line: 3, column: 5 }] }],
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({ code: "ENV005", severity: "error", file: "envsync.config.ts", line: 2, variableName: "NEXT_PUBLIC_ADMIN_PASSWORD" }),
      expect.objectContaining({ code: "ENV005", severity: "error", file: "next.config.js", line: 3, variableName: "STRIPE_KEY" }),
    ]);
    // Confirmed findings cite the explicit declaration and never present themselves as guesses.
    for (const diagnostic of result) {
      expect(diagnostic.message).toContain("declared `secret: true` in envsync.config.ts");
      expect(diagnostic.message).not.toContain("heuristic");
    }
  });

  test("ENV005 heuristic matches whole name segments only, after the public prefix", () => {
    const names = ["NEXT_PUBLIC_TOKENIZER_URL", "NEXT_PUBLIC_SECRETARY_EMAIL", "NEXT_PUBLIC_API_KEY", "NEXT_PUBLIC_db_password"];
    const result = analyze(input({ references: [{ file: "a.ts", references: names.map((name, i) => ref(name, i + 1)) }] }));
    expect(codes(result).filter((code) => code.startsWith("ENV005"))).toEqual(["ENV005:warning:NEXT_PUBLIC_db_password"]);
    expect(result.find((d) => d.code === "ENV005")?.message).toContain('contains "PASSWORD"');
  });

  test("ENV005 heuristic location is deterministic: next.config exposure, else declaration, else first reference", () => {
    const references = [{ file: "b.ts", references: [ref("NEXT_PUBLIC_TOKEN", 9)] }, { file: "a.ts", references: [ref("NEXT_PUBLIC_TOKEN", 4)] }];
    const fromReference = analyze(input({ references })).find((d) => d.code === "ENV005");
    expect(fromReference).toMatchObject({ file: "a.ts", line: 4 });

    const fromDeclaration = analyze(input({ references, variables: [variable("NEXT_PUBLIC_TOKEN", {}, 7)], example: "NEXT_PUBLIC_TOKEN=\n" }));
    expect(fromDeclaration.find((d) => d.code === "ENV005")).toMatchObject({ file: "envsync.config.ts", line: 7 });
  });

  test("ENV005 warning: public name that looks secret, unless explicitly secret: false", () => {
    const references = [{ file: "a.ts", references: [ref("NEXT_PUBLIC_API_TOKEN", 7, 1), ref("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", 8, 1)] }];
    const flagged = analyze(input({ references }));
    expect(codes(flagged).filter((code) => code.startsWith("ENV005"))).toEqual(["ENV005:warning:NEXT_PUBLIC_API_TOKEN"]);
    const warning = flagged.find((d) => d.code === "ENV005");
    expect(warning?.message).toContain('contains "TOKEN"');
    expect(warning?.message).toContain("name-based heuristic, not a confirmed leak");
    expect(warning?.message.startsWith("Possible exposure:")).toBe(true);

    const acknowledged = analyze(
      input({
        variables: [variable("NEXT_PUBLIC_API_TOKEN", { secret: false }), variable("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY")],
        example: "NEXT_PUBLIC_API_TOKEN=\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=\n",
        references,
      }),
    );
    expect(acknowledged).toEqual([]);
  });

  test("ENV006: each dynamic access is an info diagnostic with its location", () => {
    const result = analyze(
      input({
        references: [{ file: "a.ts", references: [{ kind: "dynamic", line: 2, column: 3 }, { kind: "dynamic", line: 5, column: 1 }] }],
      }),
    );
    expect(result.map(({ code, severity, line }) => ({ code, severity, line }))).toEqual([
      { code: "ENV006", severity: "info", line: 2 },
      { code: "ENV006", severity: "info", line: 5 },
    ]);
  });

  test("output order is deterministic regardless of input order", () => {
    const references = [
      { file: "z.ts", references: [ref("Z_MISSING")] },
      { file: "a.ts", references: [ref("A_MISSING")] },
    ];
    const forward = analyze(input({ references, variables: [variable("UNUSED")] }));
    const reversed = analyze(input({ references: [...references].reverse(), variables: [variable("UNUSED")] }));
    expect(reversed).toEqual(forward);
    expect(forward.map((d) => d.file)).toEqual(["a.ts", "envsync.config.ts", "envsync.config.ts", "z.ts"]);
  });
});
