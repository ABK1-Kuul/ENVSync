// Connects with SUPABASE_DB_URL (or ENVSYNC_API_DB_URL with --api) and reports the server version,
// the connected role and whether Supabase Vault is available. Prints no connection details.
import postgres from "postgres";
import { loadLocalEnv, requireEnv } from "./env.mjs";

loadLocalEnv();
const name = process.argv.includes("--api") ? "ENVSYNC_API_DB_URL" : "SUPABASE_DB_URL";
const { [name]: url } = requireEnv(name);
const sql = postgres(url, { ssl: "require", max: 1, connect_timeout: 15, idle_timeout: 5, onnotice: () => {} });
try {
  const [info] = await sql`select current_user as role, split_part(version(), ' ', 2) as version,
    exists (select 1 from pg_extension where extname = 'supabase_vault') as vault`;
  console.log(`connected via ${name}: role ${info.role}, Postgres ${info.version}, Vault ${info.vault ? "installed" : "not installed"}`);
} catch (error) {
  // Driver errors can include the host; print only the error code and a generic hint.
  console.log(`connection failed (${error?.code ?? "unknown error"}). If the code is ENETUNREACH or ENOTFOUND, the direct host may be IPv6-only: use the Session pooler connection string from Supabase instead.`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
