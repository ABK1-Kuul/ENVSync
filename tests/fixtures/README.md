# Scanner fixtures

Minimal Next.js projects used by `tests/integration` and `tests/security`. They are never executed.

- `next-app-router/` — healthy project; a scan must report no diagnostics.
- `next-pages-router/` — project with drift: undeclared, missing-from-example, unused, dynamic,
  client-exposed and duplicate cases, each at a known location.
- `broken-config/` — config with unsupported syntax and top-level side effects; proves the config
  is parsed, not executed.

## Conventions
- `env.example.fixture` holds the fixture's `.env.example` content. `tests/helpers.ts` copies each
  fixture into a temp directory and writes it there as `.env.example`, so no dotenv files are
  committed and agent tooling that blocks `.env*` paths can still maintain fixtures.
- Real `.env`/`.env.local` files, `node_modules`, and symlinks are created at test time only, with
  obviously fake values.
- Fixture TypeScript is excluded from the repository typecheck; it only needs to parse.
