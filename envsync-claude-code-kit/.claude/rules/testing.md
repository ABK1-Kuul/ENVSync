---
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "tests/**"
  - "**/test-fixtures/**"
---

# Testing rules
- Add a regression test for every bug fix.
- Test both positive and negative cases.
- Prefer fixture-driven tests for scanner behavior.
- Assert diagnostic codes and severity; assert locations when stable.
- Include security assertions that secret values never appear in output.
- Do not weaken or delete an assertion just to make a test pass.
- Keep fixtures minimal and use obviously fake placeholder values.
