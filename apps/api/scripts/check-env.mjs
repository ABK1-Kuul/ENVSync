// Reports which Supabase settings are present in .env.local, and what kind of database connection
// string is configured. Prints no values.
import { loadLocalEnv } from "./env.mjs";

loadLocalEnv();
const names = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL", "ENVSYNC_API_DB_URL"];
for (const name of names) console.log(`${name.padEnd(26)} ${(process.env[name] ?? "").trim() === "" ? "not set" : "set"}`);

const describe = (value) => {
  try {
    const url = new URL(value);
    const kind = url.hostname.endsWith(".pooler.supabase.com") ? "Supabase pooler" : url.hostname.startsWith("db.") ? "direct database host" : "other host";
    return `${url.protocol.replace(":", "")} URL, ${kind}, port ${url.port || "default"}`;
  } catch {
    return "not a valid URL";
  }
};
for (const name of ["SUPABASE_DB_URL", "ENVSYNC_API_DB_URL"]) {
  if ((process.env[name] ?? "") !== "") console.log(`${name.padEnd(26)} ${describe(process.env[name])}`);
}
if ((process.env.SUPABASE_URL ?? "") !== "") {
  try {
    const url = new URL(process.env.SUPABASE_URL);
    console.log(`${"SUPABASE_URL".padEnd(26)} ${url.protocol === "https:" && url.hostname.endsWith(".supabase.co") ? "https, supabase.co host" : "unexpected form"}`);
  } catch {
    console.log(`${"SUPABASE_URL".padEnd(26)} not a valid URL`);
  }
}
