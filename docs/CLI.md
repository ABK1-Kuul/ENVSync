# EnvSync CLI reference (unreleased, v0.0.0)

This documents what is implemented today: `scan`, `init` and `doctor`.

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

Skipped during discovery (case-insensitive): `.git`, `node_modules` and `.next` at any depth; the
generated-output names `dist`, `build`, `out` and `coverage` at any depth **except** inside the
project's route tree (`app/` or `pages/` at the scanned root or under `src/`), where they are
Next.js route segments (`app/build/page.tsx` is scanned; `packages/app/dist` is not). The route
tree is identified relative to the directory you scan, so scan the Next.js app's root.

Symbolic links are never followed. Because a link's target type is unknown without following it,
a link counts as "not scanned" (and makes the scan incomplete) unless its name is clearly not
scanned: an env file, an excluded directory name, a type declaration, or a known non-source
extension (images, fonts, media, `.md`, `.json`, `.css`, `.yml`, archives, …). So a linked
`node_modules`, `logo.png` or `.env.local` is ignored, while a linked `lib`, `api.v2` or
`[...slug]` directory is reported. Unreadable directories, files over 1,000,000 bytes and files
the parser cannot handle are listed too.

## `envsync init`

```
envsync init [directory] [--write]
```

Previews a starter `envsync.config.ts` and `.env.example`. **Nothing is written without `--write`.**

| Situation | What `init` plans |
|---|---|
| No `envsync.config.ts` | Create it, declaring every statically referenced name (sorted, `required: true`, with a comment showing where each was first referenced). `NODE_ENV`/`NEXT_RUNTIME` are left out. |
| `envsync.config.ts` exists | Leave it untouched. It is never rewritten; edit it by hand. |
| No `.env.example` | Create it with an empty `NAME=` placeholder for every declared variable. |
| `.env.example` exists | Append a `# Added by envsync init` block with placeholders for declared variables it does not list. Existing lines are kept byte-for-byte, and CRLF line endings are preserved. |

`--write` plans again and applies that plan in the same run; it does not replay an earlier preview.
If the files changed since you looked at the preview, the `--write` output shows what was actually
written. All checks below happen at write time.

Safety guarantees:
- Generated files contain only variable names, comments and empty placeholders. `.env`/`.env.*`
  files are never read, so no local value can be copied. The preview never shows the existing
  contents of any file.
- New files are created exclusively: a file that appears between planning and writing is left
  untouched, and `init` exits with code 2. If writing a new file fails part-way, the incomplete
  file is removed.
- An append goes through one verified file handle: the opened file must be the regular,
  single-link file that was checked (same device and inode, so symlink or hard-link swaps are
  refused on every platform), and its content must be unchanged since planning (SHA-256). If the
  append fails part-way, the file is truncated back to its original content.
- If `.env.example` ends inside a quoted value that is never closed, appended lines would become
  part of that value, so `init` shows "Cannot update" and `--write` refuses to change anything
  (exit 2). The same happens if the appended placeholders would not read back as entries.
- If the existing config has problems, `.env.example` is not planned from it ("not checked").
- Running `init --write` again is a no-op ("Nothing to change").
- Dynamic `process.env` accesses, names that are not valid variable names, and names that
  differ only by letter case are reported in the preview, not guessed.

## `envsync doctor`

```
envsync doctor [directory] [--format terminal|json] [--strict]
```

Read-only checks of the local setup. It never runs package scripts, never runs `git`, and never
reads the contents of `.env`/`.env.*` files (it lists their names only).

Each check reports `pass`, `warn`, `fail`, `skip` (not applicable) or **`unknown`**: EnvSync could
not establish the result, so it is treated as unverified, never as a pass. With `--strict`, `warn`
and `unknown` also cause exit code 1.

| Check id | Fails when | Warns when |
|---|---|---|
| `node-version` | Node.js is older than 22.12.0 | |
| `source-files` | the directory is missing or not a directory | no source files are found, or some paths will not be scanned (listed by reason: symlinked, unreadable). **Unknown** when the project exceeds the scan limits (file count or directory entries; the 200 MB byte limit is only detected by `scan`) |
| `package-json` | `package.json` is invalid JSON, symlinked or oversized | it is missing |
| `framework` | | `next` is not a dependency (with a monorepo hint at workspace roots); version ranges are never printed |
| `config` | `envsync.config.ts` is missing or has problems | |
| `env-example` | `.env.example` is symlinked or oversized | it is missing, or has lines that are not `KEY=value` (reported by line number only) |
| `env-files-ignored` | a `.env*.local` file is tracked by git (committed), or exists and is definitely not ignored | a shared `.env`/`.env.<mode>` file is committed or not ignored, or `.env.local` would not be ignored if created. **Unknown** when ignore or tracking status could not be established (see below). |

`env-files-ignored` reports `skip` only when EnvSync is sure the project is outside any git
repository. `.local` matching is case-insensitive.

How the git checks work without running git:
- **Repository search.** Starts from the project's real path (symlinks and junctions resolved),
  as git does, and walks up at most 64 levels. If the real path cannot be resolved or the limit
  is hit, the result is `unknown`.
- **Repository root.** A `.git` directory counts only if git would accept it, following git's
  `validate_headref`/`is_git_directory`: the first 255 bytes of `HEAD` name a ref (`ref:` +
  optional space/tab/CR/LF + `refs/`) or an object id (40 or more hex digits, any case), and
  `objects/` and `refs/` exist. A `.git` that git definitely rejects (no `HEAD`, an invalid
  `HEAD`, missing `objects/`/`refs/`) is passed over, as git does, so a planted `.git` folder
  cannot supply its own ignore rules. A `.git` git might accept but EnvSync cannot verify — any
  of `.git`, `HEAD`, `objects/` or `refs/` being a link or not a plain file/directory, a
  `commondir` file, or an oversized `HEAD` — makes the result `unknown`, never `skip`. A `.git`
  *file* (linked worktree or submodule) makes it `unknown` too, because its metadata lives elsewhere.
- **Tracked files** are read from `.git/index` (versions 2–4; file names only). An already
  committed file stays tracked even if `.gitignore` lists it, so this is checked first. The
  result is `unknown` when the index cannot be read, uses a split index (`link`) or sparse index
  (`sdir` or directory entries), is malformed, or exceeds the limits below.
- **Ignore rules** come from `.gitignore` files between the project and the repository root plus
  `.git/info/exclude`, evaluated like git: LF line splitting, only trailing ASCII spaces trimmed,
  byte-wise wildmatch where `*`, `?` and `[...]` never match `/`, invalid patterns matching
  nothing, and git's literal-prefix split for patterns containing `/` (so `apps**/.env.local`
  matches across directories, as in git). Matching runs in linear time, so a hostile `.gitignore`
  cannot hang `doctor`. If an ignore file that applies is oversized, unreadable, symlinked, or
  exceeds 10,000 rules / 4,096-character patterns, the result is `unknown`, never `ignored`.
- **Case folding** follows git when `core.ignorecase` is on: path letters and plain pattern
  letters are compared case-insensitively (ASCII only), but letters written after a backslash
  (`\E`) and single class members (`[E]`) are compared as written. The value comes from an exact
  `[core]` section of `.git/config` (not `[core "x"]`). If the file does not set it, or contains
  anything EnvSync does not fully parse (includes, quoted values, continuations,
  `extensions.worktreeConfig`), both settings are evaluated, and a result that differs between
  them is `unknown` (global git settings are not read). An index entry whose name differs from a
  local env file only by letter case counts as tracked when `core.ignorecase=true`, and is
  `unknown` otherwise: even with `core.ignorecase=false`, git commits changes to it on a
  case-insensitive file system.
- Behaviour is tested against `git check-ignore` on a corpus of patterns (including escapes,
  classes, reversed ranges and negations), nested `.gitignore` files, non-ASCII names and both
  case settings.
- Known deviations from git: the global excludes file (`core.excludesFile`) is not read; the
  `GIT_DIR`, `GIT_CEILING_DIRECTORIES` and `GIT_DISCOVERY_ACROSS_FILESYSTEM` environment
  variables are not consulted (EnvSync does not stop at file-system boundaries); and bare
  repositories found while walking up are not recognized.

JSON output: `{ "schemaVersion": 1, "summary": { "pass", "warn", "fail", "unknown", "skip", "strict", "exitCode" }, "checks": [{ "id", "status", "message", "suggestion"? }] }`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | `scan`: no errors (with `--strict`, also no warnings and a complete scan; info never counts). `init`: preview shown or changes written. `doctor`: no failed checks (with `--strict`, also no `warn` or `unknown`). |
| `1` | `scan`: at least one error, or (with `--strict`) at least one warning or any path not scanned. `doctor`: at least one failed check, or (with `--strict`) a `warn` or `unknown` result. |
| `2` | Usage error (including an option that does not belong to the command), or the command could not run. For `scan` and `init`: missing or unreadable project directory, a config or `.env.example` that is a symlink / not a regular file / over 1 MB; for `scan`, a missing `envsync.config.ts`; for `init --write`, a file that changed between planning and writing, a blocked change, or a failed write. The reason is printed to stderr. (`doctor` reports a missing directory as a failed check, exit 1.) |

## Config file: `envsync.config.ts`

The config is **parsed, never executed**: EnvSync never imports or runs project code. Only this literal subset is understood:

```ts
export default {
  variables: {
    DATABASE_URL: { required: true, secret: true, type: "url", description: "Postgres connection string" },
    NEXT_PUBLIC_SITE_URL: { secret: false, type: "url" },
    LOG_LEVEL: { required: false },
  },
};
```

- The default export may be an object literal, either wrapped in `as const` / `satisfies T` /
  parentheses, or a top-level `const` holding one. A `defineConfig({...})` wrapper is also
  accepted (its argument is read; it is never called), but the `envsync` package does not export
  `defineConfig`, so do not import it from `envsync`: a plain object needs no import and
  type-checks in any project.
- `variables` keys must be literal names matching `[A-Za-z_][A-Za-z0-9_]*`.
- Fields, all optional:

| Field | Values | Default | Used for |
|---|---|---|---|
| `required` | `true` / `false` | `true` | ENV002 |
| `secret` | `true` / `false` | unspecified | ENV005 |
| `external` | `true` / `false` | `false` | `true` suppresses ENV003 for variables read outside the scanned source (hosting platform, dependency, tooling) |
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
| ENV003 | warning | A declared variable has no static reference, is not listed in `next.config` `env`, is not `external: true`, and is not one Next.js/Node.js reads itself (`PORT`, `HOSTNAME`, `NODE_OPTIONS`, `NEXT_TELEMETRY_DISABLED`, `NEXT_SHARP_PATH`, `TZ`). |
| ENV003 | info | The same, but the project has dynamic `process.env` access (ENV006), so the variable may be read there and the finding is less certain. Info never fails `--strict`. |
| ENV004 | error | Invalid or unsupported config content, including syntax errors. |
| ENV005 | error | **Confirmed contract violation:** a variable declared `secret: true` has the `NEXT_PUBLIC_` prefix, or is listed under `env` in `next.config.*`. |
| ENV005 | warning | **Name-based heuristic, not a confirmed leak:** a client-visible variable (public prefix or `next.config` `env`) has a name segment of `SECRET`, `PASSWORD`, `PASSWD`, `PRIVATE`, `TOKEN` or `CREDENTIALS` (whole `_`-separated segments, after the prefix), and is not declared `secret: false`. The message starts with "Possible exposure:" and names the matched segment. Values are never inspected. |
| ENV006 | info | `process.env` used in a way whose variable name cannot be known statically. |
| ENV007 | error | The same variable declared more than once in the config (identifier, quoted and computed-literal spellings count as the same name), or a repeated `variables` key. Each repeat is reported at its own location and refers to the first; the first declaration is used. |
| ENV007 | warning | The same name appears more than once in `.env.example` (with or without `export`). Each repeat refers to the first line. |
| ENV007 | warning | Two names in the config, or in `.env.example`, differ only by letter case (`API_URL` / `api_url`). They are distinct on Linux and macOS but collide on Windows. |

Severity is part of the meaning: for ENV005, automation should treat `error` as a confirmed
violation of the declared contract and `warning` as a heuristic. Duplicate detection runs on the
AST / file lines in source order, before entries are merged. Exact duplicates are case-sensitive;
case-only differences are reported separately as above.

Recognized static access: `process.env.NAME`, `process.env["NAME"]` (also `'NAME'` and
`` `NAME` ``), optional chaining, `!`/`as`/parentheses, `const { NAME, OTHER: alias, X = "d" } = process.env`,
and `"NAME" in process.env`. Dynamic (ENV006): computed keys, `...rest` destructuring, aliasing
`process.env`, spreading it or passing it to a function.

## JSON output

`--format json` prints one document (schema version 1):

```json
{
  "schemaVersion": 1,
  "summary": {
    "errors": 1, "warnings": 0, "infos": 0, "filesScanned": 3,
    "complete": false, "dynamicAccesses": 0, "strict": false, "exitCode": 1
  },
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
- `skipped[].reason` is one of `symlink`, `unreadable`, `too-large`, `parse-failed`,
  `limit-reached` (see [Resource limits](#resource-limits)).
- Diagnostics are sorted by file (project-level findings last), line, column, code and name.
- Repository-controlled text is escaped as `\uXXXX` (surrogate pairs above U+FFFF) in every output
  format and on stderr: C0/C1 controls, DEL, soft hyphen, zero-width and invisible characters,
  line/paragraph separators, bidi marks/embeddings/overrides/isolates (including U+061C), the
  byte-order mark, interlinear annotations, tag characters and lone surrogates. In terminal output
  newlines inside a name are escaped too, so they cannot forge extra lines.
- Config syntax errors are reported by TypeScript diagnostic code only (for example
  `has a syntax error (TS1005).`), never with TypeScript's message text, which can quote source.
- `summary.complete` is `false` whenever `skipped` is non-empty: findings may then be incomplete,
  and `--strict` exits 1 even with no diagnostics. Terminal output says "Scan incomplete" (and
  "at least N paths" when scanning stopped at a resource limit).
- `summary.dynamicAccesses` counts ENV006 findings: places where variables are read dynamically
  and therefore not checked. It does not affect the exit code (dynamic access is a limit of static
  analysis, not an incomplete scan), but it is always shown, including in the terminal summary.
- Contract changes within schema version 1 are additive only: `summary.complete` and
  `summary.dynamicAccesses` (scan), and the `unknown` check status plus `summary.unknown` and
  `summary.strict` (doctor) were added before the first release. Consumers that switch on
  `status` should treat unrecognized values as "not a pass".
- Messages are for humans; automation should rely on `code`, `severity` and location fields.

## Resource limits

Hitting any limit is always disclosed and never reported as a clean, complete result.

| Limit | Value | When exceeded |
|---|---|---|
| Size of any single file read | 1,000,000 bytes | source files are skipped (`too-large`); config/`.env.example` stop the command (exit 2); an ignore file makes `doctor`'s result `unknown` |
| Directory entries visited by discovery | 200,000 | listing stops; recorded once as `limit-reached` |
| Source files per scan | 20,000 | remaining files are skipped; recorded once as `limit-reached` |
| Total source bytes per scan | 200,000,000 | as above |
| `.gitignore` rules per file / pattern length | 10,000 / 4,096 characters | `doctor`'s result is `unknown` for paths those rules apply to |
| `.git/index` size / one path / all decoded paths | 256 MiB / 4,096 bytes / 64 MiB | tracking status is `unknown` |

## Known limitations

- Only the project root's `envsync.config.ts`, `.env.example` and `next.config.*` are read; monorepo
  sub-apps must be scanned individually.
- A local variable named `process` that shadows the global is not detected.
- `.env.example` entries that are not declared in the config are not reported by `scan` yet
  (this would need a new diagnostic code).
- Malformed `.env.example` lines are ignored by `scan`; `doctor` reports them by line number.
- `type` and `description` are validated but not yet used.
- `scan` reports any string used as a `process.env["..."]` key as `variableName`, even if it is not
  a valid variable name.
- `doctor` does not read the global git excludes file (see "Known deviations from git" above).
- A process that swaps a project directory for a symlink *while* a command runs is not detected
  (file swaps are). This requires concurrent write access to the project.
- Linting is not configured in this repository yet.
