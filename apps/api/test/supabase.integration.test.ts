import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionChecker, createTokenVerifier } from "../src/auth.js";
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

type User = { id: string; token: string; email: string; password: string };

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
  return { id: String(created.id), token: String(session.access_token), email, password };
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
    app = buildApp({ verifyToken: createTokenVerifier(env("SUPABASE_URL")), checkSession: createSessionChecker(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY")), db });
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
    // Storage must match visibility, even for a direct write. Clearing the Vault reference is refused
    // by column permissions; writing plain text alongside it, by the storage check.
    expect(
      await code(() =>
        asUser(alice.id, (tx) => tx`update envsync.variable_values set plain_value = 'leak', vault_secret_id = null where id = ${secretValueId}`),
      ),
    ).toBe("42501");
    expect(await code(() => asUser(alice.id, (tx) => tx`update envsync.variable_values set plain_value = 'leak' where id = ${secretValueId}`))).toBe("23514");
    // Without a user, or as another user, RLS shows nothing.
    expect(await asUser(null, (tx) => tx`select id from envsync.projects`)).toHaveLength(0);
    expect(await asUser(bob.id, (tx) => tx`select id from envsync.variable_values`)).toHaveLength(0);
    expect(await asUser(bob.id, (tx) => tx`select id from envsync.audit_events where project_id = ${projectId}`)).toHaveLength(0);
    // Another user cannot write a protected value into the project either.
    const definitionId = (await owner`select id from envsync.variable_definitions where project_id = ${projectId} and name = 'SECRET_KEY'`)[0]?.id as string;
    const environmentId = (await owner`select id from envsync.environments where project_id = ${projectId} and name = 'production'`)[0]?.id as string;
    expect(await code(() => asUser(bob.id, (tx) => tx`select * from envsync_private.set_protected_value(${definitionId}, ${environmentId}, 'x', 'secret')`))).toBe("42501");
  }, 60_000);

  test("even with arbitrary SQL as the API role, a Secret cannot be re-pointed or copied to become revealable (review H1)", async () => {
    const rows = await owner`select v.id, v.vault_secret_id, d.name from envsync.variable_values v
      join envsync.variable_definitions d on d.id = v.definition_id where d.project_id = ${projectId}`;
    const secretRow = rows.find((row) => row.name === "SECRET_KEY") as { id: string; vault_secret_id: string };
    const [{ id: sensitiveDefinition }] = (await owner`select id from envsync.variable_definitions where project_id = ${projectId} and name = 'SENSITIVE_KEY'`) as unknown as [{ id: string }];
    const [{ id: previewEnvironment }] = (await owner`select id from envsync.environments where project_id = ${projectId} and name = 'preview'`) as unknown as [{ id: string }];
    const asAlice = (work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      apiRole.begin(async (tx) => {
        await tx`select set_config('envsync.user_id', ${alice.id}, true)`;
        return work(tx);
      });
    const code = async (work: () => Promise<unknown>) => work().then(() => "ok", (error: { code?: string }) => error.code);

    // A: move the Secret's row onto a Sensitive variable.
    expect(await code(() => asAlice((tx) => tx`update envsync.variable_values set definition_id = ${sensitiveDefinition} where id = ${secretRow.id}`))).toBe("42501");
    // B: a new Sensitive row pointing at the Secret's Vault entry.
    expect(
      await code(() =>
        asAlice((tx) => tx`insert into envsync.variable_values (definition_id, environment_id, vault_secret_id) values (${sensitiveDefinition}, ${previewEnvironment}, ${secretRow.vault_secret_id})`),
      ),
    ).toBe("42501");
    // Changing the reference on an existing row is refused too.
    expect(await code(() => asAlice((tx) => tx`update envsync.variable_values set vault_secret_id = gen_random_uuid() where id = ${secretRow.id}`))).toBe("42501");
  }, 60_000);

  test("an owner cannot hand over the workspace or change its kind; only renaming is allowed (review H2, L1)", async () => {
    const workspaceId = String((await call(alice, "GET", "/v1/me")).body?.personalWorkspaceId);
    const asAlice = (work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      apiRole.begin(async (tx) => {
        await tx`select set_config('envsync.user_id', ${alice.id}, true)`;
        return work(tx);
      });
    const code = async (work: () => Promise<unknown>) => work().then(() => "ok", (error: { code?: string }) => error.code);
    expect(await code(() => asAlice((tx) => tx`update envsync.workspaces set owner_id = ${bob.id} where id = ${workspaceId}`))).toBe("42501");
    expect(await code(() => asAlice((tx) => tx`update envsync.workspaces set kind = 'team' where id = ${workspaceId}`))).toBe("42501");
    expect(await code(() => asAlice((tx) => tx`update envsync.workspaces set name = 'Renamed' where id = ${workspaceId}`))).toBe("ok");
    expect(await code(() => asAlice((tx) => tx`insert into envsync.workspaces (kind, name, owner_id) values ('team', 'Mine', ${alice.id})`))).toBe("42501");
  }, 60_000);

  test("audit events cannot point at another workspace's project; attribution is always the signed-in user (review L2, L3)", async () => {
    const bobProject = String((await call(bob, "POST", "/v1/projects", { name: "Bob's" })).body?.id);
    const workspaceId = String((await call(alice, "GET", "/v1/me")).body?.personalWorkspaceId);
    const code = async (work: () => Promise<unknown>) => work().then(() => "ok", (error: { code?: string }) => error.code);
    expect(
      await code(() =>
        apiRole.begin(async (tx) => {
          await tx`select set_config('envsync.user_id', ${alice.id}, true)`;
          return tx`insert into envsync.audit_events (workspace_id, project_id, actor_id, action) values (${workspaceId}, ${bobProject}, ${alice.id}, 'fake')`;
        }),
      ),
    ).toBe("42501");
    await apiRole.begin(async (tx) => {
      await tx`select set_config('envsync.user_id', ${alice.id}, true)`;
      await tx`insert into envsync.variable_definitions (project_id, name, visibility, updated_by) values (${projectId}, 'FORGED_BY', 'plain', ${bob.id})`;
    });
    const [row] = await owner`select updated_by from envsync.variable_definitions where project_id = ${projectId} and name = 'FORGED_BY'`;
    expect(row?.updated_by).toBe(alice.id);
  }, 60_000);

  test("a signed-out session's token cannot reveal, even though it is still unexpired (review M4)", async () => {
    const second = await auth("/token?grant_type=password", { method: "POST", body: { email: alice.email, password: alice.password } });
    const token = String(second.access_token);
    await fetch(`${env("SUPABASE_URL").replace(/\/$/, "")}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: env("SUPABASE_ANON_KEY"), authorization: `Bearer ${token}` },
    });
    const revealed = await call({ ...alice, token }, "POST", `${base()}/environments/production/variables/SENSITIVE_KEY/value/reveal`);
    expect(revealed.status).toBe(401);
    // The user's other session is unaffected.
    expect((await call(alice, "POST", `${base()}/environments/production/variables/SENSITIVE_KEY/value/reveal`)).status).toBe(200);
  }, 60_000);

  test("a soft-deleted project's variables and values are unreachable, even directly (review L5)", async () => {
    const other = String((await call(alice, "POST", "/v1/projects", { name: "To delete" })).body?.id);
    expect((await call(alice, "PUT", `/v1/projects/${other}/variables/KEY_TO_HIDE`, { visibility: "secret" })).status).toBe(200);
    expect((await call(alice, "PUT", `/v1/projects/${other}/variables/SENS_TO_HIDE`, { visibility: "sensitive" })).status).toBe(200);
    expect((await call(alice, "PUT", `/v1/projects/${other}/environments/production/variables/SENS_TO_HIDE/value`, { value: "hidden" })).status).toBe(200);
    const [{ id: definitionId }] = (await owner`select id from envsync.variable_definitions where project_id = ${other} and name = 'KEY_TO_HIDE'`) as unknown as [{ id: string }];
    const [{ id: environmentId }] = (await owner`select id from envsync.environments where project_id = ${other} and name = 'production'`) as unknown as [{ id: string }];
    const [{ id: sensitiveValueId }] = (await owner`select v.id from envsync.variable_values v join envsync.variable_definitions d on d.id = v.definition_id
      where d.project_id = ${other} and d.name = 'SENS_TO_HIDE'`) as unknown as [{ id: string }];
    expect((await call(alice, "DELETE", `/v1/projects/${other}`)).status).toBe(204);
    const code = async (work: () => Promise<unknown>) => work().then(() => "ok", (error: { code?: string }) => error.code);
    const asAlice = (work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      apiRole.begin(async (tx) => {
        await tx`select set_config('envsync.user_id', ${alice.id}, true)`;
        return work(tx);
      });
    expect(await code(() => asAlice((tx) => tx`select * from envsync_private.set_protected_value(${definitionId}, ${environmentId}, 'x', 'secret')`))).toBe("42501");
    expect(await asAlice((tx) => tx`select id from envsync.variable_definitions where project_id = ${other}`)).toHaveLength(0);
    expect(await asAlice((tx) => tx`select id from envsync.environments where project_id = ${other}`)).toHaveLength(0);
    expect(await asAlice((tx) => tx`select id from envsync.variable_values where id = ${sensitiveValueId}`)).toHaveLength(0);
    expect(await code(() => asAlice((tx) => tx`insert into envsync.variable_definitions (project_id, name, visibility) values (${other}, 'NEW_IN_DELETED', 'plain')`))).toBe("42501");
    expect(await code(() => asAlice((tx) => tx`select envsync_private.reveal_sensitive_value(${sensitiveValueId})`))).toBe("42501");
  }, 60_000);

  test("the API role can execute exactly the allow-listed private functions (review M-A)", async () => {
    const rows = await owner`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'envsync_private' and has_function_privilege('envsync_api', p.oid, 'execute') order by 1`;
    expect(rows.map((row) => row.proname)).toEqual(["definition_workspace", "has_role", "project_workspace", "reveal_sensitive_value", "set_protected_value"]);
    // Nothing in the schema is executable by PUBLIC...
    const publicRows = await owner`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'envsync_private' and has_function_privilege('public', p.oid, 'execute')`;
    expect(publicRows).toEqual([]);
    // ...and functions the migration owner creates later are not either: the role-wide default for
    // functions exists and grants nothing to PUBLIC (grantee 0).
    const [defaults] = await owner`select count(*)::int as entries,
        count(*) filter (where exists (select 1 from aclexplode(d.defaclacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))::int as public_execute
      from pg_default_acl d where d.defaclrole = current_user::regrole and d.defaclobjtype = 'f' and d.defaclnamespace = 0`;
    expect(defaults).toEqual({ entries: 1, public_execute: 0 });
  }, 30_000);

  test("every EnvSync Vault entry is named after its variable and environment (review Low 1)", async () => {
    const [row] = await owner`select count(*)::int as unnamed from envsync.variable_values v join vault.secrets s on s.id = v.vault_secret_id
      where s.name is distinct from envsync_private.vault_name(v.definition_id, v.environment_id)`;
    expect(row?.unnamed).toBe(0);
  }, 30_000);

  test("a visibility change and a first value write racing each other cannot both succeed (review M1)", async () => {
    const code = async (work: () => Promise<unknown>) => work().then(() => "ok", (error: { code?: string }) => error.code);
    for (const order of ["visibility first", "value first"] as const) {
      const name = order === "visibility first" ? "RACE_A" : "RACE_B";
      expect((await call(alice, "PUT", `${base()}/variables/${name}`, { visibility: "secret" })).status).toBe(200);
      const [{ id: definitionId }] = (await owner`select id from envsync.variable_definitions where project_id = ${projectId} and name = ${name}`) as unknown as [{ id: string }];
      const [{ id: environmentId }] = (await owner`select id from envsync.environments where project_id = ${projectId} and name = 'development'`) as unknown as [{ id: string }];
      const second = postgres(env("ENVSYNC_API_DB_URL"), { ssl: "require", max: 1, prepare: false, onnotice: () => {} });
      try {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const asAlice = (sql: postgres.Sql, work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
          sql.begin(async (tx) => {
            await tx`select set_config('envsync.user_id', ${alice.id}, true)`;
            return work(tx);
          });
        const changeVisibility = (tx: postgres.TransactionSql) => tx`update envsync.variable_definitions set visibility = 'sensitive' where id = ${definitionId}`;
        const writeValue = (tx: postgres.TransactionSql) => tx`select * from envsync_private.set_protected_value(${definitionId}, ${environmentId}, 'race', 'secret')`;
        // The first transaction does its step and stays open; the second runs while it holds its locks.
        const [firstStep, secondStep] = order === "visibility first" ? [changeVisibility, writeValue] : [writeValue, changeVisibility];
        const first = code(() =>
          asAlice(apiRole, async (tx) => {
            await firstStep(tx);
            await held;
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        const secondResult = code(() => asAlice(second, secondStep));
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        release();
        const results = [await first, await secondResult];
        // Never both: the variable is either Secret with a value, or Sensitive without one.
        expect(results.filter((result) => result === "ok"), `${order}: ${results.join(", ")}`).toHaveLength(1);
        const [state] = await owner`select d.visibility, count(v.id)::int as values from envsync.variable_definitions d
          left join envsync.variable_values v on v.definition_id = d.id where d.id = ${definitionId} group by d.visibility`;
        expect(state?.visibility === "sensitive" && state.values > 0, `${order}: ${JSON.stringify(state)}`).toBe(false);
      } finally {
        await second.end({ timeout: 5 });
      }
    }
  }, 90_000);

  test("memberships, project ownership, variable placement and environments cannot be rewritten (review H2/L7)", async () => {
    const workspaceId = String((await call(alice, "GET", "/v1/me")).body?.personalWorkspaceId);
    const bobWorkspace = String((await call(bob, "GET", "/v1/me")).body?.personalWorkspaceId);
    const code = async (work: () => Promise<unknown>) => work().then(() => "ok", (error: { code?: string }) => error.code);
    const asAlice = (work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      apiRole.begin(async (tx) => {
        await tx`select set_config('envsync.user_id', ${alice.id}, true)`;
        return work(tx);
      });
    const attempts: [string, (tx: postgres.TransactionSql) => Promise<unknown>][] = [
      ["membership role", (tx) => tx`update envsync.memberships set role = 'viewer' where workspace_id = ${workspaceId}`],
      ["membership user", (tx) => tx`update envsync.memberships set user_id = ${bob.id} where workspace_id = ${workspaceId}`],
      ["membership delete", (tx) => tx`delete from envsync.memberships where workspace_id = ${workspaceId}`],
      ["project workspace", (tx) => tx`update envsync.projects set workspace_id = ${bobWorkspace} where id = ${projectId}`],
      ["project hard delete", (tx) => tx`delete from envsync.projects where id = ${projectId}`],
      ["definition project", (tx) => tx`update envsync.variable_definitions set project_id = ${projectId} where project_id = ${projectId}`],
      ["definition name", (tx) => tx`update envsync.variable_definitions set name = 'RENAMED' where project_id = ${projectId} and name = 'PLAIN_URL'`],
      ["environment name", (tx) => tx`update envsync.environments set name = 'preview' where project_id = ${projectId} and name = 'development'`],
      [
        "workspace owner via upsert",
        (tx) => tx`insert into envsync.workspaces (kind, name, owner_id) values ('personal', 'X', ${alice.id})
          on conflict (owner_id) where kind = 'personal' do update set owner_id = ${bob.id}`,
      ],
    ];
    for (const [label, attempt] of attempts) expect(await code(() => asAlice(attempt)), label).toBe("42501");
  }, 60_000);

  test("attribution is stamped on projects and values too, including through upserts (review L3)", async () => {
    await apiRole.begin(async (tx) => {
      await tx`select set_config('envsync.user_id', ${alice.id}, true)`;
      const workspaceId = String((await tx`select id from envsync.workspaces where owner_id = ${alice.id}`)[0]?.id);
      await tx`insert into envsync.projects (workspace_id, name, created_by) values (${workspaceId}, 'Attribution', ${bob.id})`;
    });
    const [project] = await owner`select created_by from envsync.projects where name = 'Attribution' and workspace_id in (select id from envsync.workspaces where owner_id = ${alice.id})`;
    expect(project?.created_by).toBe(alice.id);
    expect((await call(alice, "PUT", `${base()}/environments/preview/variables/PLAIN_URL/value`, { value: "https://a.example" })).status).toBe(200);
    await apiRole.begin(async (tx) => {
      await tx`select set_config('envsync.user_id', ${alice.id}, true)`;
      await tx`update envsync.variable_values set plain_value = 'https://b.example', updated_by = ${bob.id}
        where definition_id = (select id from envsync.variable_definitions where project_id = ${projectId} and name = 'PLAIN_URL')
          and environment_id = (select id from envsync.environments where project_id = ${projectId} and name = 'preview')`;
    });
    const [value] = await owner`select v.updated_by from envsync.variable_values v join envsync.environments e on e.id = v.environment_id
      join envsync.variable_definitions d on d.id = v.definition_id where d.project_id = ${projectId} and d.name = 'PLAIN_URL' and e.name = 'preview'`;
    expect(value?.updated_by).toBe(alice.id);
  }, 60_000);

  test("visibility cannot change while values exist", async () => {
    expect((await call(alice, "PUT", `${base()}/variables/SECRET_KEY`, { visibility: "plain" })).status).toBe(409);
  }, 30_000);

  test("deleting values and users removes their Vault entries", async () => {
    const vaultIds = (await owner`select v.vault_secret_id from envsync.variable_values v join envsync.variable_definitions d on d.id = v.definition_id
      where d.project_id = ${projectId} and v.vault_secret_id is not null`).map((row) => row.vault_secret_id as string);
    expect(vaultIds.length).toBeGreaterThanOrEqual(2);
    expect((await call(alice, "DELETE", `${base()}/environments/production/variables/SENSITIVE_KEY/value`)).status).toBe(204);
    // Deleting the user cascades to the workspace, project, values and their Vault entries.
    await auth(`/admin/users/${alice.id}`, { method: "DELETE", admin: true });
    const remaining = await owner`select count(*)::int as count from vault.secrets where id = any(${vaultIds}::uuid[])`;
    expect(remaining[0]?.count).toBe(0);
  }, 60_000);

  test("no response body contained a secret value; the sensitive value appeared only in reveal responses", () => {
    expect(responses.join("\n")).not.toContain(FAKE_SECRET);
    const withSensitive = responses.filter((body) => body.includes(FAKE_SENSITIVE));
    expect(withSensitive.length).toBeGreaterThan(0);
    for (const body of withSensitive) expect(JSON.parse(body)).toEqual({ name: "SENSITIVE_KEY", environment: "production", value: FAKE_SENSITIVE });
  });
});
