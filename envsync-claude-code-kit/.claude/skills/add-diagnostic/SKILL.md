---
name: add-diagnostic
description: Add or modify an EnvSync diagnostic code with stable semantics, tests, documentation, and safe messages.
---

# Add a diagnostic

1. Read `CLAUDE.md`, `ARCHITECTURE.md`, and `SECURITY.md`.
2. Search for existing diagnostic codes, types, formatter mappings, tests and docs.
3. Confirm whether this is a new code or a correction to an existing code. Never casually repurpose a released code.
4. Define trigger conditions, severity, evidence/location requirements, false-positive risks and user remediation.
5. Ensure the message never contains an environment-variable value or secret.
6. Implement the rule in the appropriate analysis layer; do not put rule logic in terminal formatting.
7. Add fixture-based positive, negative, malformed and security tests as applicable.
8. Verify terminal and JSON output agree and strict mode behaves as documented.
9. Update docs and examples.
10. Run checks and summarize the new behavior and known limitations.
