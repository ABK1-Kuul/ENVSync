// Loads the repository's .env.local into process.env for the API's scripts. Values are never
// printed: callers report only whether a name is set. Keep .env.local gitignored.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export const ENV_FILE = path.join(REPO_ROOT, ".env.local");

export function loadLocalEnv() {
  if (!existsSync(ENV_FILE)) throw new Error(`${ENV_FILE} not found. Create it with the Supabase settings (see apps/api/README.md).`);
  process.loadEnvFile(ENV_FILE);
}

/** Throws (naming the variable, never its value) if any is missing or empty. */
export function requireEnv(...names) {
  const missing = names.filter((name) => (process.env[name] ?? "").trim() === "");
  if (missing.length > 0) throw new Error(`Missing in .env.local: ${missing.join(", ")}`);
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}
