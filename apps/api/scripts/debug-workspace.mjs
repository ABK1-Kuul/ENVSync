// Diagnostic: runs the personal-workspace steps as the API role for a random (nonexistent) user and
// reports which statement fails, with the database error code and message. Rolls back; prints no secrets.
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { loadLocalEnv, requireEnv } from "./env.mjs";

loadLocalEnv();
const { ENVSYNC_API_DB_URL } = requireEnv("ENVSYNC_API_DB_URL");
const sql = postgres(ENVSYNC_API_DB_URL, { ssl: "require", max: 1, prepare: false, onnotice: () => {} });
const userId = randomUUID();
const steps = [
  ["current_user_id()", (tx) => tx`select envsync.current_user_id() as id`],
  ["select workspaces", (tx) => tx`select id from envsync.workspaces`],
  ["insert workspace", (tx) => tx`insert into envsync.workspaces (kind, name, owner_id) values ('personal', 'Personal', ${userId})`],
  ["insert workspace on conflict", (tx) => tx`insert into envsync.workspaces (kind, name, owner_id) values ('personal', 'Personal', ${userId}) on conflict (owner_id) where kind = 'personal' do nothing`],
];
for (const [label, run] of steps) {
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('envsync.user_id', ${userId}, true)`;
      await run(tx);
      throw Object.assign(new Error("rollback"), { code: "OK" });
    });
  } catch (error) {
    console.log(`${label.padEnd(30)} ${error.code === "OK" ? "ok" : `${error.code} ${error.message}`}`);
  }
}
await sql.end({ timeout: 5 });
