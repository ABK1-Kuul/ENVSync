# EnvSync

**Configuration that stays in sync with your code.**

EnvSync is a local-first CLI for Next.js + TypeScript projects. It compares the environment
variables your source code reads with an explicit contract (`envsync.config.ts`) and your
`.env.example`, and reports precise, actionable diagnostics, without ever reading or printing
secret values.

> Status: pre-release (`0.0.0`), not yet published to npm. See [ROADMAP.md](https://github.com/ABK1-Kuul/ENVSync/blob/main/ROADMAP.md).

## What it does

Excerpt of real output from the `tests/fixtures/next-pages-router` fixture (4 of 7 findings shown):

```text
$ envsync scan
ENV002 error envsync.config.ts:4:5 - STRIPE_KEY is required by envsync.config.ts but absent from .env.example.
  Suggestion: Add a placeholder line `STRIPE_KEY=` to .env.example. Do not copy a real value.
ENV005 error next.config.js:3:5 - STRIPE_KEY is declared `secret: true` in envsync.config.ts, but next.config.js lists it under `env`, which Next.js inlines into client-side JavaScript.
  Suggestion: Remove STRIPE_KEY from `env` in next.config.js and read it only in server code.
ENV006 info pages/api/data.ts:3:17 - Dynamic process.env access cannot be fully analyzed; variables read here are not checked.
  Suggestion: Read each variable with a literal name, such as process.env.NAME or process.env["NAME"].
ENV001 error pages/api/data.ts:5:17 - MISSING_IN_CONFIG is referenced but not declared in envsync.config.ts. It is also referenced in 1 other place.
  Suggestion: Add MISSING_IN_CONFIG under `variables` in envsync.config.ts, or remove the reference if it is a mistake.

Found 4 errors, 1 warning and 2 info in 3 files.
```

- **`envsync scan`** finds undeclared references, required variables missing from
  `.env.example`, possibly unused declarations, invalid config, client-side exposure of secrets,
  dynamic access that cannot be analyzed, and duplicates. Terminal or JSON output, `--strict` for CI.
- **`envsync init`** previews a starter `envsync.config.ts` and `.env.example` placeholders, and
  writes only with `--write`. It never overwrites a file.
- **`envsync doctor`** checks your local setup, including whether `.env*.local` files are ignored
  by git, without reading their contents.

Full reference: [docs/CLI.md](https://github.com/ABK1-Kuul/ENVSync/blob/main/docs/CLI.md). CI setup: [docs/CI.md](https://github.com/ABK1-Kuul/ENVSync/blob/main/docs/CI.md).

## Privacy and safety guarantees

- No values: EnvSync never prints, stores or copies environment-variable values, and never reads
  `.env`/`.env.*` files (except `.env.example`, whose values it discards).
- No code execution: source files, `next.config.*` and `envsync.config.ts` are parsed, never
  imported or run. No package scripts are run, and `git` is not invoked.
- No network: scanning is entirely local.
- No surprise writes: only `init --write` writes, and only by creating new files or appending
  placeholder lines.

These properties are enforced by tests in [tests/security](https://github.com/ABK1-Kuul/ENVSync/blob/main/tests/security).

## The contract: `envsync.config.ts`

```ts
export default {
  variables: {
    DATABASE_URL: { required: true, secret: true, type: "url" },
    NEXT_PUBLIC_SITE_URL: { secret: false, type: "url" },
    SENTRY_RELEASE: { required: false, external: true },
  },
};
```

The file is read as data, so only literal values are supported. See
[docs/CLI.md](https://github.com/ABK1-Kuul/ENVSync/blob/main/docs/CLI.md#config-file-envsyncconfigts).

## Development

Requirements: Node.js 22.12+ and pnpm (pinned via `packageManager`; `corepack enable` on Node 22/24).

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
node apps/cli/dist/bin.js scan path/to/next-app
```

| Path | Purpose |
|---|---|
| `packages/schema` | Static config parser, `.env.example` parser, safe text generation |
| `packages/parser-next` | AST extraction of `process.env` references, `next.config` `env` keys |
| `packages/core` | Discovery, analysis, diagnostics, scan / init / doctor orchestration |
| `apps/cli` | Argument parsing, formatters, exit codes |
| `tests` | Fixture projects, integration and security tests |

Contributor guidance: [CONTRIBUTING.md](https://github.com/ABK1-Kuul/ENVSync/blob/main/CONTRIBUTING.md), [SECURITY.md](https://github.com/ABK1-Kuul/ENVSync/blob/main/SECURITY.md),
[docs/DECISIONS.md](https://github.com/ABK1-Kuul/ENVSync/blob/main/docs/DECISIONS.md). The Claude Code project kit is described in
[docs/CLAUDE-KIT.md](https://github.com/ABK1-Kuul/ENVSync/blob/main/docs/CLAUDE-KIT.md).
