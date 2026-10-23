---
name: implement-feature
description: Implement a scoped EnvSync feature safely, with a plan, tests, relevant quality checks, and a concise report. Use when building or changing product behavior.
---

# Implement a feature

1. Read `CLAUDE.md`, `PRODUCT.md`, `ARCHITECTURE.md`, and `SECURITY.md`.
2. Inspect repository status and existing implementation. Do not overwrite uncommitted user work.
3. Restate the goal and acceptance criteria; identify out-of-scope work.
4. For substantial cross-package work, ask the `architect` agent for a read-only plan.
5. Implement the smallest vertical slice. Keep package boundaries intact.
6. Add tests before or alongside implementation. Include relevant edge cases.
7. Run targeted tests, then typecheck/lint/build if scripts exist.
8. Ask `code-reviewer` for a read-only review; use `security-reviewer` for sensitive paths.
9. Fix verified findings and rerun affected checks.
10. Report changed files, behavior, commands/results, limitations, and remaining risks.

Do not claim success without evidence. Ask before adding dependencies, changing public contracts, deleting files, or altering security guarantees.
