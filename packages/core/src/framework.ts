/**
 * Contract between the framework-agnostic core and a framework parser (e.g. `@envsync/parser-next`).
 * Core never imports a parser; the CLI passes one in.
 */

export type Location = { line: number; column: number };

export type ExtractedReference = ({ kind: "static"; name: string } & Location) | ({ kind: "dynamic" } & Location);

export type ClientExposedName = { name: string } & Location;

export type FrameworkAdapter = {
  /** Human-readable framework name used in messages, e.g. "Next.js". */
  readonly name: string;
  /** Prefix that makes a variable's value available to client-side code, e.g. "NEXT_PUBLIC_". */
  readonly publicPrefix: string;
  /** Variables provided by the runtime/framework that projects need not declare. */
  readonly builtInVariables: readonly string[];
  /** Root-relative paths of framework config files that may expose variables to the client. */
  readonly frameworkConfigFiles: readonly string[];
  extractReferences(sourceText: string, fileName: string): ExtractedReference[];
  extractClientExposedNames(sourceText: string, fileName: string): ClientExposedName[];
};
