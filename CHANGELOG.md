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
    instead of passing because `.gitignore` lists it; warns when tracking cannot be checked.
  - `.gitignore` evaluation now follows git exactly (verified against `git check-ignore`), runs in
    linear time, and cannot be crashed by malformed patterns.
  - `init --write` verifies file identity through the open handle (symlink and hard-link swaps are
    refused on every platform), rolls back failed appends, removes incomplete new files, and
    refuses appends that would land inside an unterminated quoted value.
  - Reads of project files go through a verified handle, closing a check-then-read race.
  - Output and stderr escape zero-width, invisible, tag and lone-surrogate characters and newlines
    inside names; config syntax errors are reported by TypeScript code only.
  - Scans stop at 20,000 files or 200 MB of source and disclose it (`limit-reached`).
  - Documentation recommends running `npx envsync` outside the checkout, so a repository's
    `.npmrc` cannot change what runs.

### Fixed
- Windows CI: `.gitattributes` fixes line endings to LF; CI installs the pinned pnpm directly
  because the Corepack bundled with Node 22.12.0 cannot run pnpm 12.
- `init` no longer appends the same block repeatedly to a `.env.example` that ends inside an
  unclosed quote, and no longer reports "already lists every declared variable" for a broken config.
- Documentation no longer suggests importing `defineConfig` from `envsync` (it is not exported).
