import ts from "typescript";
import { locationOf, parseSource, unwrapExpression, walk, type Location } from "./ast.js";

export const NEXT_CONFIG_FILE_NAMES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "next.config.mts",
] as const;

export type ExposedName = { name: string } & Location;

/**
 * Names listed under an `env: { ... }` object in a Next.js config. Next.js inlines these into
 * client bundles, so a secret listed here is exposed to the browser. The file is parsed, never run.
 */
export function extractNextConfigEnvKeys(sourceText: string, fileName: string): ExposedName[] {
  const sourceFile = parseSource(sourceText, fileName);
  const exposed: ExposedName[] = [];

  walk(sourceFile, (node) => {
    if (!ts.isPropertyAssignment(node) || propertyName(node.name) !== "env") return;
    const value = unwrapExpression(node.initializer);
    if (!ts.isObjectLiteralExpression(value)) return;
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
      const name = propertyName(property.name);
      if (name !== undefined) exposed.push({ name, ...locationOf(sourceFile, property) });
    }
  });

  return exposed;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : undefined;
}
