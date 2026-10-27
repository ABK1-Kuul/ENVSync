import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { createTokenVerifier } from "../src/auth.js";
import { createDatabase, type Database } from "../src/db.js";

/**
 * Phase 4 exit-gate tests against the real Supabase development project (never production).
 * Opt-in: ENVSYNC_API_INTEGRATION=1 and a .env.local with the Supabase settings and
 * ENVSYNC_API_DB_URL (see apps/api/README.md). Creates two throwaway users and deletes them after.
 */

const envFile = path.resolve(fileURLToPath(new URL("../../../.env.local", import.meta.url)));
const enabled = process.env.ENVSYNC_API_INTEGRATION === "1" && existsSync(envFile);
if (enabled) process.loadEnvFile(envFile);

const env = (name: string) => process.env[name] ?? "";
const FAKE_SECRET = `ENVSYNC_FAKE_SECRET_${randomBytes(6).toString("hex")}`;
const FAKE_SENSITIVE = `ENVSYNC_FAKE_SENSITIVE_${randomBytes(6).toString("hex")}`;

type User = { id: string; token: string };

async function auth(pathname: string, init: { method: string; body?: unknown; admin?: boolean }) {
  const key = init.admin ? env("SUPABASE_SERVICE_ROLE_KEY") : env("SUPABASE_ANON_KEY");
  const headers: Record<string, string> = { apikey: key, "content-type": "application/json" };
  // Legacy keys are JWTs and also go in Authorization; new-style keys (sb_...) use apikey only.
  if (key.split(".").length === 3) headers.authorization = `Bearer ${key}`;
  const response = await fetch(`${env("SUPABASE_URL").replace(/\/$/, "")}/auth/v1${pathname}`, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) throw new Error(`auth ${init.method} ${pathname.split("?")[0]} failed: HTTP ${response.status}`);
  return response.status === 204 ? {} : ((await response.json()) as Record<string, unknown>);
}

async function createUser(): Promise<User> {
  const email = `envsync-test-${randomUUID()}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const created = await auth("/admin/users", { method: "POST", admin: true, body: { email, password, email_confirm: true } });
  const session = await auth("/token?grant_type=password", { method: "POST", body: { email, password } });
  return { id: String(created.id), token: String(session.access_token) };
}

describe.skipIf(!enabled)("Supabase integration (Phase 4 exit gate)", () => {
  let db: Database;
  let owner: postgres.Sql;
  let apiRole: postgres.Sql;
  let alice: User;
  let bob: User;
  const responses: string[] = [];
  let app: ReturnType<typeof buildApp>;

  async function call(user: User | undefined, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) {
    const response = await app.inject({
      method,
      url,
      headers: user === undefined ? {} : { authorization: `Bearer ${user.token}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    responses.push(response.body);
    return { status: response.statusCode, body: response.body === "" ? undefined : (response.json() as Record<string, unknown>) };
  }

  beforeAll(async () => {
    db = createDatabase(env("ENVSYNC_API_DB_URL"));
    app = buildApp({ verifyToken: createTokenVerifier(env("SUPABASE_URL")), db });
    owner = postgres(env("SUPABASE_DB_URL"), { ssl: "require", max: 1, onnotice: () => {} });
    apiRole = postgres(env("ENVSYNC_API_DB_URL"), { ssl: "require", max: 1, prepare: false, onnotice: () => {} });
    alice = await createUser();
    bob = await createUser();
  }, 60_000);

  afterAll(async () => {
    for (const user of [alice, bob]) if (user) await auth(`/admin/users/${user.id}`, { method: "DELETE", admin: true }).catch(() => undefined);
    await db?.close();
    await apiRole?.end({ timeout: 5 });
    await owner?.end({ timeout: 5 });
  }, 60_000);

  let projectId = "";
  const base = () => `/v1/projects/${projectId}`;

  test("a user gets a personal workspace and can create a project with three environments", async () => {
    const me = await call(alice, "GET", "/v1/me");
    expect(me.status).toBe(200);
    expect(me.body?.userId).toBe(alice.id);
    const created = await call(alice, "POST", "/v1/projects", { name: "Integration test" });
    expect(created.status).toBe(201);
    projectId = String(created.body?.id);
    const project = await call(alice, "GET", base());
    expect(project.body?.environments).toEqual(["development", "preview", "production"]);
  }, 30_000);

  test("plain, sensitive and secret values are stored; responses never contain protected values", async () => {
    for (const [name, visibility] of [["PLAIN_URL", "plain"], ["SENSITIVE_KEY", "sensitive"], ["SECRET_KEY", "secret"]] as const) {
      expect((await call(alice, "PUT", `${base()}/variables/${name}`, { visibility })).status).toBe(200);
    }
    expect((await call(alice, "PUT", `${base()}/environments/production/variables/PLAIN_URL/value`, { value: "https://plain.example" })).status).toBe(200);
    expect((await call(alice, "PUT", `${base()}/environments/production/variables/SENSITIVE_KEY/value`, { value: FAKE_SENSITIVE })).status).toBe(200);
    const secretWrite = await call(alice, "PUT", `${base()}/environments/production/variables/SECRET_KEY/value`, { value: FAKE_SECRET });
    expect(secretWrite).toMatchObject({ status: 200, body: { set: true, revision: 1 } });
    // Overwriting a secret works and bumps the revision, still without returning it.
    expect((await call(alice, "PUT", `${base()}/environments/production/variables/SECRET_KEY/value`, { value: `${FAKE_SECRET}_2` })).body).toMatchObject({ revision: 2 });

    const project = await call(alice, "GET", base());
    const variables = project.body?.variables as { name: string; values: Record<string, Record<string, unknown>> }[];
    const byName = Object.fromEntries(variables.map((variable) => [variable.name, variable.values.production]));
    expect(byName.PLAIN_URL).toMatchObject({ set: true, value: "https://plain.example" });
    expect(byName.SENSITIVE_KEY).toEqual({ set: true, revision: 1, updatedAt: expect.any(String) });
    expect(byName.SECRET_KEY).toEqual({ set: true, revision: 2, updatedAt: expect.any(String) });
  }, 30_000);

  test("secret values are write-only; sensitive values are revealed only on request, and audited", async () => {
    const secret = await call(alice, "POST", `${base()}/environments/production/variables/SECRET_KEY/value/reveal`);
    expect(secret).toEqual({ status: 403, body: { error: "write_only", message: "Secret values are write-only and cannot be revealed." } });
    const sensitive = await call(alice, "POST", `${base()}/environments/production/variables/SENSITIVE_KEY/value/reveal`);
    expect(sensitive).toMatchObject({ status: 200, body: { value: FAKE_SENSITIVE } });
    const audit = await call(alice, "GET", `${base()}/audit`);
    const actions = (audit.body?.events as { action: string; target: string }[]).map((event) => `${event.action}:${event.target ?? ""}`);
    expect(actions).toContain("value.revealed:production/SENSITIVE_KEY");
    expect(audit.body ? JSON.stringify(audit.body) : "").not.toMatch(/ENVSYNC_FAKE_/);
  }, 30_000);

  test("another user cannot see or change anything in the project (every route answers 404)", async () => {
    const list = await call(bob, "GET", "/v1/projects");
    expect((list.body?.projects as { id: string }[]).map((project) => project.id)).not.toContain(projectId);
    const attempts = [
      ["GET", base()],
      ["GET", `${base()}/audit`],
      ["PUT", `${base()}/variables/BOB_WAS_HERE`, { visibility: "plain" }],
      ["DELETE", `${base()}/variables/PLAIN_URL`],
      ["PUT", `${base()}/environments/production/variables/PLAIN_URL/value`, { value: "overwritten" }],
      ["DELETE", `${base()}/environments/production/variables/PLAIN_URL/value`],
      ["POST", `${base()}/environments/production/variables/SENSITIVE_KEY/value/reveal`],
      ["DELETE", base()],
    ] as const;
    for (const [method, url, payload] of attempts) {
      expect((await call(bob, method, url, payload)).status, `${method} ${url}`).toBe(404);
    }
    // Nothing changed for the owner.
    const project = await call(alice, "GET", base());
    const plain = (project.body?.variables as { name: string; values: Record<string, Record<string, unknown>> }[]).find((v) => v.name === "PLAIN_URL");
    expect(plain?.values.production).toMatchObject({ value: "https://plain.example" });
  }, 60_000);

  test("the API's database role cannot decrypt secrets, bypass RLS or store a secret as text", async () => {
    const secretValueId = (await owner`select v.id from envsync.variable_values v join envsync.variable_definitions d on d.id = v.definition_id
      where d.project_id = ${projectId} and d.name = 'SECRET_KEY'`)[0]?.id as string;
    const asUser = (userId: string | null, work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      apiRole.begin(async (tx) => {
        if (userId !== null) await tx`select set_config('envsync.user_id', ${userId}, true)`;
        return work(tx);
      });
    const code = async (work: () => Promise<unknown>) => work().then(() => "ok", (error: { code?: string }) => error.code);

    // Even the owner of the project cannot decrypt a Secret through the database.
    expect(await code(() => asUser(alice.id, (tx) => tx`select envsync_private.reveal_sensitive_value(${secretValueId})`))).toBe("42501");
    expect(await code(() => asUser(alice.id, (tx) => tx`select decrypted_secret from vault.decrypted_secrets limit 1`))).toBe("42501");
    expect(await code(() => asUser(alice.id, (tx) => tx`select secret from vault.secrets limit 1`))).toBe("42501");
    // Storage must match visibility, even for a direct write.
    expect(
      await code(() =>
        asUser(alice.id, (tx) => tx`update envsync.variable_values set plain_value = 'leak', vault_secret_id = null where id = ${secretValueId}`),
      ),
    ).toBe("23514");
    // Without a user, or as another user, RLS shows nothing.
    expect(await asUser(null, (tx) => tx`select id from envsync.projects`)).toHaveLength(0);
    expect(await asUser(bob.id, (tx) => tx`select id from envsync.variable_values`)).toHaveLength(0);
    expect(await asUser(bob.id, (tx) => tx`select id from envsync.audit_events where project_id = ${projectId}`)).toHaveLength(0);
    // Another user cannot write a protected value into the project either.
    const definitionId = (await owner`select id from envsync.variable_definitions where project_id = ${projectId} and name = 'SECRET_KEY'`)[0]?.id as string;
    const environmentId = (await owner`select id from envsync.environments where project_id = ${projectId} and name = 'production'`)[0]?.id as string;
    expect(await code(() => asUser(bob.id, (tx) => tx`select * from envsync_private.set_protected_value(${definitionId}, ${environmentId}, 'x')`))).toBe("42501");
  }, 60_000);

  test("visibility cannot change while values exist", async () => {
    expect((await call(alice, "PUT", `${base()}/variables/SECRET_KEY`, { visibility: "plain" })).status).toBe(409);
  }, 30_000);

  test("deleting values and users removes their Vault entries", async () => {
    const vaultIds = (await owner`select v.vault_secret_id from envsync.variable_values v join envsync.variable_definitions d on d.id = v.definition_id
      where d.project_id = ${projectId} and v.vault_secret_id is not null`).map((row) => row.vault_secret_id as string);
    expect(vaultIds).toHaveLength(2);
    expect((await call(alice, "DELETE", `${base()}/environments/production/variables/SENSITIVE_KEY/value`)).status).toBe(204);
    // Deleting the user cascades to the workspace, project, values and their Vault entries.
    await auth(`/admin/users/${alice.id}`, { method: "DELETE", admin: true });
    const remaining = await owner`select count(*)::int as count from vault.secrets where id = any(${vaultIds}::uuid[])`;
    expect(remaining[0]?.count).toBe(0);
  }, 60_000);

  test("no response body contained a secret value", () => {
    expect(responses.join("\n")).not.toContain(FAKE_SECRET);
  });
});
