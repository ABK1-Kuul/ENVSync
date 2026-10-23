# Contributing

## Before changing code
Read `CLAUDE.md`, `ARCHITECTURE.md`, and `SECURITY.md`. Keep pull requests focused.

## Expected checks
Run the repository's actual scripts, for example:
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`

If a script does not exist, do not pretend it ran; either identify the correct check or propose adding it.

## Tests
Every bug fix should include a regression test. Scanner behavior should use fixture repositories and assert stable diagnostic codes, source locations where practical, and absence of secret values.

## Security
Do not include real credentials in examples or tests. Use obviously fake placeholders. Never add a test that requires uploading source code or env files.
