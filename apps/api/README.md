# EnvSync cloud API (in development)

The API behind EnvSync's cloud workspace: Supabase Auth sign-in, projects with Development,
Preview and Production environments, variable definitions, and values. Values marked Secret can be
written but never read back. Sensitive values can be revealed only by an explicit request, which is
recorded in the audit log.

## Setup (development project only)

1. In `.env.local` at the repository root (gitignored; never commit it), set:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`;
   - `SUPABASE_DB_URL`: the **Session pooler** connection string (Supabase dashboard → *Connect*). The
     direct database host is IPv6-only on recent projects, and many networks cannot reach it.
2. Check the settings. This prints whether each one is set and what kind of connection string it
   holds, never the values:
   ```
   node apps/api/scripts/check-env.mjs
   node apps/api/scripts/db-check.mjs
   node apps/api/scripts/auth-check.mjs
   ```
3. Create the schema: `node apps/api/scripts/migrate.mjs` (add `--dry-run` to see what would run).
4. Give the API its own least-privilege database login:
   `node apps/api/scripts/setup-api-role.mjs`. It writes `ENVSYNC_API_DB_URL` to `.env.local`
   without printing it. Run it again to rotate the password.
5. Run the API locally (listens on `127.0.0.1:8787`):
   ```
   node apps/api/scripts/bundle.mjs
   node --env-file=.env.local apps/api/dist/server.mjs
   ```

## Tests

- `pnpm test` runs the unit tests (no network): token verification and request validation.
- The exit-gate tests run against the development project and are opt-in. They create and delete
  two throwaway users:
  `ENVSYNC_API_INTEGRATION=1 pnpm exec vitest run apps/api/test/supabase.integration.test.ts`

## Security model

- The API connects as `envsync_api`, never as `postgres`. Tables live in the `envsync` schema,
  which Supabase's Data API does not expose; browser roles have no access.
- Every query runs as the signed-in user under Row Level Security. Another user's project is
  answered with 404.
- Sensitive and Secret values are stored in Supabase Vault through private database functions. The
  API's role cannot read Vault, and no function decrypts a Secret.
- Responses, errors and audit events never contain Secret values. Errors never echo the request.
- Even with arbitrary SQL as `envsync_api`, the database refuses to:
  - decrypt a Secret;
  - move or copy a value's Vault reference;
  - hand over a workspace;
  - reach a deleted project's data.

  Column permissions, triggers and Vault entry names that tie each entry to its variable enforce
  this. The tests try each attack.
- Limit (by design, for now): the database trusts the API to say *which* user it acts for
  (`envsync.user_id`). A compromised API process could act as any user, but still could not
  decrypt Secrets. Revealing a Sensitive value also requires a live Supabase session.
- Production will use a separate Supabase project and an external key service (ADR-018/019).
