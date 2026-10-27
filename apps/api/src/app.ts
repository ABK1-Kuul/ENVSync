import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { bearerToken, type SessionChecker, type TokenVerifier } from "./auth.js";
import type { Database, Tx } from "./db.js";

/**
 * EnvSync cloud API, v1 (Phase 4: personal workspaces).
 *
 * Rules every route follows:
 * - Authenticated by a verified Supabase token; the user id comes only from the token.
 * - All data access runs as the signed-in user under Row Level Security (see db.ts).
 * - Responses are built field by field. Secret values are never returned; Sensitive values only by
 *   the explicit, audited reveal route; Plain values may be listed.
 * - Errors carry a fixed code and message, never request content or database details.
 * - Audit events record actions and names, never values.
 */

const ENVIRONMENTS = ["development", "preview", "production"] as const;
const VISIBILITIES = ["plain", "sensitive", "secret"] as const;
const TYPES = ["string", "number", "boolean", "url"] as const;
const NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const MAX_VALUE = 65_536;

export type AppDeps = {
  verifyToken: TokenVerifier;
  /** Checks that the session is still live before revealing a value. */
  checkSession: SessionChecker;
  db: Database;
  /** Reveals allowed per user per minute. */
  revealsPerMinute?: number;
};

type Visibility = (typeof VISIBILITIES)[number];

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const notFound = () => new ApiError(404, "not_found", "Not found.");

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

export function buildApp({ verifyToken, checkSession, db, revealsPerMinute = 20 }: AppDeps): FastifyInstance {
  // No request logging: bodies can hold values, and even URLs hold variable names.
  const app = Fastify({ logger: false, bodyLimit: 80_000, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  app.decorateRequest("userId", "");
  const reveals = new RateLimiter(revealsPerMinute, 60_000);

  // Responses can carry Plain or revealed Sensitive values: never store them in any cache.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  app.addHook("onRequest", async (request) => {
    const token = bearerToken(request.headers.authorization);
    const userId = token === undefined ? undefined : await verifyToken(token);
    if (userId === undefined) throw new ApiError(401, "unauthorized", "Sign in again.");
    request.userId = userId;
  });

  app.setErrorHandler((error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApiError) return reply.status(error.status).send({ error: error.code, message: error.message });
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.status(413).send({ error: "too_large", message: "The request is too large." });
    if (statusCode === 400 || code.startsWith("FST_ERR_VALIDATION") || code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      return reply.status(400).send({ error: "invalid_request", message: "The request is not valid." });
    }
    // Database errors: fixed messages by SQLSTATE; details (which can quote rows) are never sent.
    if (code === "42501") return reply.status(403).send({ error: "forbidden", message: "Not allowed." });
    if (code === "23505") return reply.status(409).send({ error: "conflict", message: "It already exists." });
    if (code === "23514" || code === "23503") return reply.status(409).send({ error: "conflict", message: "The change conflicts with existing data." });
    return reply.status(500).send({ error: "internal_error", message: "Something went wrong." });
  });

  app.get("/v1/me", async (request) =>
    db.withUser(request.userId, async (tx) => ({ userId: request.userId, personalWorkspaceId: await ensurePersonalWorkspace(tx, request.userId) })),
  );

  app.get("/v1/projects", async (request) =>
    db.withUser(request.userId, async (tx) => {
      await ensurePersonalWorkspace(tx, request.userId);
      const rows = await tx`select id, workspace_id, name, created_at from envsync.projects where deleted_at is null order by created_at`;
      return { projects: rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, name: row.name, createdAt: row.created_at })) };
    }),
  );

  app.post<{ Body: { name: string } }>(
    "/v1/projects",
    { schema: { body: object({ name: { type: "string", minLength: 1, maxLength: 100 } }, ["name"]) } },
    async (request, reply) => {
      const project = await db.withUser(request.userId, async (tx) => {
        const workspaceId = await ensurePersonalWorkspace(tx, request.userId);
        const [row] = await tx`insert into envsync.projects (workspace_id, name, created_by)
          values (${workspaceId}, ${request.body.name}, ${request.userId}) returning id, created_at`;
        for (const environment of ENVIRONMENTS) await tx`insert into envsync.environments (project_id, name) values (${row!.id}, ${environment})`;
        await audit(tx, request.userId, workspaceId, row!.id, "project.created", null);
        return { id: row!.id, workspaceId, name: request.body.name, createdAt: row!.created_at };
      });
      return reply.status(201).send(project);
    },
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId", { schema: { params: projectParams() } }, async (request) =>
    db.withUser(request.userId, async (tx) => {
      const project = await findProject(tx, request.params.projectId);
      const definitions = await tx`select id, name, visibility, type, required, description, revision, updated_at
        from envsync.variable_definitions where project_id = ${project.id} order by name`;
      // Plain text is selected only for Plain definitions; protected values are never read here.
      const values = await tx`select v.definition_id, e.name as environment, v.revision, v.updated_at,
          case when d.visibility = 'plain' then v.plain_value end as plain_value
        from envsync.variable_values v
        join envsync.variable_definitions d on d.id = v.definition_id
        join envsync.environments e on e.id = v.environment_id
        where d.project_id = ${project.id}`;
      return {
        id: project.id,
        workspaceId: project.workspace_id,
        name: project.name,
        environments: [...ENVIRONMENTS],
        variables: definitions.map((definition) => ({
          name: definition.name,
          visibility: definition.visibility,
          type: definition.type,
          required: definition.required,
          description: definition.description,
          revision: definition.revision,
          updatedAt: definition.updated_at,
          values: Object.fromEntries(
            ENVIRONMENTS.map((environment) => {
              const value = values.find((row) => row.definition_id === definition.id && row.environment === environment);
              if (value === undefined) return [environment, { set: false }];
              return [
                environment,
                {
                  set: true,
                  revision: value.revision,
                  updatedAt: value.updated_at,
                  ...(definition.visibility === "plain" ? { value: value.plain_value } : {}),
                },
              ];
            }),
          ),
        })),
      };
    }),
  );

  app.delete<{ Params: { projectId: string } }>("/v1/projects/:projectId", { schema: { params: projectParams() } }, async (request, reply) => {
    await db.withUser(request.userId, async (tx) => {
      const project = await findProject(tx, request.params.projectId);
      // Soft delete: recoverable for 30 days, then purged with its values (ADR-019).
      await tx`update envsync.projects set deleted_at = now() where id = ${project.id}`;
      await audit(tx, request.userId, project.workspace_id, project.id, "project.deleted", null);
    });
    return reply.status(204).send();
  });

  app.put<{ Params: { projectId: string; name: string }; Body: { visibility: Visibility; type?: string; required?: boolean; description?: string } }>(
    "/v1/projects/:projectId/variables/:name",
    {
      schema: {
        params: variableParams(),
        body: object(
          {
            visibility: { type: "string", enum: [...VISIBILITIES] },
            type: { type: "string", enum: [...TYPES] },
            required: { type: "boolean" },
            description: { type: "string", maxLength: 1000 },
          },
          ["visibility"],
        ),
      },
    },
    async (request) =>
      db.withUser(request.userId, async (tx) => {
        const project = await findProject(tx, request.params.projectId);
        const { visibility, type = "string", required = true, description = null } = request.body;
        const [row] = await tx`insert into envsync.variable_definitions (project_id, name, visibility, type, required, description, updated_by)
          values (${project.id}, ${request.params.name}, ${visibility}, ${type}, ${required}, ${description}, ${request.userId})
          on conflict (project_id, name) do update set visibility = excluded.visibility, type = excluded.type,
            required = excluded.required, description = excluded.description, updated_by = excluded.updated_by,
            updated_at = now(), revision = envsync.variable_definitions.revision + 1
          returning revision, updated_at`;
        await audit(tx, request.userId, project.workspace_id, project.id, "variable.defined", request.params.name);
        return { name: request.params.name, visibility, type, required, description, revision: row!.revision, updatedAt: row!.updated_at };
      }),
  );

  app.delete<{ Params: { projectId: string; name: string } }>(
    "/v1/projects/:projectId/variables/:name",
    { schema: { params: variableParams() } },
    async (request, reply) => {
      await db.withUser(request.userId, async (tx) => {
        const project = await findProject(tx, request.params.projectId);
        const deleted = await tx`delete from envsync.variable_definitions where project_id = ${project.id} and name = ${request.params.name} returning id`;
        if (deleted.length === 0) throw notFound();
        await audit(tx, request.userId, project.workspace_id, project.id, "variable.deleted", request.params.name);
      });
      return reply.status(204).send();
    },
  );

  // Write a value. The response never contains it, for any visibility.
  app.put<{ Params: { projectId: string; environment: string; name: string }; Body: { value: string } }>(
    "/v1/projects/:projectId/environments/:environment/variables/:name/value",
    { schema: { params: valueParams(), body: object({ value: { type: "string", maxLength: MAX_VALUE } }, ["value"]) } },
    async (request) =>
      db.withUser(request.userId, async (tx) => {
        const { project, definition, environmentId } = await findTarget(tx, request.params);
        let result: { revision: number; updated_at: Date };
        if (definition.visibility === "plain") {
          const [row] = await tx`insert into envsync.variable_values (definition_id, environment_id, plain_value, updated_by)
            values (${definition.id}, ${environmentId}, ${request.body.value}, ${request.userId})
            on conflict (definition_id, environment_id) do update set plain_value = excluded.plain_value,
              updated_by = excluded.updated_by, updated_at = now(), revision = envsync.variable_values.revision + 1
            returning revision, updated_at`;
          result = row as typeof result;
        } else {
          const [row] = await tx`select * from envsync_private.set_protected_value(${definition.id}, ${environmentId}, ${request.body.value})`;
          result = row as typeof result;
        }
        await audit(tx, request.userId, project.workspace_id, project.id, "value.set", `${request.params.environment}/${request.params.name}`);
        return { name: request.params.name, environment: request.params.environment, set: true, revision: result.revision, updatedAt: result.updated_at };
      }),
  );

  app.delete<{ Params: { projectId: string; environment: string; name: string } }>(
    "/v1/projects/:projectId/environments/:environment/variables/:name/value",
    { schema: { params: valueParams() } },
    async (request, reply) => {
      await db.withUser(request.userId, async (tx) => {
        const { project, definition, environmentId } = await findTarget(tx, request.params);
        const deleted = await tx`delete from envsync.variable_values where definition_id = ${definition.id} and environment_id = ${environmentId} returning id`;
        if (deleted.length === 0) throw notFound();
        await audit(tx, request.userId, project.workspace_id, project.id, "value.deleted", `${request.params.environment}/${request.params.name}`);
      });
      return reply.status(204).send();
    },
  );

  // Reveal a Sensitive value. Secret values are write-only: refused here and in the database.
  app.post<{ Params: { projectId: string; environment: string; name: string } }>(
    "/v1/projects/:projectId/environments/:environment/variables/:name/value/reveal",
    { schema: { params: valueParams() } },
    async (request) => {
      if (!reveals.allow(request.userId)) throw new ApiError(429, "rate_limited", "Too many reveals; try again in a minute.");
      // A signed-out session's token is still valid until it expires; refuse it for reveals.
      if (!(await checkSession(bearerToken(request.headers.authorization) ?? ""))) throw new ApiError(401, "unauthorized", "Sign in again.");
      return db.withUser(request.userId, async (tx) => {
        const { project, definition, environmentId } = await findTarget(tx, request.params);
        if (definition.visibility === "secret") throw new ApiError(403, "write_only", "Secret values are write-only and cannot be revealed.");
        if (definition.visibility !== "sensitive") throw new ApiError(400, "not_sensitive", "Only Sensitive values are revealed; Plain values are listed with the project.");
        const [row] = await tx`select id from envsync.variable_values where definition_id = ${definition.id} and environment_id = ${environmentId}`;
        if (row === undefined) throw notFound();
        const [revealed] = await tx`select envsync_private.reveal_sensitive_value(${row.id}) as value`;
        await audit(tx, request.userId, project.workspace_id, project.id, "value.revealed", `${request.params.environment}/${request.params.name}`);
        return { name: request.params.name, environment: request.params.environment, value: revealed!.value };
      });
    },
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/audit", { schema: { params: projectParams() } }, async (request) =>
    db.withUser(request.userId, async (tx) => {
      const project = await findProject(tx, request.params.projectId);
      const rows = await tx`select action, target, actor_id, created_at from envsync.audit_events
        where project_id = ${project.id} order by created_at desc, id desc limit 200`;
      return { events: rows.map((row) => ({ action: row.action, target: row.target, actorId: row.actor_id, at: row.created_at })) };
    }),
  );

  return app;
}

async function ensurePersonalWorkspace(tx: Tx, userId: string): Promise<string> {
  await tx`insert into envsync.workspaces (kind, name, owner_id) values ('personal', 'Personal', ${userId})
    on conflict (owner_id) where kind = 'personal' do nothing`;
  const [workspace] = await tx`select id from envsync.workspaces where owner_id = ${userId} and kind = 'personal'`;
  await tx`insert into envsync.memberships (workspace_id, user_id, role) values (${workspace!.id}, ${userId}, 'owner')
    on conflict do nothing`;
  // A personal workspace has exactly one member. Anything else is not used as one.
  const others = await tx`select 1 from envsync.memberships where workspace_id = ${workspace!.id} and user_id <> ${userId} limit 1`;
  if (others.length > 0) throw new ApiError(409, "conflict", "The personal workspace is in an unexpected state.");
  return workspace!.id as string;
}

/** Fixed-window counter per key; in memory, per process (enough for one API instance). */
class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const window = this.windows.get(key);
    if (window === undefined || now - window.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.prune(now);
      return true;
    }
    window.count++;
    return window.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(key);
  }
}

/** A project the user can see; another user's project is "not found", never "forbidden". */
async function findProject(tx: Tx, projectId: string) {
  const [project] = await tx`select id, workspace_id, name from envsync.projects where id = ${projectId} and deleted_at is null`;
  if (project === undefined) throw notFound();
  return project;
}

async function findTarget(tx: Tx, params: { projectId: string; environment: string; name: string }) {
  const project = await findProject(tx, params.projectId);
  const [definition] = await tx`select id, visibility from envsync.variable_definitions where project_id = ${project.id} and name = ${params.name}`;
  if (definition === undefined) throw notFound();
  const [environment] = await tx`select id from envsync.environments where project_id = ${project.id} and name = ${params.environment}`;
  if (environment === undefined) throw notFound();
  return { project, definition, environmentId: environment.id as string };
}

async function audit(tx: Tx, userId: string, workspaceId: string, projectId: string | null, action: string, target: string | null): Promise<void> {
  await tx`insert into envsync.audit_events (workspace_id, project_id, actor_id, action, target)
    values (${workspaceId}, ${projectId}, ${userId}, ${action}, ${target})`;
}

// --- JSON schemas (Fastify validates before any handler runs) -----------------------------------

function object(properties: Record<string, object>, required: string[]) {
  return { type: "object", properties, required, additionalProperties: false } as const;
}

function projectParams() {
  return object({ projectId: { type: "string", pattern: UUID_PATTERN } }, ["projectId"]);
}

function variableParams() {
  return object({ projectId: { type: "string", pattern: UUID_PATTERN }, name: { type: "string", pattern: NAME_PATTERN, maxLength: 255 } }, ["projectId", "name"]);
}

function valueParams() {
  return object(
    {
      projectId: { type: "string", pattern: UUID_PATTERN },
      environment: { type: "string", enum: [...ENVIRONMENTS] },
      name: { type: "string", pattern: NAME_PATTERN, maxLength: 255 },
    },
    ["projectId", "environment", "name"],
  );
}
