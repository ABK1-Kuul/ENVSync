# Using EnvSync in GitHub Actions

> EnvSync is not published to npm yet. The workflow below shows the intended setup once a
> release exists; replace `<version>` with the exact released version you want to pin.

```yaml
name: Environment config

on:
  pull_request:
  push:
    branches: [main]

# EnvSync only reads the repository. Grant nothing else.
permissions:
  contents: read

jobs:
  envsync:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: "22"
      # Run npx from outside the checkout and pass the project path. Inside the checkout, npm would
      # read the repository's own .npmrc (registry, node-options, ...), which a pull request can
      # change to run its own code before EnvSync starts.
      - name: EnvSync scan
        working-directory: ${{ runner.temp }}
        env:
          npm_config_registry: https://registry.npmjs.org/
        # --strict also fails on warnings and on an incomplete scan (any path not scanned).
        # Drop it to fail only on errors. This step uses bash syntax ("$GITHUB_WORKSPACE"); on a
        # Windows runner set `shell: bash` or use "$env:GITHUB_WORKSPACE" in PowerShell.
        run: npx --yes envsync@<version> scan "$GITHUB_WORKSPACE" --strict
```

## Recommendations

- **Run outside the checkout.** Never run `npx envsync` (or any `npx`) with the untrusted
  checkout as the working directory: npm loads that directory's `.npmrc`, and a local
  `node_modules/.bin/envsync` would take precedence. Pass the project path as an argument
  instead, as above. The same applies locally when you inspect an unfamiliar repository.
- **Least privilege.** EnvSync needs `contents: read` only. It makes no network requests while
  scanning and needs no secrets: do not pass repository secrets or environment variables to this job.
- **Pin versions.** Pin EnvSync to an exact version and pin actions to commit SHAs (as above), so
  a compromised tag cannot change what runs in CI.
- **Do not upload env files.** Never add `.env*` files as workflow artifacts. If you keep the JSON
  report as an artifact, it contains variable names and file locations but never values.
- **Pull requests from forks** run with read-only tokens by default; keep it that way. EnvSync does
  not need `pull_request_target`.
- **Monorepos.** Run one step per Next.js app:
  `npx --yes envsync@<version> scan "$GITHUB_WORKSPACE/apps/web" --strict` (still from `runner.temp`).

## Exit codes

| Code | Meaning in CI |
|---|---|
| `0` | Configuration is consistent. |
| `1` | Findings: errors, or with `--strict` also warnings or an incomplete scan (`summary.complete: false`; the skipped paths are listed). Fix them or adjust the contract. |
| `2` | EnvSync could not run (for example, missing `envsync.config.ts`). Treat it as a setup failure. |

`envsync doctor` is meant for local setup; it is not needed in CI.

## This repository's own CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) typechecks, builds and tests EnvSync on
Ubuntu and Windows with Node.js 22 (including the minimum 22.12.0) and 24. It then stages and
packs the publishable package outside the checkout, checks its exact contents, installs the
tarball into a fresh project and runs it.

It installs pnpm with `npm install --global pnpm@<packageManager version>` instead of Corepack: the
Corepack bundled with Node.js 22.12.0 cannot run pnpm 11 or newer, and Corepack releases that can
require Node.js 22.22.2 or newer. A test keeps the CI pin equal to `packageManager`. Line endings
are fixed to LF by `.gitattributes`, so Windows checkouts behave like Linux ones. Permissions are
read-only, actions are pinned to commit SHAs, and nothing is cached.
