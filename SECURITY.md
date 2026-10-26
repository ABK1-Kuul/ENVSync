# Security and Privacy Requirements

## Data classification
- Secret values: highly sensitive; never log, snapshot, emit, upload, or copy.
- `.env` file contents: sensitive. `scan` reads runtime env files (`.env`, `.env.*` at any depth, except example/template/vault/keys files) by default and checks their values in memory. No value is printed unless `--show-values` is passed, and even then credentials and `secret`/`sensitive` values are redacted (the flag is ignored when `CI` is set); `--no-env-files` turns reading off. `init` and `doctor` never open them.
- Variable names: can reveal architecture; keep local by default and do not transmit.
- Source code: stays local by default.

## Hard requirements
- No network requests during ordinary local scanning.
- No arbitrary execution of project scripts or imported project modules.
- Never copy values from `.env`, `.env.local`, or other real environment files into `.env.example`.
- Never include secret values in error messages, debug logs, telemetry, snapshots, or generated artifacts. Diagnostic messages and suggestions never contain values; a value appears only in the separate `value` field of ENV005/ENV010 findings, only with `--show-values`, and redacted unless it is a malformed value of a non-private variable.
- Never treat env files as source code. Runtime env files are read only by `scan`'s env-file reader, through the same verified, no-symlink, size-capped reads as other project files.
- `init` is preview-first, preserves existing content, and requires explicit consent to write/overwrite.
- Avoid following symlinks outside the project root unless explicitly designed and tested.
- Use least privilege for CI permissions.
- Document any filesystem writes and make paths visible before changing files.

## Threat model
Potential risks include malicious repositories, prompt injection in files, crafted syntax, path traversal, accidental secret leakage, unsafe config evaluation, and CI token overreach.

## Required tests
- A fake secret placed in `.env.local` never appears in stdout/stderr or JSON unless `--show-values` is passed for a non-private variable, never in a message or suggestion, and never in CI; detected credentials never appear at all.
- `scan --no-env-files`, `init` and `doctor` never open runtime env files.
- Generated `.env.example` never contains local values.
- Scanner does not execute a fixture's side-effecting config module.
- Path traversal and symlink cases are handled safely.
- Existing `.env.example` is unchanged by preview mode.
- Existing files are not overwritten without explicit consent.
- Malformed source/config yields a controlled diagnostic, not a crash or arbitrary execution.

## CI guidance
Use the minimum GitHub token permissions needed. Do not upload `.env*` files as artifacts. Never print secret values in CI logs (never pass `--show-values` in CI). Treat PR code and repository contents as untrusted.
