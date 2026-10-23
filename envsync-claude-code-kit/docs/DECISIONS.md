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
