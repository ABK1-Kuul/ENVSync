// Applies apps/api/migrations/*.sql in order, each in its own transaction, as the database owner
// (SUPABASE_DB_URL). Applied migrations are recorded with a SHA-256 of their text; a recorded
// migration whose file has since changed stops the run (never edit an applied migration; add one).
// Usage: node scripts/migrate.mjs [--dry-run]
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { loadLocalEnv, requireEnv } from "./env.mjs";

const dryRun = process.argv.includes("--dry-run");
const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

loadLocalEnv();
const { SUPABASE_DB_URL } = requireEnv("SUPABASE_DB_URL");
const sql = postgres(SUPABASE_DB_URL, { ssl: "require", max: 1, connect_timeout: 15, onnotice: () => {} });

try {
  await sql`create schema if not exists envsync_meta`;
  await sql`create table if not exists envsync_meta.migrations (
    name text primary key, sha256 text not null, applied_at timestamptz not null default now())`;
  await sql`revoke all on schema envsync_meta from public`;

  const applied = new Map((await sql`select name, sha256 from envsync_meta.migrations`).map((row) => [row.name, row.sha256]));
  const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();

  for (const name of files) {
    const text = await readFile(path.join(migrationsDir, name), "utf8");
    const sha256 = createHash("sha256").update(text).digest("hex");
    if (applied.has(name)) {
      if (applied.get(name) !== sha256) throw new Error(`${name} was changed after it was applied. Revert it and add a new migration instead.`);
      console.log(`already applied  ${name}`);
      continue;
    }
    if (dryRun) {
      console.log(`would apply      ${name}`);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into envsync_meta.migrations (name, sha256) values (${name}, ${sha256})`;
    });
    console.log(`applied          ${name}`);
  }
} catch (error) {
  // Database errors are reported by code and message (they describe SQL, not connection secrets).
  console.log(`migration failed: ${error?.code ? `${error.code} ` : ""}${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
