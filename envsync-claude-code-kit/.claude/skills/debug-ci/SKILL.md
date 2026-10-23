---
name: debug-ci
description: Diagnose EnvSync CI or GitHub Actions failures using logs and repository state without weakening tests or permissions.
---

# Debug CI

1. Ask for or inspect the failing job/log and identify the first meaningful failure.
2. Separate code failure, environment mismatch, dependency/cache issue and workflow configuration.
3. Reproduce the narrow failure locally when possible.
4. Check Node/pnpm versions, lockfile use, working directory and script names.
5. Inspect permissions and artifact paths if security-related.
6. Make the smallest fix and add a regression test where appropriate.
7. Never print secrets, dump the environment, loosen permissions, or disable checks as a shortcut.
8. Rerun relevant checks and report evidence, root cause, fix and remaining uncertainty.
