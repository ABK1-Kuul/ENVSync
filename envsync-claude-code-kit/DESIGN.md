# EnvSync Design Brief

## Product statement
**Configuration that stays in sync with your code.**

EnvSync helps developers catch configuration drift before it becomes a broken local setup or CI failure.

## Primary user
A developer joining or maintaining a Next.js + TypeScript repository who needs to understand which environment variables are required and why the app may not start.

## Core user jobs
1. Find environment variables used in source code but missing from the declared contract.
2. Keep the documented `.env.example` aligned with the declared contract.
3. Catch invalid definitions and suspicious client-side exposure.
4. Help a developer diagnose setup problems without uploading project files or running arbitrary scripts.
5. Run the same deterministic checks locally and in GitHub Actions.

## MVP UX principles
- Local-first and useful without an account.
- A scan should be fast, quiet, and easy to understand.
- Show severity, code, source location, explanation, and next step.
- Support terminal output for humans and stable JSON for automation.
- `init` previews changes before writing.
- Existing files are preserved unless the user explicitly approves a change.
- Be explicit when static analysis cannot know the answer.

## Example interaction
`envsync scan`

Expected style (illustrative, not a fixed output contract):
- `ENV001 error src/db.ts:12 — DATABASE_URL is referenced but not declared in envsync.config.ts. Add a definition or verify the reference.`
- `ENV002 error — AUTH_SECRET is required by the contract but absent from .env.example. Add a placeholder entry.`
- `ENV006 info src/config.ts:8 — Dynamic environment access cannot be fully analyzed.`

Never print values from local `.env` files.

## Product boundaries
MVP: Next.js + TypeScript/JavaScript, CLI, AST-based static analysis, config schema, `.env.example` support, JSON output, strict mode, tests and GitHub Actions integration.

Later, only after validating demand: VS Code extension, team policy, cross-repository visibility, hosted dashboard, deployment-provider drift checks.

Not MVP: secrets manager, credential vault, production secret syncing, automatic source rewrites, code execution during scans, or uploading source files.

## Accessibility and clarity
Use plain language. Do not rely on color alone for severity. Keep messages useful in terminal-only and CI contexts. Make exit codes predictable and document them.
