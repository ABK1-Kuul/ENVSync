import { buildApp } from "./app.js";
import { createSessionChecker, createTokenVerifier } from "./auth.js";
import { createDatabase } from "./db.js";

/**
 * Starts the API. Configuration comes from the environment (in development, from .env.local via
 * `node --env-file`): SUPABASE_URL, SUPABASE_ANON_KEY and ENVSYNC_API_DB_URL (the least-privilege role; never the
 * postgres owner). Listens on localhost only unless HOST is set.
 */
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const anonKey = process.env.SUPABASE_ANON_KEY ?? "";
const databaseUrl = process.env.ENVSYNC_API_DB_URL ?? "";
if (supabaseUrl === "" || anonKey === "" || databaseUrl === "") {
  console.error("Set SUPABASE_URL, SUPABASE_ANON_KEY and ENVSYNC_API_DB_URL (run the setup-role script first).");
  process.exit(1);
}

const db = createDatabase(databaseUrl);
const app = buildApp({ verifyToken: createTokenVerifier(supabaseUrl), checkSession: createSessionChecker(supabaseUrl, anonKey), db });
const port = Number(process.env.PORT ?? 8787);
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port });
console.log(`EnvSync API listening on port ${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => db.close());
  });
}
