import type { ParsedConfig, ParsedEnvExample, VariableDefinition } from "@envsync/schema";
import { compareDiagnostics, type Diagnostic } from "./diagnostics.js";
import type { ClientExposedName, ExtractedReference, FrameworkAdapter } from "./framework.js";

export type FileReferences = { file: string; references: readonly ExtractedReference[] };

export type FileExposures = { file: string; names: readonly ClientExposedName[] };

export type AnalysisInput = {
  configFile: string;
  config: ParsedConfig;
  envExampleFile: string;
  /** `null` when the project has no `.env.example`. */
  envExample: ParsedEnvExample | null;
  references: readonly FileReferences[];
  exposures: readonly FileExposures[];
  framework: Pick<FrameworkAdapter, "name" | "publicPrefix" | "builtInVariables">;
};

// Name segments that suggest a value must stay private. "KEY" is deliberately absent:
// publishable/public API keys commonly carry a public prefix on purpose.
const SECRET_NAME_SEGMENTS = new Set(["SECRET", "PASSWORD", "PASSWD", "PRIVATE", "TOKEN", "CREDENTIALS"]);

/**
 * Compares source evidence with the declared contract. Pure: no filesystem access.
 * Only variable names and locations reach diagnostics; values are never available here.
 */
export function analyze(input: AnalysisInput): Diagnostic[] {
  const { configFile, config, envExampleFile, envExample, framework } = input;
  const diagnostics: Diagnostic[] = [];
  const declared = new Map<string, VariableDefinition>(config.variables.map((definition) => [definition.name, definition]));
  const atDeclaration = (definition: VariableDefinition) => ({
    file: configFile,
    line: definition.location.line,
    column: definition.location.column,
    variableName: definition.name,
  });

  for (const issue of config.issues) {
    diagnostics.push({
      code: issue.kind === "duplicate" ? "ENV007" : "ENV004",
      severity: "error",
      message: issue.message,
      file: configFile,
      ...(issue.location ? { line: issue.location.line, column: issue.location.column } : {}),
      ...(issue.variableName !== undefined ? { variableName: issue.variableName } : {}),
      suggestion: issue.suggestion,
    });
  }

  for (const duplicate of envExample?.duplicates ?? []) {
    diagnostics.push({
      code: "ENV007",
      severity: "warning",
      message: `${duplicate.name} appears more than once in ${envExampleFile} (first on line ${duplicate.firstLine}).`,
      file: envExampleFile,
      line: duplicate.line,
      variableName: duplicate.name,
      suggestion: "Remove the repeated entry so the example has one placeholder per variable.",
    });
  }

  type Occurrence = { file: string; line: number; column: number };
  const staticOccurrences = new Map<string, Occurrence[]>();
  let dynamicCount = 0;
  for (const { file, references } of [...input.references].sort((a, b) => compare(a.file, b.file))) {
    for (const reference of references) {
      const occurrence = { file, line: reference.line, column: reference.column };
      if (reference.kind === "dynamic") {
        dynamicCount++;
        diagnostics.push({
          code: "ENV006",
          severity: "info",
          message: "Dynamic process.env access cannot be fully analyzed; variables read here are not checked.",
          ...occurrence,
          suggestion: 'Read each variable with a literal name, such as process.env.NAME or process.env["NAME"].',
        });
        continue;
      }
      const list = staticOccurrences.get(reference.name) ?? [];
      list.push(occurrence);
      staticOccurrences.set(reference.name, list);
    }
  }

  const exposedNames = new Map<string, Occurrence>();
  for (const { file, names } of input.exposures) {
    for (const exposed of names) {
      if (!exposedNames.has(exposed.name)) exposedNames.set(exposed.name, { file, line: exposed.line, column: exposed.column });
    }
  }

  const builtIns = new Set(framework.builtInVariables);
  for (const [name, occurrences] of staticOccurrences) {
    if (declared.has(name) || builtIns.has(name)) continue;
    const first = occurrences[0] as Occurrence;
    const others = occurrences.length - 1;
    diagnostics.push({
      code: "ENV001",
      severity: "error",
      message:
        `${name} is referenced but not declared in ${configFile}.` +
        (others > 0 ? ` It is also referenced in ${others} other ${others === 1 ? "place" : "places"}.` : ""),
      ...first,
      variableName: name,
      suggestion: `Add ${name} under \`variables\` in ${configFile}, or remove the reference if it is a mistake.`,
    });
  }

  const exampleNames = new Set(envExample?.entries.map((entry) => entry.name));
  for (const definition of declared.values()) {
    if (definition.required && !exampleNames.has(definition.name)) {
      diagnostics.push({
        code: "ENV002",
        severity: "error",
        message:
          envExample === null
            ? `${definition.name} is required by ${configFile}, but ${envExampleFile} was not found.`
            : `${definition.name} is required by ${configFile} but absent from ${envExampleFile}.`,
        ...atDeclaration(definition),
        suggestion: `Add a placeholder line \`${definition.name}=\` to ${envExampleFile}. Do not copy a real value.`,
      });
    }

    if (!staticOccurrences.has(definition.name) && !exposedNames.has(definition.name)) {
      diagnostics.push({
        code: "ENV003",
        severity: "warning",
        message:
          `${definition.name} is declared but no static reference to it was found. It may be unused, ` +
          `or read by ${framework.name}, a dependency, or dynamic access.` +
          (dynamicCount > 0 ? ` The project has ${dynamicCount} dynamic process.env ${dynamicCount === 1 ? "access" : "accesses"}.` : ""),
        ...atDeclaration(definition),
        suggestion: "Remove the declaration if it is no longer used; otherwise keep it.",
      });
    }
  }

  diagnostics.push(...clientExposureDiagnostics(input, declared, staticOccurrences, exposedNames));

  return diagnostics.sort(compareDiagnostics);
}

function clientExposureDiagnostics(
  input: AnalysisInput,
  declared: ReadonlyMap<string, VariableDefinition>,
  staticOccurrences: ReadonlyMap<string, readonly { file: string; line: number; column: number }[]>,
  exposedNames: ReadonlyMap<string, { file: string; line: number; column: number }>,
): Diagnostic[] {
  const { configFile, framework } = input;
  const prefix = framework.publicPrefix;
  const diagnostics: Diagnostic[] = [];
  const flagged = new Set<string>();

  for (const definition of declared.values()) {
    if (definition.secret !== true) continue;
    if (definition.name.startsWith(prefix)) {
      flagged.add(definition.name);
      diagnostics.push({
        code: "ENV005",
        severity: "error",
        message: `${definition.name} is declared \`secret: true\` in ${configFile}, but the ${prefix} prefix makes ${framework.name} include its value in client-side JavaScript.`,
        file: configFile,
        line: definition.location.line,
        column: definition.location.column,
        variableName: definition.name,
        suggestion: `Rename it without ${prefix} and read it only in server code, or set \`secret: false\` if the value is safe to publish.`,
      });
    }
    const exposure = exposedNames.get(definition.name);
    if (exposure) {
      flagged.add(definition.name);
      diagnostics.push({
        code: "ENV005",
        severity: "error",
        message: `${definition.name} is declared \`secret: true\` in ${configFile}, but ${exposure.file} lists it under \`env\`, which ${framework.name} inlines into client-side JavaScript.`,
        ...exposure,
        variableName: definition.name,
        suggestion: `Remove ${definition.name} from \`env\` in ${exposure.file} and read it only in server code.`,
      });
    }
  }

  // Heuristic (warning only): a client-visible name that looks like a secret and is not explicitly
  // marked public. Based on the name alone; values are never inspected, so this is never a confirmed leak.
  const clientVisible = new Map<string, { file: string; line: number; column: number }>();
  for (const [name, occurrences] of staticOccurrences) {
    if (name.startsWith(prefix)) clientVisible.set(name, occurrences[0] as { file: string; line: number; column: number });
  }
  for (const definition of declared.values()) {
    if (definition.name.startsWith(prefix)) {
      clientVisible.set(definition.name, { file: configFile, line: definition.location.line, column: definition.location.column });
    }
  }
  for (const [name, location] of exposedNames) clientVisible.set(name, location);

  for (const [name, location] of [...clientVisible].sort(([a], [b]) => compare(a, b))) {
    if (flagged.has(name) || declared.get(name)?.secret === false) continue;
    const segment = secretLookingSegment(name, prefix);
    if (segment === undefined) continue;
    diagnostics.push({
      code: "ENV005",
      severity: "warning",
      message:
        `Possible exposure: ${name} is visible to client-side code and its name contains "${segment}", which often indicates a secret. ` +
        "This is a name-based heuristic, not a confirmed leak; EnvSync does not know whether the value is sensitive.",
      ...location,
      variableName: name,
      suggestion: `If it is a secret, keep it out of client code (no ${prefix} prefix, not exposed through the ${framework.name} config). If it is safe to publish, declare it with \`secret: false\`.`,
    });
  }

  return diagnostics;
}

function secretLookingSegment(name: string, prefix: string): string | undefined {
  const unprefixed = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return unprefixed
    .split("_")
    .map((segment) => segment.toUpperCase())
    .find((segment) => SECRET_NAME_SEGMENTS.has(segment));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
