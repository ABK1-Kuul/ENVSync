import { describe, expect, test } from "vitest";
import { extractEnvReferences, extractNextConfigEnvKeys } from "../src/index.js";

const staticNames = (source: string, fileName = "file.ts") =>
  extractEnvReferences(source, fileName).flatMap((reference) => (reference.kind === "static" ? [reference.name] : []));

const dynamicCount = (source: string, fileName = "file.ts") =>
  extractEnvReferences(source, fileName).filter((reference) => reference.kind === "dynamic").length;

describe("extractEnvReferences: static access", () => {
  test.each([
    ["dot access", "process.env.API_URL"],
    ["double-quoted bracket", 'process.env["API_URL"]'],
    ["single-quoted bracket", "process.env['API_URL']"],
    ["template bracket", "process.env[`API_URL`]"],
    ["optional chaining", "process?.env?.API_URL"],
    ["parenthesized", "(process.env).API_URL"],
    ["non-null", "process.env.API_URL!"],
    ["cast", "(process.env as Record<string, string>).API_URL"],
    ["process['env']", 'process["env"].API_URL'],
    ["assignment target", 'process.env.API_URL = "x"'],
    ["in operator", '"API_URL" in process.env'],
  ])("%s", (_label, expression) => {
    expect(staticNames(`const value = ${expression};`)).toEqual(["API_URL"]);
    expect(dynamicCount(`const value = ${expression};`)).toBe(0);
  });

  test("destructuring with rename, defaults, quoted and computed literal keys", () => {
    expect(staticNames(`const { A, B: renamed, C = "fallback", "D": d, ["E"]: e } = process.env;`)).toEqual(["A", "B", "C", "D", "E"]);
  });

  test("reports the location of the access", () => {
    expect(extractEnvReferences(`const a = 1;\n  const url = process.env.API_URL;`, "file.ts")).toEqual([
      { kind: "static", name: "API_URL", line: 2, column: 15 },
    ]);
  });
});

describe("extractEnvReferences: dynamic access", () => {
  test.each([
    ["computed key", "process.env[name]"],
    ["concatenated key", 'process.env["API_" + suffix]'],
    ["alias", "const env = process.env"],
    ["Object.keys", "Object.keys(process.env)"],
    ["spread", "({ ...process.env })"],
    ["passed to function", "load(process.env)"],
    ["in with variable", "name in process.env"],
  ])("%s", (_label, statement) => {
    const source = `${statement};`;
    expect(staticNames(source)).toEqual([]);
    expect(dynamicCount(source)).toBe(1);
  });

  test("rest and computed destructuring are dynamic while literal keys stay static", () => {
    const references = extractEnvReferences(`const { A, [key]: b, ...rest } = process.env;`, "file.ts");
    expect(references.map((reference) => (reference.kind === "static" ? reference.name : "dynamic"))).toEqual(["A", "dynamic", "dynamic"]);
  });
});

describe("extractEnvReferences: what must not match", () => {
  test("strings, comments and template text are ignored", () => {
    const source = `// process.env.IN_COMMENT
/* process.env.IN_BLOCK */
const text = "process.env.IN_STRING";
const template = \`process.env.IN_TEMPLATE \${1}\`;`;
    expect(extractEnvReferences(source, "file.ts")).toEqual([]);
  });

  test("other objects named env, and type positions, are ignored", () => {
    const source = `const config = { env: {} };
config.env.NOT_PROCESS;
import.meta.env.VITE_THING;
type Env = typeof process.env;
declare global { namespace NodeJS { interface ProcessEnv { TYPED_ONLY: string } } }`;
    expect(extractEnvReferences(source, "file.ts")).toEqual([]);
  });
});

describe("extractEnvReferences: file kinds", () => {
  test.each([
    ["page.tsx", "export default () => <a href={process.env.SITE_URL}>x</a>;"],
    ["page.jsx", "export default () => <a href={process.env.SITE_URL}>x</a>;"],
    ["page.js", "export default () => <a href={process.env.SITE_URL}>x</a>;"],
    ["config.mjs", "export const url = process.env.SITE_URL;"],
    ["config.cjs", "module.exports = process.env.SITE_URL;"],
    ["module.mts", "export const url: string | undefined = process.env.SITE_URL;"],
    ["module.cts", "export const url = process.env.SITE_URL as string;"],
  ])("%s", (fileName, source) => {
    expect(staticNames(source, fileName)).toEqual(["SITE_URL"]);
  });

  test("malformed source does not throw and still yields recoverable references", () => {
    expect(() => extractEnvReferences("const a = process.env.API_URL;\nfunction (", "broken.ts")).not.toThrow();
    expect(staticNames("const a = process.env.API_URL;\nfunction (", "broken.ts")).toEqual(["API_URL"]);
  });
});

describe("extractNextConfigEnvKeys", () => {
  test("lists keys under env objects with locations", () => {
    const source = `const STRIPE_KEY = process.env.STRIPE_KEY;
module.exports = {
  reactStrictMode: true,
  env: {
    PUBLIC_A: "a",
    "PUBLIC_B": process.env.PUBLIC_B,
    STRIPE_KEY,
  },
};`;
    expect(extractNextConfigEnvKeys(source, "next.config.js")).toEqual([
      { name: "PUBLIC_A", line: 5, column: 5 },
      { name: "PUBLIC_B", line: 6, column: 5 },
      { name: "STRIPE_KEY", line: 7, column: 5 },
    ]);
  });

  test("ignores configs without an env object", () => {
    expect(extractNextConfigEnvKeys(`export default { env: process.env, images: {} };`, "next.config.mjs")).toEqual([]);
  });
});
