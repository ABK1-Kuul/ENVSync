# Architecture Decision Records

Record significant decisions here. Keep entries short and dated.

## ADR-001: Local-first scanning
- Status: Accepted for MVP
- Decision: Ordinary scans run locally and do not upload source code or environment values.
- Reason: Privacy is a core differentiator and avoids requiring accounts or network access.
- Consequence: Hosted reporting, if added later, must be opt-in with a separate threat model.

## ADR-002: Never execute target project code
- Status: Accepted for MVP
- Decision: Do not import project config modules or run package scripts to inspect a repository.
- Reason: Repositories may contain arbitrary code and side effects.
- Consequence: Config parsing must use a constrained/static representation; unsupported syntax should produce an actionable diagnostic.

## ADR-003: Stable diagnostics
- Status: Accepted for MVP
- Decision: Diagnostic codes and JSON shape are public interfaces once released.
- Reason: CI users and integrations depend on stable machine-readable output.
- Consequence: Changes require tests and release notes.

## ADR-004: Toolchain and repository layout
- Status: Accepted (2026-10-23)
- Decision: Kit files live at the repository root. pnpm workspace (`apps/*`, `packages/*`), pinned via `packageManager`. Node 22 LTS target (`engines: >=22.12.0`, Vitest's floor). TypeScript 6.x for the compiler API (TypeScript 7's native port has a different API). Vitest for tests.
- Reason: Root placement makes `CLAUDE.md` and `.claude/` guardrails load when Claude Code starts in the repo. Pinned versions keep installs reproducible.
- Consequence: Linting is not configured yet; adding ESLint is a separate dependency decision.

## ADR-005: Restricted, statically parsed TypeScript config
- Status: Accepted (2026-10-23)
- Decision: `envsync.config.ts` is read as text and parsed with the TypeScript AST. Only a constrained literal subset is supported; the file is never imported, transpiled-and-run, or evaluated.
- Reason: Upholds ADR-002 while keeping an ergonomic, typed config file.
- Consequence: Unsupported syntax (computed values, spreads, imports used as values, function calls other than the documented wrapper) produces an actionable ENV004 diagnostic instead of being evaluated. The supported grammar is documented in `docs/CLI.md`.

## ADR-006: Source discovery boundary
- Status: Accepted (2026-10-23)
- Decision: Discovery reads directory listings only, never follows symlinks or junctions, skips `.git`, `node_modules`, `.next`, `dist`, `build`, `out`, `coverage` (case-insensitive), excludes `.env`/`.env.*` (including `.env.example`) and `*.d.ts`/`*.d.mts`/`*.d.cts`.
- Reason: Keeps the scan inside the project root and away from secrets and generated code.
- Consequence: Skipped symlinks and unreadable directories are returned to callers so later diagnostics can disclose incomplete coverage.

## ADR-007: Exit codes, JSON contract and fixture conventions
- Status: Accepted (2026-10-23)
- Decision: Exit 0 = clean, 1 = errors (or warnings with `--strict`), 2 = usage error or the scan could not run. JSON output carries `schemaVersion: 1`. Fixture `.env.example` content is stored as `env.example.fixture` and materialized in a temp copy at test time.
- Reason: CI needs to tell "findings" apart from "could not scan". Keeping dotenv files out of git and out of agent-blocked paths keeps fixtures maintainable without weakening the `.env*` deny rules.
- Consequence: Changing exit codes or the JSON shape requires a schema version bump and release notes (ADR-003).

## ADR-008: `init` writes only by exclusive create or verified append
- Status: Accepted (2026-10-23)
- Decision: `init` previews by default; `--write` is the explicit consent. The config is only ever created (never rewritten). `.env.example` is created, or gains an appended block of empty placeholders. Creates use exclusive mode; appends are refused if the file's SHA-256 changed since the preview; symlinks are refused (and `O_NOFOLLOW` is used where available).
- Reason: Satisfies "preview first, never overwrite without consent" without an interactive prompt, so it works the same in terminals and scripts.
- Consequence: Updating an existing config stays a manual edit; `scan` reports what to change.
- Amended (2026-10-23, after security review): `--write` re-plans and applies in one run rather than replaying the earlier preview, and the docs say so. Appends go through one verified handle (same device and inode as the checked file, regular, single hard link, content hash unchanged), written at the verified end offset without `O_APPEND` so a failed write can be truncated back on every platform. Creates remove their own incomplete file on failure. Plans that would not stick (unterminated quote, unreadable append) or that come from a config with problems are blocked or skipped. Reads use the same verified-handle approach.

## ADR-009: `doctor` evaluates `.gitignore` itself instead of running git
- Status: Accepted (2026-10-23)
- Decision: `doctor` reads `.gitignore` files from the project up to the repository root and `.git/info/exclude`, and evaluates them with a small built-in matcher. It lists `.env*` file names but never opens them.
- Reason: Running `git` would mean spawning processes, which the no-execution boundary forbids, and a repository can configure git to run hooks or helpers.
- Consequence: The global excludes file and already-tracked files are not detected; this is documented.
- Amended (2026-10-23, after security review): tracked files are now detected by parsing `.git/index` (names only; unknown → warning, never pass). The regex-based matcher was replaced by a linear-time port of git's wildmatch with git's line-splitting, trimming and `core.ignorecase` rules, verified by a differential test against `git check-ignore` (tests may run git; product code does not).

## ADR-010: ENV003 severity reflects analysis completeness
- Status: Accepted (2026-10-23)
- Decision: ENV003 is a warning when the scan saw no dynamic `process.env` access and info otherwise. Variables marked `external: true` or read by the framework itself are never reported.
- Reason: "Unused" cannot be known when dynamic access exists; `--strict` should not fail on a guess.
- Consequence: Severity of an existing code depends on context; documented in docs/CLI.md.

## ADR-011: Publish one bundled `envsync` package; internal packages use `@envsync-internal/*`
- Status: Accepted (2026-10-23)
- Decision: Publish only `envsync` (Apache-2.0) from `apps/cli`, bundled with esbuild into a single ESM file; `typescript` stays an external runtime dependency. Internal workspace packages are renamed from `@envsync/*` to `@envsync-internal/*`, remain `private`, and are never published.
- Reason: The `@envsync` npm scope belongs to a third party, so internal names under it were a dependency-confusion risk. Bundling means no internal name ever needs to resolve from a registry.
- Consequence: esbuild is a devDependency (install script denied). Registering the `@envsync-internal` scope on npm is recommended. Release steps are in docs/RELEASING.md.
- Amended (2026-10-23, after code review): `apps/cli` is `private`; the package is staged outside the repository with an allow-listed manifest (no devDependencies/scripts), so no generated copies land in the source tree and internal names never appear in the published manifest.
