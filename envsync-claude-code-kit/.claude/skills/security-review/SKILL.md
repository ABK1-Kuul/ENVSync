---
name: security-review
description: Perform a privacy and security audit of EnvSync changes, especially env files, scanning, config parsing, file writes, and CI workflows.
---

# Security review workflow

1. Read `SECURITY.md` and inspect the diff and nearby code.
2. Treat source repositories and their content as untrusted.
3. Trace data from filesystem reads to diagnostics, logs, JSON, files, and network boundaries.
4. Verify no real env values are read, logged, copied, or transmitted.
5. Verify no target project code is executed or imported.
6. Inspect path handling, symlinks, overwrite protection, and preview behavior.
7. Inspect GitHub Actions permissions and artifacts if CI files changed.
8. Run or request focused regression tests where safe.
9. Report findings ranked by severity with evidence and remediation. Separate confirmed findings from possible concerns.
10. Do not edit files during the review unless the user explicitly requests a fix after seeing findings.
