---
paths:
  - "apps/cli/**"
---

# CLI rules
- Keep terminal output human-readable and JSON output stable and machine-readable.
- Keep diagnostic codes and exit-code behavior consistent across formatters.
- Never print environment values.
- Make write operations preview-first and clearly show affected paths.
- Do not run package scripts from the target repository as part of `doctor`.
