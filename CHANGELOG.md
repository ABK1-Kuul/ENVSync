# Changelog

All notable changes to EnvSync are documented here. Diagnostic codes, exit codes and the JSON
output shape are public contracts (ADR-003); changes to them are called out explicitly.

## [Unreleased]

### Added
- `envsync scan` with terminal and JSON output (`schemaVersion: 1`), `--strict`, and exit codes
  0 (clean), 1 (findings), 2 (usage error or could not run).
- Diagnostics ENV001–ENV007: undeclared reference, required variable missing from `.env.example`,
  possibly unused declaration, invalid config, client-side exposure (confirmed error and
  name-based heuristic warning), dynamic access, duplicates and case-only collisions.
- Static parser for a restricted `envsync.config.ts`: read as data, never executed; unsupported
  syntax and top-level code are reported as ENV004.
- `envsync init`: preview-first generation of `envsync.config.ts` and `.env.example` placeholders;
  `--write` creates files exclusively or appends, never overwrites, and refuses files that
  changed since the preview.
- `envsync doctor`: read-only setup checks, including whether local env files are ignored by git
  (evaluated without running git or reading env file contents).
- `external: true` config field to mark variables read outside the scanned source.
- GitHub Actions CI with read-only permissions and SHA-pinned actions.
- Published as a single bundled package, `envsync`, licensed Apache-2.0. Requires Node.js 22.12+.

### Security
- Internal workspace packages renamed to `@envsync-internal/*` and bundled into the CLI, because the `@envsync` npm scope is owned by a third party (dependency-confusion risk).
- Never reads `.env`/`.env.*` values, never executes project code, makes no network requests;
  enforced by tests, including a static check that shipped code uses no evaluation, process or
  network APIs.
- Symlinks are never followed; oversized files are skipped; terminal/JSON output escapes control
  and bidi characters from repository content.
- Hardening from the Sprint 2 security and code reviews:
  - `doctor` fails when a `.env*.local` file is already tracked by git (read from `.git/index`),
    instead of passing because `.gitignore` lists it.
  - New `doctor` status `unknown`: whenever ignore or tracking status cannot be established
    (unreadable/oversized/over-limit ignore files, split or sparse index, malformed or oversized
    index, linked worktrees), the result is `unknown`, never `pass`. `doctor --strict` fails on
    `warn` and `unknown`.
  - A `.git` directory counts as a repository only if git would accept it (`HEAD`, `objects/`,
    `refs/`), so a planted `.git` cannot supply its own ignore rules.
  - The git index reader is bounded (per-name and total decoded bytes) and rejects malformed
    varints, entries and extensions.
  - `.gitignore` evaluation matches `git check-ignore` on the tested corpus (including non-ASCII
    names and `core.ignorecase`), works on bytes like git, runs in linear time, and cannot be
    crashed by malformed patterns. Known deviations are documented.
  - `init --write` verifies file identity through the open handle (symlink and hard-link swaps are
    refused on every platform), checks every append target before writing anything, rolls back
    failed appends, removes only its own incomplete new files, and refuses appends that would land
    inside an unterminated quoted value. Hard-linked `.env.example` files are blocked in the preview.
  - Reads of project files and the git index go through a verified handle.
  - Output and stderr escape zero-width, invisible, tag and lone-surrogate characters and newlines
    inside names; config syntax errors are reported by TypeScript code only.
  - Discovery stops at 200,000 entries and scans at 20,000 files or 200 MB of source. Any path
    not scanned makes the scan incomplete (`summary.complete: false`, "Scan incomplete" in the
    terminal), and `scan --strict` then exits 1.
  - Package staging refuses symlinked inputs.
  - Documentation recommends running `npx envsync` outside the checkout, so a repository's
    `.npmrc` cannot change what runs.
- Hardening from the final review round:
  - `doctor` searches for the repository from the project's real path (symlinks and junctions
    resolved), as git does; if the real path cannot be resolved the result is `unknown`.
  - `.git` detection follows git's rules in both directions: a `.git` git definitely rejects is
    passed over; one git might accept but EnvSync cannot verify (links, `commondir`, `objects`/`refs`
    that are not plain directories, an oversized `HEAD`), or a search that hits the 64-level
    limit, gives `unknown` instead of `skip`. `HEAD` is checked like git (first 255 bytes,
    `ref:` + space/tab/CR/LF, 40+ hex digits in any case).
  - Case folding reproduces git's asymmetry (escaped letters and single class members are not
    folded) and reversed class ranges match their first character like git, so `.[E]nv.local` and
    `!.[e-a]nv.local` no longer produce a false pass. Patterns like `apps**/.env.local`, which older
    and newer git versions match differently, are `unknown` when the two behaviours disagree.
  - `core.ignorecase` is only trusted from an exact `[core]` section of a fully parsed
    `.git/config`; otherwise both settings are evaluated and a result that depends on it is
    `unknown`. A tracked file whose name differs only by letter case is `unknown` unless
    `core.ignorecase=true` (then it is tracked): with `false`, `git commit -a` still commits it on
    a case-insensitive file system.
  - Tracking answers are `unknown` whenever repository detection had any doubt, and for paths
    outside the checked project.
  - A file that shrinks while being read is reported as changed, never as complete, with an
    accurate message.

### Changed
- A symbolic link marks a scan incomplete unless its name is clearly not scanned (env files,
  excluded directories, type declarations, known non-source extensions such as images, `.md` or
  `.json`); a linked `node_modules`, image or `.env.local` no longer makes `scan --strict` fail,
  while a linked `api.v2` or `[...slug]` directory still does.
- `dist`, `build`, `out` and `coverage` are scanned inside the project's Next.js route tree
  (`app/` or `pages/` at the root or under `src/`), where they are route segments.
- `doctor`'s `source-files` check warns about paths that will not be scanned and is `unknown` when
  the project exceeds the scan limits; incomplete-scan messages say "at least N paths" after a limit.
- Scan JSON adds `summary.dynamicAccesses`, and the terminal summary always mentions dynamic
  `process.env` access (ENV006); it is reported but does not fail `--strict`.
- Additive JSON contract changes within schema version 1 are documented in docs/CLI.md.

### Fixed
- Windows CI: `.gitattributes` fixes line endings to LF; CI installs the pinned pnpm directly
  because the Corepack bundled with Node 22.12.0 cannot run pnpm 12; the packaging step uses
  paths relative to `RUNNER_TEMP` (GNU tar misreads `D:\...`) and locale-independent sorting.
- CI smoke tests now require exactly exit code 1 for the drift fixture (exit 0 used to pass), and
  the internal-name leak check no longer misses matches under `pipefail`.
- `init` no longer appends the same block repeatedly to a `.env.example` that ends inside an
  unclosed quote, and no longer reports "already lists every declared variable" for a broken config.
- Documentation no longer suggests importing `defineConfig` from `envsync` (it is not exported).
