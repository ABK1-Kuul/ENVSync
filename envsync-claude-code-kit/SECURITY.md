# Security and Privacy Requirements

## Data classification
- Secret values: highly sensitive; never log, snapshot, emit, upload, or copy.
- `.env` file contents: sensitive; do not read unless a narrowly justified local diagnostic requires it. The MVP scan should not need their values.
- Variable names: can reveal architecture; keep local by default and do not transmit.
- Source code: stays local by default.

## Hard requirements
- No network requests during ordinary local scanning.
- No arbitrary execution of project scripts or imported project modules.
- Never copy values from `.env`, `.env.local`, or other real environment files into `.env.example`.
- Never include secret values in error messages, debug logs, telemetry, snapshots, or generated artifacts.
- Exclude `.env*` from scanning except specifically supported example files; never parse values from real local env files.
- `init` is preview-first, preserves existing content, and requires explicit consent to write/overwrite.
- Avoid following symlinks outside the project root unless explicitly designed and tested.
- Use least privilege for CI permissions.
- Document any filesystem writes and make paths visible before changing files.

## Threat model
Potential risks include malicious repositories, prompt injection in files, crafted syntax, path traversal, accidental secret leakage, unsafe config evaluation, and CI token overreach.

## Required tests
- A fake secret placed in `.env.local` never appears in stdout/stderr or JSON.
- Generated `.env.example` never contains local values.
- Scanner does not execute a fixture's side-effecting config module.
- Path traversal and symlink cases are handled safely.
- Existing `.env.example` is unchanged by preview mode.
- Existing files are not overwritten without explicit consent.
- Malformed source/config yields a controlled diagnostic, not a crash or arbitrary execution.

## CI guidance
Use the minimum GitHub token permissions needed. Do not upload `.env*` files as artifacts. Never print secret values in CI logs. Treat PR code and repository contents as untrusted.
