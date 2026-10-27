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

/**
 * Removes connection details (hosts, user names, passwords from the configured database URLs) from
 * text that is about to be printed, such as a driver error message.
 */
export function redact(text) {
  let result = String(text);
  for (const name of ["SUPABASE_DB_URL", "ENVSYNC_API_DB_URL", "SUPABASE_URL"]) {
    const value = process.env[name];
    if (!value) continue;
    try {
      const url = new URL(value);
      for (const part of [url.password, decodeURIComponent(url.password), url.username, url.hostname]) {
        if (part && part.length >= 3) result = result.split(part).join("[redacted]");
      }
    } catch {
      // not a URL: nothing to remove
    }
  }
  return result;
}

/** Throws (naming the variable, never its value) if any is missing or empty. */
export function requireEnv(...names) {
  const missing = names.filter((name) => (process.env[name] ?? "").trim() === "");
  if (missing.length > 0) throw new Error(`Missing in .env.local: ${missing.join(", ")}`);
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}
