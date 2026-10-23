import ts from "typescript";
import { locationOf, parseSource, stringLiteralText, unwrapExpression, walk, type Location } from "./ast.js";

export type EnvReference =
  | ({ kind: "static"; name: string } & Location)
  | ({ kind: "dynamic" } & Location);

/**
 * Finds `process.env` accesses using the TypeScript AST.
 *
 * Static (name known):  `process.env.NAME`, `process.env["NAME"]`, `const { NAME } = process.env`,
 *                       `"NAME" in process.env`.
 * Dynamic (name unknown): computed keys, rest destructuring, and any other use of `process.env`
 *                       as a value (aliasing, spreading, passing it to a function).
 *
 * Text inside strings and comments is never matched because only real AST nodes are inspected.
 */
export function extractEnvReferences(sourceText: string, fileName: string): EnvReference[] {
  const sourceFile = parseSource(sourceText, fileName);
  const references: EnvReference[] = [];
  const staticRef = (name: string, node: ts.Node): void => {
    references.push({ kind: "static", name, ...locationOf(sourceFile, node) });
  };
  const dynamicRef = (node: ts.Node): void => {
    references.push({ kind: "dynamic", ...locationOf(sourceFile, node) });
  };

  walk(sourceFile, (node) => {
    if (!isProcessEnv(node)) return;

    let outer: ts.Expression = node;
    while (isTransparentWrapper(outer.parent) && outer.parent.expression === outer) outer = outer.parent;
    const parent = outer.parent;

    if (ts.isPropertyAccessExpression(parent) && parent.expression === outer && ts.isIdentifier(parent.name)) {
      staticRef(parent.name.text, parent);
    } else if (ts.isElementAccessExpression(parent) && parent.expression === outer) {
      const name = stringLiteralText(parent.argumentExpression);
      if (name === undefined) dynamicRef(parent);
      else staticRef(name, parent);
    } else if (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isObjectBindingPattern(parent.name)) {
      for (const element of parent.name.elements) {
        const name = element.dotDotDotToken ? undefined : bindingKeyName(element);
        if (name === undefined) dynamicRef(element);
        else staticRef(name, element);
      }
    } else if (
      ts.isBinaryExpression(parent) &&
      parent.right === outer &&
      parent.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      stringLiteralText(parent.left) !== undefined
    ) {
      staticRef(stringLiteralText(parent.left) as string, parent);
    } else {
      dynamicRef(node);
    }
  });

  return references;
}

/** Matches `process.env` and `process["env"]`, allowing optional chaining and parentheses. */
function isProcessEnv(node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  let target: ts.Expression;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && node.name.text === "env") {
    target = node.expression;
  } else if (ts.isElementAccessExpression(node) && stringLiteralText(node.argumentExpression) === "env") {
    target = node.expression;
  } else {
    return false;
  }
  const object = unwrapExpression(target);
  return ts.isIdentifier(object) && object.text === "process";
}

function isTransparentWrapper(
  node: ts.Node,
): node is ts.ParenthesizedExpression | ts.NonNullExpression | ts.AsExpression | ts.SatisfiesExpression | ts.TypeAssertion {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

function bindingKeyName(element: ts.BindingElement): string | undefined {
  const key = element.propertyName ?? element.name;
  if (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return key.text;
  if (ts.isComputedPropertyName(key)) return stringLiteralText(key.expression);
  return undefined;
}
