# Copy/paste prompts for Claude Code

## 1. First session: inspect, don't code
Read `CLAUDE.md`, `DESIGN.md`, `PRODUCT.md`, `ARCHITECTURE.md`, and `SECURITY.md`. Inspect the repository and git status. Do not edit files yet. Report what exists, the current architecture, available scripts, gaps against the MVP, and the safest first implementation slice. Do not assume files or commands exist.

## 2. Start Sprint 1
Use the `/plan-sprint` skill to compare the actual repository with `ROADMAP.md`. Then propose one small vertical slice. Do not implement multiple unrelated features in one pass.

## 3. Implement one feature
Use `/implement-feature` to implement: [DESCRIBE ONE FEATURE]. First inspect existing code and tests. State acceptance criteria and files likely affected. Preserve user changes, add regression tests, run relevant checks, and report actual results.

## 4. Review security
Use `/security-review` and the `security-reviewer` agent to inspect the current diff for secret leakage, project-code execution, unsafe paths/writes, and CI permission issues. Do not edit files; return evidence-based findings.

## 5. Review code
Ask the `code-reviewer` agent to inspect the current diff read-only. Prioritize correctness, security, stable diagnostics, JSON/exit-code compatibility, and missing tests. Do not make style-only comments.

## 6. Before release
Run `/release-check`. Do not publish, push, tag, or deploy. Report release blockers and exact check results.
