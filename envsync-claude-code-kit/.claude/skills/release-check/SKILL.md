---
name: release-check
description: Prepare EnvSync for a safe CLI release by checking tests, package metadata, docs, diagnostics, and published file contents.
---

# Release checklist

1. Inspect git status, current branch, tags and package version. Do not publish or push.
2. Read README, changelog, package metadata and documented commands.
3. Run the actual available test, typecheck, lint and build scripts.
4. Verify clean and broken fixtures produce expected stable diagnostics.
5. Verify JSON output and exit codes are documented and tested.
6. Search for accidental secrets and ensure `.env*` files are excluded from package/artifact contents.
7. Inspect package contents with the package manager's dry-run/pack-list command if available.
8. Check Node/package-manager compatibility and declared dependencies.
9. Ask the security reviewer to inspect relevant changes.
10. Produce a release report with blockers, evidence and suggested fixes. Never publish, tag, or push without explicit permission.
