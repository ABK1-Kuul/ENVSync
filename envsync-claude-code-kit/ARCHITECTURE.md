# Architecture Notes

## Suggested workspace
- `apps/cli/src/commands/{scan,init,doctor}.ts`
- `apps/cli/src/formatters/{terminal,json}.ts`
- `packages/core/src/{scanner,analyzers,diagnostics}.ts`
- `packages/schema/src/{config-schema,env-example,validation}.ts`
- `packages/parser-next/src/{references,next-config}.ts`
- `packages/test-fixtures/{next-app-router,next-pages-router,broken-config}`
- `tests/{integration,security,fixtures}`

Adapt this to the repository's actual state rather than creating every directory blindly.

## Dependency direction
CLI -> core -> schema/types.
CLI -> parser-next through a defined interface.
Core should not depend on terminal formatting or CLI argument parsing.
Schema should not import application modules.
Parser extracts evidence; it should not decide terminal wording.

## Scan pipeline
1. Discover eligible source files.
2. Exclude dependency, build, generated, VCS and environment files.
3. Parse source using a TypeScript/JavaScript AST.
4. Extract static environment references and source locations.
5. Mark dynamic/computed access as incomplete analysis.
6. Load and validate EnvSync config as data without executing it.
7. Parse `.env.example` safely.
8. Compare evidence and contract.
9. Emit stable diagnostic objects.
10. Format terminal or JSON output and compute exit status.

## Config loading safety
Never execute `envsync.config.ts` by importing it from the target repository. Choose a safe, documented data format or implement static parsing for a constrained TypeScript config. If execution is ever proposed, stop and present the security tradeoff for explicit product-owner approval.

## Suggested diagnostic shape
```ts
type Diagnostic = {
  code: "ENV001" | "ENV002" | "ENV003" | "ENV004" | "ENV005" | "ENV006" | "ENV007";
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  variableName?: string;
  suggestion?: string;
};
```
Do not put variable values in diagnostics. Keep JSON schema stable once published.

## AST and framework behavior
Use the TypeScript compiler API or a similarly reliable parser. Recognize static dot and string-literal bracket access. Do not treat all dynamic access as a known variable. Account for framework files and generated code. Treat unused-variable findings as potentially uncertain because frameworks and external tools may read variables indirectly.
