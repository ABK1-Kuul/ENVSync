import ts from "typescript";
import { isValidVariableName, isVariableType, VARIABLE_TYPES, type VariableType } from "./validation.js";

/**
 * Static reader for `envsync.config.ts` (ADR-005).
 *
 * The file is parsed into a TypeScript AST and only a constrained literal subset is understood.
 * It is never imported, evaluated or executed. Anything outside the subset becomes a `ConfigIssue`
 * instead of being "resolved", so a malicious or unusual config cannot run code or mislead the scan.
 *
 * Messages never echo literal values from the config (descriptions, invalid type strings, etc.).
 */

export type SourceLocation = { line: number; column: number };

export type VariableDefinition = {
  name: string;
  /** Defaults to true. */
  required: boolean;
  /** `undefined` when the config does not say; consumers must not assume either way. */
  secret?: boolean;
  /** Defaults to "string". */
  type: VariableType;
  description?: string;
  location: SourceLocation;
};

export type ConfigIssue = {
  kind: "invalid" | "duplicate";
  message: string;
  suggestion: string;
  location?: SourceLocation;
  variableName?: string;
};

export type ParsedConfig = {
  variables: VariableDefinition[];
  issues: ConfigIssue[];
};

const DEFINITION_FIELDS = ["required", "secret", "type", "description"] as const;
type DefinitionField = (typeof DEFINITION_FIELDS)[number];

const SUPPORTED_SHAPE =
  "Use `export default defineConfig({ variables: { NAME: { required: true } } })` with literal values only.";

export function parseConfigSource(sourceText: string, fileName = "envsync.config.ts"): ParsedConfig {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const issues: ConfigIssue[] = [];
  const at = (node: ts.Node): SourceLocation => locationOf(sourceFile, node);

  const syntaxError = firstSyntaxError(sourceText, fileName);
  if (syntaxError) {
    issues.push({
      kind: "invalid",
      message: `${fileName} has a syntax error: ${syntaxError.text}`,
      suggestion: "Fix the syntax error, then run the scan again.",
      ...(syntaxError.location ? { location: syntaxError.location } : {}),
    });
    return { variables: [], issues };
  }

  checkTopLevelStatements(sourceFile, fileName, issues);

  const exported = findDefaultExport(sourceFile);
  if (!exported) {
    issues.push({
      kind: "invalid",
      message: `${fileName} has no default export.`,
      suggestion: SUPPORTED_SHAPE,
    });
    return { variables: [], issues };
  }

  const root = resolveConfigObject(exported, sourceFile);
  if (!root) {
    issues.push({
      kind: "invalid",
      message: `The default export of ${fileName} is not a static object literal. EnvSync never runs config code, so computed configs are not supported.`,
      suggestion: SUPPORTED_SHAPE,
      location: at(exported),
    });
    return { variables: [], issues };
  }

  let variablesObject: ts.ObjectLiteralExpression | undefined;
  let variablesKeyFound = false;
  for (const property of root.properties) {
    const name = ts.isPropertyAssignment(property) ? staticPropertyName(property.name) : undefined;
    if (ts.isPropertyAssignment(property) && name === "variables") {
      if (variablesKeyFound) {
        // At runtime the last key would silently win; report it instead of picking one.
        issues.push({
          kind: "duplicate",
          message: "`variables` is declared more than once in the config object. Only the first one is used.",
          suggestion: "Merge the declarations into a single `variables` object.",
          location: at(property),
        });
        continue;
      }
      variablesKeyFound = true;
      const value = unwrapExpression(property.initializer);
      if (ts.isObjectLiteralExpression(value)) {
        variablesObject = value;
      } else {
        issues.push({
          kind: "invalid",
          message: "`variables` must be an object literal.",
          suggestion: SUPPORTED_SHAPE,
          location: at(value),
        });
      }
    } else {
      issues.push({
        kind: "invalid",
        message: name === undefined ? "Unsupported entry in the config object." : `Unknown config key \`${name}\`.`,
        suggestion: "The config object supports only the `variables` key.",
        location: at(property),
      });
    }
  }

  if (!variablesObject) {
    if (!variablesKeyFound) {
      issues.push({
        kind: "invalid",
        message: `${fileName} does not declare \`variables\`.`,
        suggestion: SUPPORTED_SHAPE,
        location: at(root),
      });
    }
    return { variables: [], issues };
  }

  const variables: VariableDefinition[] = [];
  const firstSeen = new Map<string, SourceLocation>();

  for (const property of variablesObject.properties) {
    if (!ts.isPropertyAssignment(property)) {
      issues.push({
        kind: "invalid",
        message: ts.isSpreadAssignment(property)
          ? "Spread entries in `variables` are not supported because EnvSync never evaluates config code."
          : "Each entry in `variables` must be written as `NAME: { ... }`.",
        suggestion: "Declare each variable explicitly as a property with an object literal value.",
        location: at(property),
      });
      continue;
    }

    const name = staticPropertyName(property.name);
    if (name === undefined) {
      issues.push({
        kind: "invalid",
        message: "Computed variable names are not supported because EnvSync never evaluates config code.",
        suggestion: "Write the variable name literally, for example `DATABASE_URL: { required: true }`.",
        location: at(property.name),
      });
      continue;
    }

    const location = at(property.name);
    if (!isValidVariableName(name)) {
      issues.push({
        kind: "invalid",
        message: `\`${name}\` is not a valid environment variable name.`,
        suggestion: "Use letters, digits and underscores only, not starting with a digit (for example `API_URL`).",
        location,
        variableName: name,
      });
      continue;
    }

    const previous = firstSeen.get(name);
    if (previous) {
      issues.push({
        kind: "duplicate",
        message: `${name} is declared more than once (first declared on line ${previous.line}).`,
        suggestion: "Keep a single declaration. Only the first one is used.",
        location,
        variableName: name,
      });
      continue;
    }
    firstSeen.set(name, location);

    variables.push(parseDefinition(name, property.initializer, location, sourceFile, issues));
  }

  return { variables, issues };
}

function parseDefinition(
  name: string,
  initializer: ts.Expression,
  location: SourceLocation,
  sourceFile: ts.SourceFile,
  issues: ConfigIssue[],
): VariableDefinition {
  const definition: VariableDefinition = { name, required: true, type: "string", location };
  const value = unwrapExpression(initializer);
  const invalid = (node: ts.Node, message: string, suggestion: string): void => {
    issues.push({ kind: "invalid", message, suggestion, location: locationOf(sourceFile, node), variableName: name });
  };

  if (!ts.isObjectLiteralExpression(value)) {
    invalid(value, `The definition of ${name} must be an object literal.`, "Write it as `{ required: true }` or `{}` for defaults.");
    return definition;
  }

  const seenFields = new Set<string>();
  for (const property of value.properties) {
    const field = ts.isPropertyAssignment(property) ? staticPropertyName(property.name) : undefined;
    if (!ts.isPropertyAssignment(property) || field === undefined) {
      invalid(property, `Unsupported entry in the definition of ${name}.`, `Use only literal fields: ${DEFINITION_FIELDS.join(", ")}.`);
      continue;
    }
    if (!isDefinitionField(field)) {
      invalid(property, `Unknown field \`${field}\` in the definition of ${name}.`, `Supported fields are: ${DEFINITION_FIELDS.join(", ")}.`);
      continue;
    }
    if (seenFields.has(field)) {
      invalid(property, `Field \`${field}\` is set more than once for ${name}.`, "Remove the repeated field.");
      continue;
    }
    seenFields.add(field);

    const fieldValue = unwrapExpression(property.initializer);
    switch (field) {
      case "required":
      case "secret": {
        const literal = booleanLiteral(fieldValue);
        if (literal === undefined) {
          invalid(fieldValue, `\`${field}\` for ${name} must be the literal \`true\` or \`false\`.`, "Replace the expression with a boolean literal.");
        } else {
          definition[field] = literal;
        }
        break;
      }
      case "type": {
        const literal = stringLiteral(fieldValue);
        if (literal === undefined || !isVariableType(literal)) {
          invalid(fieldValue, `\`type\` for ${name} must be one of: ${VARIABLE_TYPES.join(", ")}.`, "Use one of the supported type names as a string literal.");
        } else {
          definition.type = literal;
        }
        break;
      }
      case "description": {
        const literal = stringLiteral(fieldValue);
        if (literal === undefined) {
          invalid(fieldValue, `\`description\` for ${name} must be a string literal.`, "Write the description as a plain string.");
        } else {
          definition.description = literal;
        }
        break;
      }
    }
  }

  return definition;
}

function firstSyntaxError(sourceText: string, fileName: string): { text: string; location?: SourceLocation } | undefined {
  // transpileModule reports syntactic diagnostics only. Its JavaScript output is discarded, never run.
  const { diagnostics = [] } = ts.transpileModule(sourceText, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest },
  });
  const first = diagnostics.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (!first) return undefined;
  const text = ts.flattenDiagnosticMessageText(first.messageText, " ");
  if (first.file && first.start !== undefined) {
    const { line, character } = first.file.getLineAndCharacterOfPosition(first.start);
    return { text, location: { line: line + 1, column: character + 1 } };
  }
  return { text };
}

/**
 * The config is never run, so any top-level code that would run (calls, assignments, mutation of
 * the config object, class static blocks, `export =`, a second default export) is reported rather
 * than silently ignored: otherwise the file could mean something different at runtime than here.
 * Allowed: imports, type declarations, re-exports, function declarations (inert until called),
 * one default export, and `const`/`let`/`var` declarations whose initializers have no side effects.
 */
function checkTopLevelStatements(sourceFile: ts.SourceFile, fileName: string, issues: ConfigIssue[]): void {
  let defaultExportSeen = false;
  const unsupported = (node: ts.Node, message: string): void => {
    issues.push({
      kind: "invalid",
      message,
      suggestion: `Remove this statement. ${fileName} is read as data, so it must only declare literal values.`,
      location: locationOf(sourceFile, node),
    });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) {
        unsupported(statement, "`export =` is not supported. Use `export default`.");
      } else if (defaultExportSeen) {
        unsupported(statement, `${fileName} has more than one default export. Only the first one is used.`);
      } else {
        defaultExportSeen = true;
      }
    } else if (ts.isVariableStatement(statement)) {
      const effect = findRuntimeEffect(statement.declarationList);
      if (effect) {
        unsupported(effect, `This top-level code would run when the file executes, but EnvSync never runs ${fileName}, so it is ignored.`);
      }
    } else if (
      !ts.isImportDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isFunctionDeclaration(statement) &&
      !ts.isEmptyStatement(statement) &&
      !ts.isExportDeclaration(statement) &&
      !(ts.isModuleDeclaration(statement) && hasDeclareModifier(statement))
    ) {
      unsupported(statement, `This top-level statement would run when the file executes, but EnvSync never runs ${fileName}, so it is ignored.`);
    }
  }
}

/** First node under `root` that would have an effect when evaluated. Function bodies are not entered. */
function findRuntimeEffect(root: ts.Node): ts.Node | undefined {
  const stack: ts.Node[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (ts.isCallExpression(node)) {
      const isDefineConfig = ts.isIdentifier(node.expression) && node.expression.text === "defineConfig";
      if (!isDefineConfig) return node;
    } else if (
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isDeleteExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isClassLike(node) ||
      (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) ||
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))
    ) {
      return node;
    }
    if (ts.isFunctionLike(node)) continue;
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
  }
  return undefined;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function hasDeclareModifier(node: ts.ModuleDeclaration): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false;
}

function findDefaultExport(sourceFile: ts.SourceFile): ts.Expression | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) return statement.expression;
  }
  return undefined;
}

/**
 * Follows the supported wrappers around the config object: `defineConfig(...)`, `as const`,
 * `satisfies T`, parentheses, and a reference to a top-level `const` in the same file.
 */
function resolveConfigObject(expression: ts.Expression, sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  const visitedIdentifiers = new Set<string>();
  let current = unwrapExpression(expression);

  for (let step = 0; step < 4; step++) {
    if (ts.isObjectLiteralExpression(current)) return current;

    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === "defineConfig" && current.arguments.length === 1) {
      current = unwrapExpression(current.arguments[0] as ts.Expression);
    } else if (ts.isIdentifier(current) && !visitedIdentifiers.has(current.text)) {
      visitedIdentifiers.add(current.text);
      const initializer = findTopLevelConstInitializer(sourceFile, current.text);
      if (!initializer) return undefined;
      current = unwrapExpression(initializer);
    } else {
      return undefined;
    }
  }
  return ts.isObjectLiteralExpression(current) ? current : undefined;
}

function findTopLevelConstInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
    }
  }
  return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrapExpression(name.expression);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  }
  return undefined;
}

function booleanLiteral(expression: ts.Expression): boolean | undefined {
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function stringLiteral(expression: ts.Expression): string | undefined {
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) ? expression.text : undefined;
}

function isDefinitionField(field: string): field is DefinitionField {
  return (DEFINITION_FIELDS as readonly string[]).includes(field);
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): SourceLocation {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}
