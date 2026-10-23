# EnvSync Claude Code Kit

This kit gives Claude Code product context, architecture and security guardrails, scoped rules, reusable skills, and read-only review agents for building EnvSync.

## Install
1. Unzip this folder.
2. Copy the contents into the root of your EnvSync repository. Merge carefully if `CLAUDE.md`, `.claude/`, or docs already exist; do not overwrite your own work blindly.
3. Start Claude Code from the repository root.
4. First ask Claude to read `PROMPTS.md` and perform the "First session: inspect, don't code" prompt.
5. Review `.claude/settings.json` and adjust permissions to your environment before use.

## Included
- `CLAUDE.md`: core always-on project context.
- `AGENTS.md`: optional cross-agent reference.
- `DESIGN.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `SECURITY.md`, `ROADMAP.md`.
- `.claude/rules/`: scoped TypeScript, testing, security and CLI conventions.
- `.claude/agents/`: architect, planner, test engineer, code reviewer and security reviewer.
- `.claude/skills/`: implementation, diagnostic, security, release, CI debugging, sprint planning and repository onboarding workflows.
- `.claude/settings.json`: conservative permission-deny examples; review and test against your Claude Code version.
- `docs/`: decision records and definition of done.
- `PROMPTS.md`: copy/paste prompts for common workflows.

## Important
This is a starter policy pack, not proof that the implementation is secure or correct. Agent instructions are guidance, not a security sandbox. Use actual filesystem permissions, reviewed hooks, tests, CI restrictions and human review for hard guarantees. The deny rules for `.env` files are intentionally conservative; if you have a legitimate task involving env-file names, do not weaken them casually. Never paste real secrets into prompts.

## Suggested first prompt
Use the prompt in `PROMPTS.md` called "First session: inspect, don't code".
