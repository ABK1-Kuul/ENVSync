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
      # --strict fails the job on warnings too. Drop it to fail only on errors.
      - run: npx --yes envsync@<version> scan --strict
```

## Recommendations

- **Least privilege.** EnvSync needs `contents: read` only. It makes no network requests while
  scanning and needs no secrets: do not pass repository secrets or environment variables to this job.
- **Pin versions.** Pin EnvSync to an exact version and pin actions to commit SHAs (as above), so
  a compromised tag cannot change what runs in CI.
- **Do not upload env files.** Never add `.env*` files as workflow artifacts. If you keep the JSON
  report as an artifact, it contains variable names and file locations but never values.
- **Pull requests from forks** run with read-only tokens by default; keep it that way. EnvSync does
  not need `pull_request_target`.
- **Monorepos.** Run one step per Next.js app: `npx --yes envsync@<version> scan apps/web --strict`.

## Exit codes

| Code | Meaning in CI |
|---|---|
| `0` | Configuration is consistent. |
| `1` | Findings: errors, or warnings with `--strict`. Fix them or adjust the contract. |
| `2` | EnvSync could not run (for example, missing `envsync.config.ts`). Treat it as a setup failure. |

`envsync doctor` is meant for local setup; it is not needed in CI.

## This repository's own CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) typechecks, builds and tests EnvSync on
Ubuntu and Windows with Node.js 22 (including the minimum 22.12.0) and 24, then smoke-tests the
built CLI. It uses Corepack for pnpm, read-only permissions, SHA-pinned actions, and no caches.
