# EnvSync

> **Configuration that stays in sync with your code.**

EnvSync is a local-first configuration correctness tool for Next.js + TypeScript/JavaScript projects. It statically analyzes environment-variable usage in your codebase, compares it against an explicit contract and `.env.example`, and reports actionable diagnostics before drift breaks local onboarding or CI pipelines.

---

## Why EnvSync?

In modern web development, environment variables are scattered across client and server files, `.env.local`, and deployment platforms. Teams frequently face:
- **Silent Breakages**: Code references an environment variable that is missing from documentation, causing fresh checkouts to fail.
- **Accidental Secret Leaks**: A sensitive secret is inadvertently prefixed with `NEXT_PUBLIC_` or bundled in `next.config.js`, exposing it in client bundles.
- **Ghost Declarations**: Documented variables that are no longer used anywhere in the codebase.
- **CI Blind Spots**: No automated way to verify that `.env.example` matches what the code actually requires.

EnvSync provides deterministic, static verification of your configuration contract without executing your application or exposing sensitive credentials.

---

## Key Principles & Features

- **🔍 AST-Based Static Analysis**: Parses source files using the TypeScript compiler API to accurately detect `process.env.VAR`, bracket access (`process.env["VAR"]`), destructuring, and existence checks.
- **🔒 Zero-Knowledge Privacy**: Never reads values from real `.env` or `.env.local` files, never logs or prints secrets, and strips values from `.env.example` during parsing.
- **🛡️ Zero Code Execution**: Parses `envsync.config.ts` and source files as inert data trees. Never executes, imports, or runs target project code.
- **⚠️ Exposure Guardrails**: Flags variables marked `secret: true` that carry the `NEXT_PUBLIC_` prefix or are exposed in `next.config.js`. Heuristically warns about variables containing keywords like `SECRET`, `KEY`, or `TOKEN` on the client.
- **🤖 CI-Ready**: Provides machine-readable JSON output (`schemaVersion: 1`), predictable exit codes, and a `--strict` mode.
- **🌐 100% Local-First**: No network calls, no cloud telemetry, and no account required.

---

## Quick Start

### 1. Build and Run

From the repository:

```sh
pnpm install
pnpm build
```

Run a scan against any Next.js project:

```sh
node apps/cli/dist/bin.js scan path/to/next-project
```

### 2. Add an `envsync.config.ts` Contract

Create an `envsync.config.ts` at the root of your Next.js project:

```ts
// No import needed: EnvSync reads this object as data (the envsync package exports no defineConfig).
export default {
  variables: {
    // Required server-side secret
    DATABASE_URL: {
      required: true,
      secret: true,
      type: "url",
      description: "PostgreSQL connection string",
    },

    // Public client-side variable
    NEXT_PUBLIC_SITE_URL: {
      required: true,
      secret: false,
      type: "url",
      description: "Public URL of the application",
    },

    // Optional variable
    LOG_LEVEL: {
      required: false,
      type: "string",
    },
  },
};
```

*Note: `envsync.config.ts` is parsed statically and never executed. Supported fields include `required` (default `true`), `secret`, `external`, `type`, and `description`.*

### 3. Ensure `.env.example` Contains Safe Placeholders

```sh
# .env.example
DATABASE_URL=postgres://user:password@localhost:5432/dbname
NEXT_PUBLIC_SITE_URL=http://localhost:3000
LOG_LEVEL=info
```

---

## CLI Usage

```
envsync scan [directory] [options]
```

### Options

| Option | Description |
|---|---|
| `[directory]` | Project directory to scan (defaults to current directory). |
| `--format <terminal\|json>` | Output format. Default is `terminal`. |
| `--strict` | Fail with exit code 1 if any warnings are detected. |
| `-h`, `--help` | Show help and usage information. |
| `-v`, `--version` | Show EnvSync CLI version. |

### Exit Codes

| Code | Status | Meaning |
|:---:|---|---|
| `0` | **Success** | Clean scan. In `--strict` mode, also guarantees zero warnings. |
| `1` | **Issues Found** | At least one error detected (or warnings under `--strict`). |
| `2` | **Execution Error** | Could not scan: invalid config syntax, missing directory, or unsafe symlinks. |

---

## Diagnostic Codes

EnvSync emits stable, standardized diagnostic codes:

| Code | Severity | Description |
|:---:|:---:|---|
| **`ENV001`** | `error` | A static `process.env` variable used in source code is not declared in `envsync.config.ts`. |
| **`ENV002`** | `error` | A `required: true` variable in the config is missing from `.env.example`. |
| **`ENV003`** | `warning` | A declared variable is never referenced in source code or `next.config.js`. |
| **`ENV004`** | `error` | Invalid or unsupported syntax encountered in `envsync.config.ts`. |
| **`ENV005`** | `error` / `warning` | Potential secret leakage: `secret: true` exposed with `NEXT_PUBLIC_` prefix, or client-exposed variable containing sensitive keywords. |
| **`ENV006`** | `info` | Dynamic environment access detected (e.g. `process.env[dynamicKey]`, spreads) which cannot be verified statically. |
| **`ENV007`** | `error` / `warning` | Duplicate variable definition in `envsync.config.ts` (error) or `.env.example` (warning). |

---

## CI / Automated Pipelines

Run EnvSync in GitHub Actions or any CI system with JSON or strict terminal output:

```yaml
name: Configuration Check
on: [push, pull_request]

jobs:
  envsync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with:
          version: 12
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: "pnpm"

      - run: pnpm install
      - run: pnpm build

      # Run strict check: fails if errors or warnings exist
      - name: Verify Environment Contract
        run: node apps/cli/dist/bin.js scan . --strict
```

---

## Repository Architecture

This repository is organized as a pnpm workspace:

- [`packages/schema`](file:///c:/ENVSync/packages/schema): Static `envsync.config.ts` AST parser, `.env.example` key extractor, and schema validation.
- [`packages/parser-next`](file:///c:/ENVSync/packages/parser-next): Next.js source AST reference extractor and `next.config.js` static parser.
- [`packages/core`](file:///c:/ENVSync/packages/core): Framework-agnostic discovery engine, scan pipeline, analyzers, and diagnostic generation.
- [`apps/cli`](file:///c:/ENVSync/apps/cli): CLI interface, terminal/JSON formatting, and exit code handling.
- [`tests`](file:///c:/ENVSync/tests): Integration test suites, privacy verification, and Next.js fixtures ([App Router](file:///c:/ENVSync/tests/fixtures/next-app-router), [Pages Router](file:///c:/ENVSync/tests/fixtures/next-pages-router)).

---

## License

[MIT](file:///c:/ENVSync/LICENSE)
