// Gives the API's database role (envsync_api, created by the migrations) a login with a new random
// password, and writes its connection string to .env.local as ENVSYNC_API_DB_URL. The password is
// never printed. Running it again rotates the password.
// The connection string reuses SUPABASE_DB_URL's host and port. With Supabase's pooler, the user name
// carries the project reference (envsync_api.<ref>), taken from SUPABASE_DB_URL's user name.
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import postgres from "postgres";
import { ENV_FILE, loadLocalEnv, requireEnv } from "./env.mjs";

loadLocalEnv();
const { SUPABASE_DB_URL } = requireEnv("SUPABASE_DB_URL");
const ownerUrl = new URL(SUPABASE_DB_URL);
const password = randomBytes(24).toString("base64url");
const reference = ownerUrl.username.includes(".") ? ownerUrl.username.slice(ownerUrl.username.indexOf(".")) : "";

const sql = postgres(SUPABASE_DB_URL, { ssl: "require", max: 1, connect_timeout: 15, onnotice: () => {} });
try {
  // ALTER ROLE cannot take a bind parameter; the password is base64url, so it cannot break quoting.
  await sql.unsafe(`alter role envsync_api with login password '${password}' connection limit 20`);
} catch (error) {
  console.log(`could not set up the API role: ${error?.code ?? ""} ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

if (process.exitCode !== 1) {
  const apiUrl = new URL(SUPABASE_DB_URL);
  apiUrl.username = `envsync_api${reference}`;
  apiUrl.password = password;
  const line = `ENVSYNC_API_DB_URL=${apiUrl.toString()}`;
  const text = await readFile(ENV_FILE, "utf8");
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((existing) => existing.startsWith("ENVSYNC_API_DB_URL="));
  if (index >= 0) lines[index] = line;
  else lines.splice(text.endsWith("\n") ? lines.length - 1 : lines.length, 0, line);
  await writeFile(ENV_FILE, lines.join(text.includes("\r\n") ? "\r\n" : "\n"));
  console.log(`API role ready; ENVSYNC_API_DB_URL ${index >= 0 ? "updated" : "added"} in .env.local (password not shown).`);
}
