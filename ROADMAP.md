# Roadmap

## Sprint 1 — Reliable local scan
- [x] Inspect repo and establish pnpm workspace / TypeScript / tests. (Lint still pending.)
- [x] Build file discovery with safe exclusions.
- [x] Implement AST extraction for `process.env.NAME` and `process.env["NAME"]`.
- [x] Define validated config contract and diagnostic model.
- [x] Compare source references with contract and `.env.example`.
- [x] Add terminal output, JSON output, strict mode and stable exit codes.
- [x] Add clean, missing-variable, dynamic-access, malformed-config and secret-leak fixtures.
- [x] Document limitations (docs/CLI.md) and run quality gates. (Lint still pending.)

## Sprint 2 — Safe setup and CI
- [x] `envsync init` preview and safe placeholder generation.
- [x] `envsync doctor` without arbitrary script execution.
- [x] GitHub Actions example with least-privilege permissions (repo CI + docs/CI.md). Not yet run on GitHub.
- [x] Improve unused-variable confidence and duplicate detection.
- [x] Package metadata, README, changelog and npm publish dry run (`envsync`, Apache-2.0, bundled; tarball installed and exercised locally, not published).

## Later, based on user feedback
- VS Code extension.
- Shared team policies and cross-repository reports.
- Hosted dashboard and repository integration.
- Deployment-provider drift checks.

## Release gates
- All fixture tests pass.
- No known secret leakage.
- No target project code execution.
- Stable diagnostics and JSON contract.
- README examples run against the released CLI.
- Security review and package contents review completed.
