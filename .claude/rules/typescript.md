---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---

# TypeScript / JavaScript rules
- Prefer strict types and explicit return types for exported public functions when it improves API clarity.
- Avoid `any`; use `unknown` plus validation at untrusted boundaries.
- Keep parsing, analysis, diagnostics and formatting separate.
- Use AST parsing for source analysis; do not replace AST logic with regex shortcuts.
- Handle malformed input deliberately and return actionable errors.
- Do not add a dependency without explaining why and asking for approval.
- Avoid unsafe casts that bypass config validation.
