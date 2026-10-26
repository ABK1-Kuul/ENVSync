import { parseConfigSource, parseEnvExample, parseEnvFile, type ParsedConfig, type VariableDefinition } from "@envsync-internal/schema";
import { describe, expect, test } from "vitest";
import { analyze, matchesType, secretValueFormat, type AnalysisInput } from "../src/index.js";

const framework = { name: "Next.js", publicPrefix: "NEXT_PUBLIC_", builtInVariables: ["NODE_ENV"], externallyReadVariables: ["PORT"] };

function variable(name: string, overrides: Partial<Omit<VariableDefinition, "name">> = {}, line = 1): VariableDefinition {
  return { name, required: true, type: "string", location: { line, column: 5 }, ...overrides };
}

/** Every declared variable is referenced and in .env.example, so only env-file findings remain. */
function input(variables: VariableDefinition[], envFiles: Record<string, string>): AnalysisInput {
  const config: ParsedConfig = { variables, issues: [] };
  return {
    configFile: "envsync.config.ts",
    config,
    envExampleFile: ".env.example",
    envExample: parseEnvExample(variables.map(({ name }) => `${name}=`).join("\n")),
    references: [{ file: "a.ts", references: variables.map(({ name }) => ({ kind: "static" as const, name, line: 1, column: 1 })) }],
    exposures: [],
    envFiles: Object.entries(envFiles).map(([file, text]) => ({ file, parsed: parseEnvFile(text) })),
    framework,
  };
}

const summary = (input: AnalysisInput) => analyze(input).map((d) => `${d.code}:${d.severity}:${d.file}:${d.line}:${d.variableName}`);

describe("matchesType", () => {
  test.each([
    ["number", "42", true],
    ["number", " -1.5e3 ", true],
    ["number", "abc", false],
    ["number", "  ", false],
    ["boolean", "TRUE", true],
    ["boolean", "0", true],
    ["boolean", "yes", false],
    ["url", "https://example.com/x", true],
    ["url", "postgres://user@localhost:5432/db", true],
    ["url", "example.com", false],
    ["url", "localhost:3000", false],
    ["string", "anything", true],
  ] as const)("%s %j -> %s", (type, value, expected) => {
    expect(matchesType(value, type)).toBe(expected);
  });

  test("values Next.js may expand ($VAR) are unknown, unless single-quoted", () => {
    expect(matchesType("${PORT_BASE}", "number")).toBeUndefined();
    expect(matchesType("$x", "number", "'")).toBe(false);
  });
});

describe("secretValueFormat", () => {
  test.each([
    [`sk_live_${"a1".repeat(12)}`, "a Stripe secret or restricted key"],
    [`ghp_${"A".repeat(36)}`, "a GitHub token"],
    ["AKIAABCDEFGHIJKLMNOP", "an AWS access key ID"],
    ["-----BEGIN RSA PRIVATE KEY-----\nabc", "a private key"],
    ["postgres://admin:hunter2@db.example.com/app", "a connection string with a password"],
  ])("%s", (value, label) => {
    expect(secretValueFormat(value)).toBe(label);
  });

  test.each([`pk_live_${"a1".repeat(12)}`, "https://example.com", "postgres://user@localhost/db", "", "phc_publicposthogkey"])(
    "publishable or harmless value %j is not flagged",
    (value) => {
      expect(secretValueFormat(value)).toBeUndefined();
    },
  );
});

describe("analyze with runtime env files", () => {
  test("a consistent project with env files produces no diagnostics", () => {
    expect(analyze(input([variable("API_URL", { type: "url" })], { ".env.local": "API_URL=https://example.com\nNODE_ENV=development\nPORT=3000\n" }))).toEqual([]);
  });

  test("no env files read: no env-file findings (values may come from the platform)", () => {
    expect(analyze(input([variable("API_URL")], {}))).toEqual([]);
  });

  test("ENV008 uses the development files by default; the first file in priority order decides, and empty counts as missing", () => {
    const result = summary(
      input([variable("A", {}, 1), variable("B", {}, 2), variable("C", { required: false }, 3), variable("D", {}, 4), variable("E", {}, 5)], {
        // .env.local outranks .env: its empty E hides the value in .env, while D is set in .env.
        ".env": "A=\nD=set\nE=set\n",
        ".env.local": "E=\n",
        ".env.production": "A=prod-only\n", // not loaded in development
        "apps/web/.env.local": "B=set\n", // another app's file never satisfies this config
      }),
    );
    expect(result).toEqual([
      "ENV008:warning:envsync.config.ts:1:A",
      "ENV008:warning:envsync.config.ts:2:B",
      "ENV008:warning:envsync.config.ts:5:E",
    ]);
    const [finding] = analyze(input([variable("A")], { ".env": "", ".env.local": "" }));
    expect(finding?.message).toBe("A is required by envsync.config.ts but has no value for development in .env.local, .env. It may still be provided by the shell or the hosting platform.");
    expect(finding?.suggestion).toContain("Set A in .env.local");
  });

  test("ENV008 per context: production and preview read their own files; without one, missing values are info (platform)", () => {
    const files = { ".env": "SHARED=1\n", ".env.production": "PROD=1\n", ".env.preview": "PREVIEW=1\n", ".env.local": "LOCAL=1\n" };
    const vars = ["SHARED", "PROD", "PREVIEW", "LOCAL"].map((name, i) => variable(name, {}, i + 1));
    const missing = (envContext: NonNullable<AnalysisInput["envContext"]>, envFiles: Record<string, string> = files) =>
      analyze({ ...input(vars, envFiles), envContext }).map((d) => `${d.severity}:${d.variableName}`);

    expect(missing("development")).toEqual(["warning:PROD", "warning:PREVIEW"]);
    expect(missing("production")).toEqual(["warning:PREVIEW"]); // .env.local is loaded by `next build` too
    expect(missing("preview")).toEqual(["warning:LOCAL"]); // preview: .env.preview* over .env.production and .env
    expect(missing("test")).toEqual(["warning:PROD", "warning:PREVIEW", "warning:LOCAL"]);
    // No production-specific file: the values are expected from the hosting platform.
    expect(missing("production", { ".env": "SHARED=1\n" })).toEqual(["info:PROD", "info:PREVIEW", "info:LOCAL"]);
  });

  test("other apps' env files are checked for exposure and duplicates only, never against this config", () => {
    const stripe = `sk_live_${"a1".repeat(12)}`;
    const result = summary(input([variable("A", { type: "number" })], { ".env": "A=1\n", "apps/web/.env": `A=not-a-number\nOTHER_NAME=1\nOTHER_NAME=2\nNEXT_PUBLIC_K=${stripe}\n` }));
    expect(result).toEqual(["ENV007:warning:apps/web/.env:3:OTHER_NAME", "ENV005:error:apps/web/.env:4:NEXT_PUBLIC_K"]);
  });

  test("the root config's `secret: false` does not exempt another app's public variable from the credential check", () => {
    const stripe = `sk_live_${"a1".repeat(12)}`;
    const files = { ".env": "NEXT_PUBLIC_PAY=pk_live_publishable\n", "apps/web/.env": `NEXT_PUBLIC_PAY=${stripe}\n` };
    expect(summary(input([variable("NEXT_PUBLIC_PAY", { secret: false })], files))).toEqual(["ENV005:error:apps/web/.env:1:NEXT_PUBLIC_PAY"]);
  });

  test("ENV008 matches root env file names case-insensitively (as Windows and macOS do); an exact name wins", () => {
    expect(summary(input([variable("A")], { ".ENV.LOCAL": "A=\n", ".env": "A=set\n" }))).toEqual(["ENV008:warning:envsync.config.ts:1:A"]);
    expect(summary(input([variable("A")], { ".ENV.LOCAL": "A=\n", ".env.local": "A=set\n" }))).toEqual([]);
  });

  test("ENV009: set in an env file but not declared; framework variables are exempt", () => {
    expect(summary(input([variable("A")], { ".env": "A=1\nEXTRA_VAR=2\nNODE_ENV=production\nPORT=1\n" }))).toEqual(["ENV009:warning:.env:2:EXTRA_VAR"]);
  });

  test("ENV010: a value that does not match the declared type; no value unless requested, never in the message", () => {
    const vars = [variable("PORT_NUMBER", { type: "number" }), variable("DEBUG", { type: "boolean" }), variable("SITE", { type: "url" })];
    const files = { ".env": "PORT_NUMBER=eighty\nDEBUG=true\nSITE=not-a-url\n" };
    const plain = analyze(input(vars, files));
    expect(plain.map((d) => `${d.code}:${d.severity}:${d.variableName}`)).toEqual(["ENV010:error:PORT_NUMBER", "ENV010:error:SITE"]);
    expect(plain.some((d) => "value" in d || "valueRedacted" in d)).toBe(false);

    const shown = analyze({ ...input(vars, files), includeValues: true });
    expect(shown.map((d) => [d.value, d.valueRedacted])).toEqual([
      ["eighty", undefined],
      ["not-a-url", undefined],
    ]);
    for (const d of shown) expect(`${d.message} ${d.suggestion}`).not.toMatch(/eighty|not-a-url/);
  });

  test("a malformed connection URL is never shown, whatever made it malformed (password with `/`, missing scheme, cut at `#`)", () => {
    const vars = [variable("DATABASE_URL", { type: "url" }), variable("BACKUP_URL", { type: "url" }), variable("REPLICA_URL", { type: "url" })];
    const files = { ".env": "DATABASE_URL=postgres://admin:p4ss/w0rd@db:5432/app\nBACKUP_URL=admin:hunter2@db:5432/app\nREPLICA_URL=postgres://u:ab#cd@h\n" };
    const result = analyze({ ...input(vars, files), includeValues: true });
    expect(result.map((d) => `${d.code}:${d.variableName}:${d.valueRedacted}`)).toEqual([
      "ENV010:DATABASE_URL:true",
      "ENV010:BACKUP_URL:true",
      "ENV010:REPLICA_URL:true",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/p4ss|hunter2|admin:|:ab/);
  });

  test("connection strings with a password are recognized as credentials, including unencoded `/` and no scheme", () => {
    for (const value of ["postgres://admin:p4ss/w0rd@db:5432/app", "admin:hunter2@db:5432/app", "redis://default:pw@cache:6379"]) {
      expect(secretValueFormat(value)).toBe("a connection string with a password");
    }
    for (const value of ["https://user@example.com", "mailto:someone@example.com", "postgres://user@localhost/db", "a b:c@d"]) {
      expect(secretValueFormat(value)).toBeUndefined();
    }
  });

  test("ADR-016: with values requested, private and credential-shaped values are redacted to kind and length", () => {
    const stripe = `sk_live_${"a1".repeat(12)}`;
    const vars = [
      variable("SECRET_PORT", { type: "number", secret: true }),
      variable("SENSITIVE_PORT", { type: "number", visibility: "sensitive", secret: true }),
      variable("API_TOKEN", { type: "number" }), // secret-looking name, no classification
      variable("CRED_AS_NUMBER", { type: "number" }), // credential-shaped value
      variable("PLAIN_PORT", { type: "number", visibility: "plain", secret: false }),
      variable("DB_PASS", { type: "number" }), // private-looking name without a whole-segment match
      variable("SIGNING_KEY_ID", { type: "number" }),
    ];
    const result = analyze({
      ...input(vars, { ".env": `SECRET_PORT=hunter2\nSENSITIVE_PORT=abc\nAPI_TOKEN=xyz\nCRED_AS_NUMBER=${stripe}\nPLAIN_PORT=eighty\nDB_PASS=x\nSIGNING_KEY_ID=${"y".repeat(70)}\n` }),
      includeValues: true,
    });
    // Only a length range is given, never the exact length.
    expect(result.map((d) => `${d.variableName}=${d.value}${d.valueRedacted ? " (redacted)" : ""}`)).toEqual([
      "SECRET_PORT=<redacted: secret value, fewer than 16 characters> (redacted)",
      "SENSITIVE_PORT=<redacted: sensitive value, fewer than 16 characters> (redacted)",
      "API_TOKEN=<redacted: possibly secret value, fewer than 16 characters> (redacted)",
      "CRED_AS_NUMBER=<redacted: a Stripe secret or restricted key, 16 to 64 characters> (redacted)",
      "PLAIN_PORT=eighty",
      "DB_PASS=<redacted: possibly secret value, fewer than 16 characters> (redacted)",
      "SIGNING_KEY_ID=<redacted: possibly secret value, more than 64 characters> (redacted)",
    ]);
  });

  test("when `secret` and `visibility` disagree, the variable is treated as private (and ENV004 is reported)", () => {
    const { variables, issues } = parseConfigSource('export default { variables: { TOKENISH_PORT: { type: "number", secret: true, visibility: "plain" } } };');
    expect(issues).toHaveLength(1);
    const result = analyze({ ...input(variables, { ".env": "TOKENISH_PORT=eighty\n" }), includeValues: true });
    expect(result).toEqual([expect.objectContaining({ code: "ENV010", value: "<redacted: secret value, fewer than 16 characters>", valueRedacted: true })]);
  });

  test("ENV005: a client-visible variable whose value looks like a secret; `secret: false` and server-only names are exempt", () => {
    const stripe = `sk_live_${"a1".repeat(12)}`;
    const result = analyze({
      ...input([variable("NEXT_PUBLIC_PAY"), variable("NEXT_PUBLIC_OK", { secret: false }), variable("SERVER_KEY"), variable("EXPOSED")], {
        ".env": `NEXT_PUBLIC_PAY=${stripe}\nNEXT_PUBLIC_OK=${stripe}\nSERVER_KEY=${stripe}\nEXPOSED=${stripe}\n`,
      }),
      includeValues: true,
    });
    expect(result.map((d) => `${d.code}:${d.severity}:${d.variableName}`)).toEqual(["ENV005:error:NEXT_PUBLIC_PAY"]);
    expect(result[0]?.message).toContain("looks like a Stripe secret or restricted key");
    // Even with values requested, a detected credential is never shown (ADR-016).
    expect(result[0]).toMatchObject({ value: "<redacted: a Stripe secret or restricted key, 16 to 64 characters>", valueRedacted: true });
    expect(JSON.stringify(result)).not.toContain("a1a1");

    const exposed = input([variable("EXPOSED")], { ".env": `EXPOSED=${stripe}\n` });
    exposed.exposures = [{ file: "next.config.js", names: [{ name: "EXPOSED", line: 2, column: 3 }] }];
    expect(analyze(exposed).map((d) => `${d.code}:${d.file}:${d.variableName}`)).toEqual(["ENV005:.env:EXPOSED"]);
  });

  test("ENV007: a name set more than once in one env file", () => {
    expect(summary(input([variable("A")], { ".env.local": "A=1\nA=2\n" }))).toEqual(["ENV007:warning:.env.local:2:A"]);
  });

  test("env-file names are printed only if known or conventional (UPPER_CASE with an underscore); others by line only", () => {
    const random = "Kq1fZ9Rs7gT0Xj2EhQ";
    const fragments = ["Xy9QzT2a", "JBSWY3DPEHPK3PXPJBSW", "ABCDEF"]; // short base64, base32, upper-case only
    const text = `A=1\n${random}=\n${random}=\nweird.name=1\nlower_case_hidden=1\n${fragments.map((f) => `${f}=`).join("\n")}\nUPPER_CASE_OK=1\nREFERENCED=1\n`;
    const withReference = input([variable("A")], { ".env": text });
    withReference.references = [{ file: "a.ts", references: [{ kind: "static", name: "A", line: 1, column: 1 }, { kind: "static", name: "REFERENCED", line: 2, column: 1 }] }];
    const result = analyze(withReference).filter((d) => d.file === ".env");
    expect(result.map((d) => `${d.code}:${d.line}:${d.variableName ?? "(hidden)"}`)).toEqual([
      // The repeated name keeps its last assignment (line 3), so ENV009 is reported there once.
      "ENV007:3:(hidden)",
      "ENV009:3:(hidden)",
      "ENV009:4:(hidden)",
      "ENV009:5:(hidden)",
      "ENV009:6:(hidden)",
      "ENV009:7:(hidden)",
      "ENV009:8:(hidden)",
      "ENV009:9:UPPER_CASE_OK",
      "ENV009:10:REFERENCED", // referenced in source, so already known
    ]);
    for (const d of result) expect(`${d.message} ${d.suggestion}`).not.toMatch(/Kq1fZ9|weird\.name|lower_case|Xy9QzT2a|JBSWY3|ABCDEF/);
  });
});
