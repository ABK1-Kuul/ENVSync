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
