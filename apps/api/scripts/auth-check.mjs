// Checks that Supabase Auth is reachable and which token-signing keys it publishes (the API verifies
// sign-in tokens against them). Prints status codes and key algorithms only.
import { loadLocalEnv, requireEnv } from "./env.mjs";

loadLocalEnv();
const { SUPABASE_URL, SUPABASE_ANON_KEY } = requireEnv("SUPABASE_URL", "SUPABASE_ANON_KEY");
const base = SUPABASE_URL.replace(/\/$/, "");

const health = await fetch(`${base}/auth/v1/health`, { headers: { apikey: SUPABASE_ANON_KEY } });
console.log(`auth health: HTTP ${health.status}`);

const jwks = await fetch(`${base}/auth/v1/.well-known/jwks.json`);
if (!jwks.ok) {
  console.log(`signing keys: HTTP ${jwks.status} (none published)`);
} else {
  const { keys = [] } = await jwks.json();
  console.log(`signing keys: ${keys.length === 0 ? "none (project uses the legacy shared JWT secret)" : keys.map((key) => `${key.alg ?? key.kty}`).join(", ")}`);
}
