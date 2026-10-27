# Contributing

## Before changing code
Read `SECURITY.md`. Keep pull requests focused.

## Expected checks
Run the repository's actual scripts, for example:
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- `pnpm --filter envsync-vscode run test:e2e`: the VS Code extension's tests inside a real VS Code
  (downloads VS Code 1.95.0 the first time; set `ENVSYNC_VSCODE_VERSION=stable` for the latest).
- `node apps/vscode/scripts/package.mjs` (after the extension's `bundle` script): builds the
  `.vsix` into `apps/vscode/dist-pkg/`.

If a script does not exist, do not pretend it ran; either identify the correct check or propose adding it.

## Tests
Every bug fix should include a regression test. Scanner behavior should use fixture repositories and assert stable diagnostic codes, source locations where practical, and absence of secret values.

## Security
Do not include real credentials in examples or tests. Use obviously fake placeholders. Never add a test that requires uploading source code or env files.
