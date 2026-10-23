import path from "node:path";
import ts from "typescript";

export type Location = { line: number; column: number };

export function parseSource(sourceText: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  switch (path.extname(fileName).toLowerCase()) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      // JS files are parsed with JSX enabled, which Next.js allows in `.js`.
      return ts.ScriptKind.JS;
  }
}

/** Strips syntax that does not change which value is accessed: parentheses, `!`, `as`, `satisfies`. */
export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function stringLiteralText(expression: ts.Expression): string | undefined {
  const inner = unwrapExpression(expression);
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : undefined;
}

export function locationOf(sourceFile: ts.SourceFile, node: ts.Node): Location {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

/** Depth-first walk without recursion so deeply nested input cannot exhaust the call stack here. */
export function walk(root: ts.Node, visit: (node: ts.Node) => void): void {
  const stack: ts.Node[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    visit(node);
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as ts.Node);
  }
}
