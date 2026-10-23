# EnvSync CLI reference (unreleased, v0.0.0)

This documents what is implemented today. Anything not listed here (for example `init` and
`doctor`) is not available yet.

## Running from this repository

```sh
pnpm install
pnpm build
node apps/cli/dist/bin.js scan path/to/next-app
```

## `envsync scan`

```
envsync scan [directory] [--format terminal|json] [--strict]
```

| Option | Meaning |
|---|---|
| `directory` | Project root. Defaults to the current directory. |
| `--format terminal` | Human-readable output (default). |
| `--format json` | Machine-readable output; see [JSON output](#json-output). |
| `--strict` | Warnings also cause exit code 1. |
| `-h`, `--help` | Show usage. |
| `-v`, `--version` | Show the version. |

What a scan reads: `envsync.config.ts`, `.env.example`, and source files
(`.ts .tsx .js .jsx .mjs .cjs .mts .cts`, excluding `*.d.ts`) under the root.

What a scan never does: read `.env` or `.env.*` files (other than `.env.example`), print any
variable value, execute or import project code (including the config and `next.config.*`), follow
symbolic links or junctions, or make network requests.

Skipped during discovery: `.git`, `node_modules`, `.next`, `dist`, `build`, `out`, `coverage`
(at any depth, case-insensitive). Symlinks, unreadable directories, files over 1,000,000 bytes and
files the parser cannot handle are listed under "Not scanned" / `skipped`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No errors. With `--strict`, also no warnings. Info never affects the exit code. |
| `1` | At least one error, or (with `--strict`) at least one warning. |
| `2` | Usage error, or the scan could not run: missing or unreadable project directory, missing `envsync.config.ts`, a config or `.env.example` that is a symlink / not a regular file / over 1 MB. The reason is printed to stderr; stdout is empty. |

## Config file: `envsync.config.ts`

The config is **parsed, never executed** (ADR-002, ADR-005). Only this literal subset is understood:

```ts
import { defineConfig } from "envsync"; // optional; the import is never resolved

export default defineConfig({
  variables: {
    DATABASE_URL: { required: true, secret: true, type: "url", description: "Postgres connection string" },
    NEXT_PUBLIC_SITE_URL: { secret: false, type: "url" },
    LOG_LEVEL: { required: false },
  },
});
```

- The default export may be an object literal, `defineConfig({...})`, either wrapped in
  `as const` / `satisfies T` / parentheses, or a top-level `const` holding one of those.
- `variables` keys must be literal names matching `[A-Za-z_][A-Za-z0-9_]*`.
- Fields, all optional:

| Field | Values | Default | Used for |
|---|---|---|---|
| `required` | `true` / `false` | `true` | ENV002 |
| `secret` | `true` / `false` | unspecified | ENV005 |
| `type` | `"string"`, `"number"`, `"boolean"`, `"url"` | `"string"` | validated only (reserved for `init`) |
| `description` | string literal | none | validated only |

Anything else (spreads, computed keys, function calls, variables, imports used as values, unknown
fields) is reported as ENV004 rather than evaluated. `defineConfig` is never called; only its
literal argument is read.

Top-level code is checked so the file cannot mean something different at runtime than EnvSync
reads. Allowed: imports, `type`/`interface`, `export ... from` / `export { }`, function
declarations, `declare` blocks, one `export default`, and `const`/`let`/`var` declarations whose
initializers have no side effects. Everything else is ENV004, including call statements,
assignments or mutation of the config (`config.variables.X = ...`, `Object.assign(...)`),
`if`/loops, classes, enums, `import x = require(...)`, `export =`, a second default export, and
initializers containing calls (other than `defineConfig`), `new`, assignments, `await`, `++`/`--`
or tagged templates.

## Diagnostics

| Code | Severity | Trigger |
|---|---|---|
| ENV001 | error | A static `process.env` reference names a variable not declared in the config. Reported once per name, at the first location, with a count of other locations. `NODE_ENV` and `NEXT_RUNTIME` are treated as framework-provided. |
| ENV002 | error | A `required` variable has no entry in `.env.example`, or `.env.example` does not exist. |
| ENV003 | warning | A declared variable has no static reference and is not listed in `next.config` `env`. It may still be read by Next.js, a dependency or dynamic access. |
| ENV004 | error | Invalid or unsupported config content, including syntax errors. |
| ENV005 | error | **Confirmed contract violation:** a variable declared `secret: true` has the `NEXT_PUBLIC_` prefix, or is listed under `env` in `next.config.*`. |
| ENV005 | warning | **Name-based heuristic, not a confirmed leak:** a client-visible variable (public prefix or `next.config` `env`) has a name segment of `SECRET`, `PASSWORD`, `PASSWD`, `PRIVATE`, `TOKEN` or `CREDENTIALS` (whole `_`-separated segments, after the prefix), and is not declared `secret: false`. The message starts with "Possible exposure:" and names the matched segment. Values are never inspected. |
| ENV006 | info | `process.env` used in a way whose variable name cannot be known statically. |
| ENV007 | error | The same variable declared more than once in the config (identifier, quoted and computed-literal spellings count as the same name), or a repeated `variables` key. Each repeat is reported at its own location and refers to the first; the first declaration is used. |
| ENV007 | warning | The same name appears more than once in `.env.example` (with or without `export`). Each repeat refers to the first line. |

Severity is part of the meaning: for ENV005, automation should treat `error` as a confirmed
violation of the declared contract and `warning` as a heuristic. Duplicate detection runs on the
AST / file lines in source order, before entries are merged, and names are case-sensitive.

Recognized static access: `process.env.NAME`, `process.env["NAME"]` (also `'NAME'` and
`` `NAME` ``), optional chaining, `!`/`as`/parentheses, `const { NAME, OTHER: alias, X = "d" } = process.env`,
and `"NAME" in process.env`. Dynamic (ENV006): computed keys, `...rest` destructuring, aliasing
`process.env`, spreading it or passing it to a function.

## JSON output

`--format json` prints one document (schema version 1):

```json
{
  "schemaVersion": 1,
  "summary": { "errors": 1, "warnings": 0, "infos": 0, "filesScanned": 3, "strict": false, "exitCode": 1 },
  "diagnostics": [
    {
      "code": "ENV001",
      "severity": "error",
      "message": "API_URL is referenced but not declared in envsync.config.ts.",
      "file": "src/api.ts",
      "line": 4,
      "column": 15,
      "variableName": "API_URL",
      "suggestion": "Add API_URL under `variables` in envsync.config.ts, or remove the reference if it is a mistake."
    }
  ],
  "skipped": [{ "path": "linked", "reason": "symlink" }]
}
```

- `file` is relative to the project root with `/` separators. `file`, `line`, `column`,
  `variableName` and `suggestion` are omitted when not applicable.
- `skipped[].reason` is one of `symlink`, `unreadable`, `too-large`, `parse-failed`.
- Diagnostics are sorted by file (project-level findings last), line, column, code and name.
- Control, C1 and bidi-override characters from repository content are escaped as `\uXXXX`.
- Messages are for humans; automation should rely on `code`, `severity` and location fields.

## Known limitations

- Only the project root's `envsync.config.ts`, `.env.example` and `next.config.*` are read; monorepo
  sub-apps must be scanned individually.
- A local variable named `process` that shadows the global is not detected.
- `.env.example` entries that are not declared in the config are not reported yet.
- Malformed `.env.example` lines are ignored (they are parsed but not yet reported).
- `type` and `description` are validated but not yet used.
- Linting is not configured in this repository yet.
