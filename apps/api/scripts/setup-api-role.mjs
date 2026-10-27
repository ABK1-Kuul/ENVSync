// Gives the API's database role (envsync_api, created by the migrations) a login with a new random
// password, and writes its connection string to .env.local as ENVSYNC_API_DB_URL. The password is
// never printed, and only its SCRAM-SHA-256 verifier is sent to the database, so statement logs
// cannot contain it. Running the script again rotates the password.
// The connection string reuses SUPABASE_DB_URL's host and port. With Supabase's pooler, the user name
// carries the project reference (envsync_api.<ref>), taken from SUPABASE_DB_URL's user name.
import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import postgres from "postgres";
import { ENV_FILE, loadLocalEnv, redact, requireEnv } from "./env.mjs";
import { scramVerifier } from "./scram.mjs";

loadLocalEnv();
const { SUPABASE_DB_URL } = requireEnv("SUPABASE_DB_URL");
const ownerUrl = new URL(SUPABASE_DB_URL);
const password = randomBytes(24).toString("base64url");
const reference = ownerUrl.username.includes(".") ? ownerUrl.username.slice(ownerUrl.username.indexOf(".")) : "";

const sql = postgres(SUPABASE_DB_URL, { ssl: "require", max: 1, connect_timeout: 15, onnotice: () => {} });
let ok = false;
try {
  // ALTER ROLE cannot take a bind parameter; the verifier is base64 and `$`-separated, never a quote.
  await sql.unsafe(`alter role envsync_api with login password '${scramVerifier(password)}' connection limit 20`);
  ok = true;
} catch (error) {
  console.log(`could not set up the API role: ${error?.code ?? ""} ${redact(error?.message ?? String(error))}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

if (ok) {
  const apiUrl = new URL(SUPABASE_DB_URL);
  apiUrl.username = `envsync_api${reference}`;
  apiUrl.password = password;
  const line = `ENVSYNC_API_DB_URL=${apiUrl.toString()}`;
  const text = await readFile(ENV_FILE, "utf8");
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((existing) => existing.startsWith("ENVSYNC_API_DB_URL="));
  if (index >= 0) lines[index] = line;
  else lines.splice(text.endsWith("\n") ? lines.length - 1 : lines.length, 0, line);
  // Write a temporary file and rename it over .env.local, so a crash never leaves it half-written.
  const temporary = `${ENV_FILE}.tmp-${process.pid}`;
  await writeFile(temporary, lines.join(text.includes("\r\n") ? "\r\n" : "\n"), { mode: 0o600 });
  await rename(temporary, ENV_FILE);
  console.log(`API role ready; ENVSYNC_API_DB_URL ${index >= 0 ? "updated" : "added"} in .env.local (password not shown).`);
  if (index >= 0) console.log("Supabase's pooler may accept the new password only after a short delay (under a minute).");
}
