# Product Requirements — EnvSync MVP

## Goals
- Identify statically visible environment-variable references in a Next.js project.
- Compare references with `envsync.config.ts` and `.env.example`.
- Produce actionable, stable diagnostics.
- Safely preview and generate example configuration.
- Provide JSON output and CI-friendly exit codes.
- Prove privacy properties with tests.

## Non-goals
No credential storage, secret-value syncing, remote telemetry by default, production deployment mutations, arbitrary app execution, automatic code edits, or multi-framework support in MVP.

## Initial commands
- `envsync scan`
- `envsync scan --format json`
- `envsync scan --strict`
- `envsync init` (preview by default; writes only after explicit confirmation)
- `envsync doctor` (safe diagnostics only; never runs arbitrary package scripts)

Confirm actual command names and flags against the implementation before documenting them as released behavior.

## Source-of-truth model
- `envsync.config.ts`: intended contract (required, type, description, secret/client visibility metadata).
- Source AST: evidence of static references.
- `.env.example`: onboarding documentation and safe placeholders.
- Real `.env` files: local runtime inputs only; never authoritative and never copied or uploaded.

A missing schema declaration is not the same as a missing runtime value.

## Acceptance criteria
1. Static `process.env.NAME` and `process.env["NAME"]` are detected.
2. Dynamic access is reported as incomplete analysis, not falsely resolved.
3. Excluded directories and generated files are not scanned.
4. `.env.example` generation never copies local secret values.
5. Existing files are not overwritten without explicit approval.
6. Terminal and JSON diagnostics agree on code/severity.
7. Strict mode behavior and exit codes are documented and tested.
8. A clean fixture produces no unexpected errors.
9. Broken fixtures reliably produce expected diagnostic codes and locations.
10. The scan does not execute project code or make network calls.
