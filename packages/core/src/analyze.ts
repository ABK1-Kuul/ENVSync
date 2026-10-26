import {
  effectiveVisibility,
  isValidVariableName,
  type ParsedConfig,
  type ParsedEnvExample,
  type ParsedEnvFile,
  type VariableDefinition,
} from "@envsync-internal/schema";
import { compareDiagnostics, type Diagnostic } from "./diagnostics.js";
import { contextFiles, expectsPlatformValues, type EnvContext } from "./env-context.js";
import type { ClientExposedName, ExtractedReference, FrameworkAdapter } from "./framework.js";
import { matchesType, secretValueFormat } from "./value-checks.js";

export type FileReferences = { file: string; references: readonly ExtractedReference[] };

export type FileExposures = { file: string; names: readonly ClientExposedName[] };

/** A runtime env file (`.env`, `.env.local`, ...) parsed with its values. */
export type EnvFileValues = { file: string; parsed: ParsedEnvFile };

export type AnalysisInput = {
  configFile: string;
  config: ParsedConfig;
  envExampleFile: string;
  /** `null` when the project has no `.env.example`. */
  envExample: ParsedEnvExample | null;
  references: readonly FileReferences[];
  exposures: readonly FileExposures[];
  /** Runtime env files that were read. Omitted or empty: no value-based checks run. */
  envFiles?: readonly EnvFileValues[];
  /** Context whose files decide ENV008 (ADR-017). Default: "development". */
  envContext?: EnvContext;
  /** Attach `value` to value findings, redacted per ADR-016. Default: false, so no value leaves `analyze`. */
  includeValues?: boolean;
  framework: Pick<FrameworkAdapter, "name" | "publicPrefix" | "builtInVariables" | "externallyReadVariables">;
};

// Name segments that suggest a value must stay private. "KEY" is deliberately absent:
// publishable/public API keys commonly carry a public prefix on purpose.
const SECRET_NAME_SEGMENTS = new Set(["SECRET", "PASSWORD", "PASSWD", "PRIVATE", "TOKEN", "CREDENTIALS"]);

/**
 * Compares source evidence with the declared contract. Pure: no filesystem access.
 * Values from runtime env files are attached as `Diagnostic.value` on ENV005/ENV010 only when
 * `includeValues` is set, and then redacted per ADR-016. Messages and suggestions never contain them.
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

  for (const collision of caseCollisions(config.variables.map(({ name, location }) => ({ name, line: location.line, column: location.column })))) {
    diagnostics.push(caseCollisionDiagnostic(collision, configFile));
  }
  for (const collision of caseCollisions(envExample?.entries ?? [])) {
    diagnostics.push(caseCollisionDiagnostic(collision, envExampleFile));
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
  const externallyRead = new Set(framework.externallyReadVariables);
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

  // ENV011: the example documents a variable the contract does not know about. Framework variables
  // are exempt; names are untrusted (an example file can hold a pasted value), as for env files.
  const knownNames = new Set([...declared.keys(), ...staticOccurrences.keys(), ...builtIns, ...externallyRead]);
  for (const entry of envExample?.entries ?? []) {
    if (declared.has(entry.name) || builtIns.has(entry.name) || externallyRead.has(entry.name)) continue;
    const shown = isDisplayableEnvName(entry.name, knownNames);
    diagnostics.push({
      code: "ENV011",
      severity: "warning",
      message: shown
        ? `${entry.name} is listed in ${envExampleFile} but not declared in ${configFile}.`
        : `Line ${entry.line} of ${envExampleFile} lists a variable that is not declared in ${configFile}. The name is not shown because it looks like it could be part of a value.`,
      file: envExampleFile,
      line: entry.line,
      ...(shown ? { variableName: entry.name } : {}),
      suggestion: shown
        ? `Declare ${entry.name} under \`variables\` in ${configFile} (add \`external: true\` if only tooling or the platform reads it), or remove it from ${envExampleFile}.`
        : `Declare the variable in ${configFile}, or remove the line from ${envExampleFile}.`,
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

    const usedElsewhere = definition.external === true || externallyRead.has(definition.name);
    if (!usedElsewhere && !staticOccurrences.has(definition.name) && !exposedNames.has(definition.name)) {
      // With dynamic access present the analysis is incomplete, so "unused" drops to info.
      diagnostics.push({
        code: "ENV003",
        severity: dynamicCount > 0 ? "info" : "warning",
        message:
          `${definition.name} is declared but no static reference to it was found. It may be unused, ` +
          `or read by ${framework.name}, a dependency, or the hosting platform.` +
          (dynamicCount > 0
            ? ` The project also has ${dynamicCount} dynamic process.env ${dynamicCount === 1 ? "access" : "accesses"} that may read it, so this is less certain.`
            : ""),
        ...atDeclaration(definition),
        suggestion:
          "Remove the declaration if it is no longer used. If something outside the scanned source reads it, add `external: true`.",
      });
    }
  }

  diagnostics.push(...clientExposureDiagnostics(input, declared, staticOccurrences, exposedNames));
  diagnostics.push(...envFileDiagnostics(input, declared, exposedNames, new Set(staticOccurrences.keys())));

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
        message: `${definition.name} is declared ${privacyLabel(definition)} in ${configFile}, but the ${prefix} prefix makes ${framework.name} include its value in client-side JavaScript.`,
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
        message: `${definition.name} is declared ${privacyLabel(definition)} in ${configFile}, but ${exposure.file} lists it under \`env\`, which ${framework.name} inlines into client-side JavaScript.`,
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

/**
 * Findings from runtime env files. Files directly in the project root are the app's own (Next.js
 * loads env files only from there): they are checked against the config (ENV009, ENV010) and, for
 * the selected context, for missing values (ENV008). Files anywhere else, such as another app in a
 * monorepo, are only checked for credential exposure (ENV005) and repeated names (ENV007).
 */
function envFileDiagnostics(
  input: AnalysisInput,
  declared: ReadonlyMap<string, VariableDefinition>,
  exposedNames: ReadonlyMap<string, { file: string; line: number; column: number }>,
  referencedNames: ReadonlySet<string>,
): Diagnostic[] {
  const envFiles = [...(input.envFiles ?? [])].sort((a, b) => compare(a.file, b.file));
  if (envFiles.length === 0) return [];
  const { configFile, framework } = input;
  const includeValues = input.includeValues === true;
  const diagnostics: Diagnostic[] = [];
  const builtIns = new Set(framework.builtInVariables);
  const externallyRead = new Set(framework.externallyReadVariables);
  // Names already known from the config or the source code are safe to print.
  const knownNames = new Set([...declared.keys(), ...referencedNames, ...builtIns, ...externallyRead]);

  for (const { file, parsed } of envFiles) {
    const ownFile = !file.includes("/");
    for (const duplicate of parsed.duplicates) {
      const shown = isDisplayableEnvName(duplicate.name, knownNames);
      diagnostics.push({
        code: "ENV007",
        severity: "warning",
        message: shown
          ? `${duplicate.name} is set more than once in ${file} (first on line ${duplicate.firstLine}); the last assignment wins.`
          : `An entry on line ${duplicate.line} of ${file} repeats the name on line ${duplicate.firstLine}; the last assignment wins. The name is not shown because it looks like it could be part of a value.`,
        file,
        line: duplicate.line,
        ...(shown ? { variableName: duplicate.name } : {}),
        suggestion: "Keep a single assignment so it is clear which value is used.",
      });
    }

    for (const entry of parsed.entries) {
      const at = { file, line: entry.line, variableName: entry.name };
      const definition = declared.get(entry.name);

      if (ownFile && definition === undefined && !builtIns.has(entry.name) && !externallyRead.has(entry.name)) {
        diagnostics.push(
          isDisplayableEnvName(entry.name, knownNames)
            ? {
                code: "ENV009",
                severity: "warning",
                message: `${entry.name} is set in ${file} but not declared in ${configFile}.`,
                ...at,
                suggestion: `Declare ${entry.name} under \`variables\` in ${configFile}, or remove it from ${file} if nothing uses it.`,
              }
            : {
                code: "ENV009",
                severity: "warning",
                message: `Line ${entry.line} of ${file} sets a variable that is not declared in ${configFile}. The name is not shown because it looks like it could be part of a value (for example a multi-line key pasted without quotes).`,
                file,
                line: entry.line,
                suggestion: `Quote multi-line values in ${file}, or declare the variable in ${configFile} if it is real.`,
              },
        );
      }

      if (ownFile && definition !== undefined && entry.value.trim() !== "" && matchesType(entry.value, definition.type, entry.quote) === false) {
        diagnostics.push({
          code: "ENV010",
          severity: "error",
          message: `The value of ${entry.name} in ${file} is not a valid ${definition.type}, as declared in ${configFile}.`,
          ...at,
          suggestion: `Set a valid ${definition.type} value, or change \`type\` for ${entry.name} in ${configFile}.`,
          ...(includeValues ? displayedValue(entry.name, entry.value, definition, framework.publicPrefix) : {}),
        });
      }

      const clientVisible = entry.name.startsWith(framework.publicPrefix) || exposedNames.has(entry.name);
      const format = clientVisible && (!ownFile || definition?.secret !== false) ? secretValueFormat(entry.value) : undefined;
      if (format !== undefined) {
        diagnostics.push({
          code: "ENV005",
          severity: "error",
          message: `The value of ${entry.name} in ${file} looks like ${format}, and ${framework.name} includes ${entry.name} in client-side JavaScript.`,
          ...at,
          suggestion: `Rotate this credential, then move it to a variable without the ${framework.publicPrefix} prefix that only server code reads.`,
          ...(includeValues ? redacted(format, entry.value) : {}),
        });
      }
    }
  }

  diagnostics.push(...missingValueDiagnostics(input, declared, envFiles));
  return diagnostics;
}

/** ENV008 for the selected context: the first file in priority order that sets a name decides its value. */
function missingValueDiagnostics(
  input: AnalysisInput,
  declared: ReadonlyMap<string, VariableDefinition>,
  envFiles: readonly EnvFileValues[],
): Diagnostic[] {
  const context = input.envContext ?? "development";
  const ownFiles = new Map<string, ParsedEnvFile>();
  for (const { file, parsed } of envFiles) {
    if (file.includes("/")) continue;
    const key = file.toLowerCase();
    if (!ownFiles.has(key) || file === key) ownFiles.set(key, parsed);
  }
  const checked = contextFiles(context).filter((file) => ownFiles.has(file));
  // No env file for this context: values come from the shell or the platform; nothing to compare.
  if (checked.length === 0) return [];

  const effective = new Map<string, string>();
  for (const file of checked) {
    for (const entry of (ownFiles.get(file) as ParsedEnvFile).entries) {
      if (!effective.has(entry.name)) effective.set(entry.name, entry.value);
    }
  }

  const fromPlatform = expectsPlatformValues(context, new Set(ownFiles.keys()));
  const diagnostics: Diagnostic[] = [];
  for (const definition of declared.values()) {
    if (!definition.required || (effective.get(definition.name) ?? "").trim() !== "") continue;
    diagnostics.push({
      code: "ENV008",
      // Without a file specific to this deployed environment, values are expected from the platform.
      severity: fromPlatform ? "info" : "warning",
      message:
        `${definition.name} is required by ${input.configFile} but has no value for ${context} in ${checked.join(", ")}.` +
        (fromPlatform
          ? ` No ${context}-specific env file exists, so it is expected from the hosting platform.`
          : " It may still be provided by the shell or the hosting platform."),
      file: input.configFile,
      line: definition.location.line,
      column: definition.location.column,
      variableName: definition.name,
      suggestion: fromPlatform
        ? `Make sure ${definition.name} is set for ${context} on your hosting platform.`
        : `Set ${definition.name} in ${localFileFor(context)}, or make sure the environment provides it.`,
    });
  }
  return diagnostics;
}

/** The conventional machine-local file for a context (never committed). */
function localFileFor(context: EnvContext): string {
  return context === "development" ? ".env.local" : `.env.${context}.local`;
}

/**
 * ADR-016: with values requested, a value is shown only if nothing marks it private. Credential-shaped
 * values, Sensitive/Secret variables and secret-looking names get a marker with no characters of the value.
 */
function displayedValue(name: string, value: string, definition: VariableDefinition, prefix: string): Pick<Diagnostic, "value" | "valueRedacted"> {
  const format = secretValueFormat(value);
  if (format !== undefined) return redacted(format, value);
  const visibility = effectiveVisibility(definition);
  if (visibility === "secret" || visibility === "sensitive") return redacted(`${visibility} value`, value);
  // A URL-like value may hold credentials even when malformed (an unencoded password breaks parsing).
  if (value.includes("@") || value.includes("://")) return redacted("possible connection string", value);
  if (secretLookingSegment(name, prefix) !== undefined || PRIVATE_NAME.test(name)) return redacted("possibly secret value", value);
  return { value };
}

// Broader than the ENV005 name heuristic: hiding a value costs little, showing a secret costs a lot.
const PRIVATE_NAME = /SECRET|PASS|PWD|TOKEN|PRIVATE|CREDENTIAL|KEY|AUTH|SALT|DSN|JWT|SIGN|CERT|SESSION|COOKIE/i;

// L2: a length range, not the exact length, so a redaction narrows guessing as little as possible.
function redacted(kind: string, value: string): Pick<Diagnostic, "value" | "valueRedacted"> {
  const length = [...value].length;
  const range = length < 16 ? "fewer than 16" : length <= 64 ? "16 to 64" : "more than 64";
  return { value: `<redacted: ${kind}, ${range} characters>`, valueRedacted: true };
}

/**
 * Names parsed from env files are untrusted: an unquoted multi-line secret can produce a "name"
 * that is really key material (a base64 line ending in `=`). Such names are printed only when
 * declared, or when they look like an ordinary identifier rather than random characters.
 */
function isDisplayableEnvName(name: string, known: ReadonlySet<string>): boolean {
  if (known.has(name)) return true;
  // Conventional names are upper case with at least one underscore (API_URL, NEXT_PUBLIC_X). Base64
  // and base32 lines have no underscore (base64url rarely does), so fragments are not printed.
  return isValidVariableName(name) && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name);
}

/** How the config marked a variable private, as written there (for messages). */
function privacyLabel(definition: VariableDefinition): string {
  return definition.visibility === undefined ? "`secret: true`" : `\`visibility: "${definition.visibility}"\``;
}

function secretLookingSegment(name: string, prefix: string): string | undefined {
  const unprefixed = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return unprefixed
    .split("_")
    .map((segment) => segment.toUpperCase())
    .find((segment) => SECRET_NAME_SEGMENTS.has(segment));
}

type NamedLocation = { name: string; line: number; column?: number };
type CaseCollision = { entry: NamedLocation; first: NamedLocation };

/** Later entries whose name equals an earlier, differently spelled one when case is ignored. */
function caseCollisions(entries: readonly NamedLocation[]): CaseCollision[] {
  const firstByFoldedName = new Map<string, NamedLocation>();
  const collisions: CaseCollision[] = [];
  for (const entry of entries) {
    const folded = entry.name.toUpperCase();
    const first = firstByFoldedName.get(folded);
    if (first === undefined) firstByFoldedName.set(folded, entry);
    else if (first.name !== entry.name) collisions.push({ entry, first });
  }
  return collisions;
}

function caseCollisionDiagnostic({ entry, first }: CaseCollision, file: string): Diagnostic {
  return {
    code: "ENV007",
    severity: "warning",
    message: `${entry.name} differs from ${first.name} (line ${first.line} of ${file}) only by letter case. Windows treats environment variable names case-insensitively, so they collide there.`,
    file,
    line: entry.line,
    ...(entry.column !== undefined ? { column: entry.column } : {}),
    variableName: entry.name,
    suggestion: "Use a single spelling for this variable.",
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
