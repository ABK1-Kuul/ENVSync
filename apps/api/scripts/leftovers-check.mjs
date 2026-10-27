// Counts what the integration tests could leave behind in the development project: test users,
// EnvSync rows and Vault entries created for EnvSync values. Prints counts only.
import postgres from "postgres";
import { loadLocalEnv, requireEnv } from "./env.mjs";

loadLocalEnv();
const { SUPABASE_DB_URL } = requireEnv("SUPABASE_DB_URL");
const sql = postgres(SUPABASE_DB_URL, { ssl: "require", max: 1, onnotice: () => {} });
try {
  const [counts] = await sql`select
    (select count(*)::int from auth.users where email like 'envsync-test-%@example.com') as test_users,
    (select count(*)::int from envsync.workspaces) as workspaces,
    (select count(*)::int from envsync.projects) as projects,
    (select count(*)::int from envsync.variable_values) as values,
    (select count(*)::int from vault.secrets where description = 'envsync value') as vault_entries`;
  for (const [name, count] of Object.entries(counts)) console.log(`${name.padEnd(14)} ${count}`);
} finally {
  await sql.end({ timeout: 5 });
}
