---
name: repo-onboarding
description: Map an unfamiliar or existing EnvSync repository before implementation, documenting commands, architecture, status and risks without changing files.
---

# Repository onboarding

1. Inspect git status and top-level files.
2. Read project instructions and package/workspace metadata.
3. Map CLI, core, schema, parser, tests and CI from existing files.
4. Identify current commands by reading package scripts; do not guess.
5. Run only safe, relevant read-only inspections unless the user approves checks that modify files.
6. Note architecture boundaries, test gaps, security-sensitive paths and undocumented behavior.
7. Return a concise map: what exists, what works based on evidence, highest risks, and recommended next three tasks.
8. Do not edit files during onboarding.
