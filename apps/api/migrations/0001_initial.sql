-- EnvSync cloud schema (Phase 4: personal workspaces). Applied by scripts/migrate.mjs as the
-- database owner. Design rules (docs/DECISIONS.md ADR-018/019):
--   * All tables live in schema `envsync`, which Supabase's Data API does not expose; the browser
--     roles (anon, authenticated) get no access at all. Only the API's own role (envsync_api) can
--     read or write, and Row Level Security limits it to the signed-in user's workspaces.
--   * Plain values are stored as text. Sensitive and Secret values are stored in Supabase Vault and
--     only referenced here. The API role cannot read Vault; the private functions below can.
--   * Secret values can never be decrypted through this schema (write-only). Sensitive values can be
--     revealed only through envsync_private.reveal_sensitive_value, which refuses anything else.
--   * Audit events never contain values.

create extension if not exists supabase_vault;

create schema envsync;
create schema envsync_private;

-- The API's database role. LOGIN and its password are set by scripts/setup-api-role.mjs, so no
-- credential is ever written into a migration.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'envsync_api') then
    create role envsync_api nologin noinherit;
  end if;
end $$;

revoke all on schema envsync, envsync_private from public, anon, authenticated;
grant usage on schema envsync to envsync_api;
grant usage on schema envsync_private to envsync_api;

-- The user the API acts for, set per transaction with set_config('envsync.user_id', ..., true).
-- Unset or malformed means "nobody": every policy then matches no rows.
create function envsync.current_user_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('envsync.user_id', true), '')::uuid $$;

create table envsync.workspaces (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('personal', 'team')),
  name text not null check (char_length(name) between 1 and 100),
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index workspaces_one_personal_per_user on envsync.workspaces (owner_id) where kind = 'personal';

create table envsync.memberships (
  workspace_id uuid not null references envsync.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'developer', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table envsync.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references envsync.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index projects_workspace on envsync.projects (workspace_id);

create table envsync.environments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references envsync.projects (id) on delete cascade,
  name text not null check (name in ('development', 'preview', 'production')),
  unique (project_id, name)
);

create table envsync.variable_definitions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references envsync.projects (id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z_][A-Za-z0-9_]*$' and char_length(name) <= 255),
  visibility text not null check (visibility in ('plain', 'sensitive', 'secret')),
  type text not null default 'string' check (type in ('string', 'number', 'boolean', 'url')),
  required boolean not null default true,
  description text check (char_length(description) <= 1000),
  revision integer not null default 1,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);

create table envsync.variable_values (
  id uuid primary key default gen_random_uuid(),
  definition_id uuid not null references envsync.variable_definitions (id) on delete cascade,
  environment_id uuid not null references envsync.environments (id) on delete cascade,
  -- Exactly one of: plain text (visibility plain) or a Vault reference (sensitive, secret).
  plain_value text check (char_length(plain_value) <= 65536),
  vault_secret_id uuid,
  key_provider text not null default 'supabase_vault' check (key_provider in ('supabase_vault')),
  revision integer not null default 1,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (definition_id, environment_id),
  check ((plain_value is null) <> (vault_secret_id is null))
);

create table envsync.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references envsync.workspaces (id) on delete cascade,
  project_id uuid references envsync.projects (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  -- e.g. 'project.created', 'value.set', 'value.revealed'. Never a value.
  action text not null check (char_length(action) <= 64),
  target text check (char_length(target) <= 300),
  created_at timestamptz not null default now()
);
create index audit_events_project on envsync.audit_events (project_id, created_at desc);

-- Membership test that does not itself go through RLS on memberships (avoids policy recursion).
create function envsync_private.has_role(p_workspace uuid, p_roles text[]) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1 from envsync.memberships m
      where m.workspace_id = p_workspace and m.user_id = envsync.current_user_id() and m.role = any (p_roles)
    )
  $$;

create function envsync_private.project_workspace(p_project uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$ select workspace_id from envsync.projects where id = p_project $$;

-- Row Level Security: the API role sees only rows of workspaces the current user belongs to, and
-- writes only where the user's role allows (viewers read only).
alter table envsync.workspaces enable row level security;
alter table envsync.memberships enable row level security;
alter table envsync.projects enable row level security;
alter table envsync.environments enable row level security;
alter table envsync.variable_definitions enable row level security;
alter table envsync.variable_values enable row level security;
alter table envsync.audit_events enable row level security;

create policy member_reads on envsync.workspaces for select to envsync_api
  using (envsync_private.has_role(id, array['owner', 'admin', 'developer', 'viewer']));
create policy owner_creates_personal on envsync.workspaces for insert to envsync_api
  with check (owner_id = envsync.current_user_id());
create policy owner_updates on envsync.workspaces for update to envsync_api
  using (envsync_private.has_role(id, array['owner']));

create policy see_own_memberships on envsync.memberships for select to envsync_api
  using (user_id = envsync.current_user_id() or envsync_private.has_role(workspace_id, array['owner', 'admin']));
-- The only membership a user can create for themselves is ownership of their own personal workspace.
create policy own_personal_membership on envsync.memberships for insert to envsync_api
  with check (
    user_id = envsync.current_user_id() and role = 'owner'
    and exists (select 1 from envsync.workspaces w where w.id = workspace_id and w.owner_id = envsync.current_user_id() and w.kind = 'personal')
  );

create policy member_reads on envsync.projects for select to envsync_api
  using (envsync_private.has_role(workspace_id, array['owner', 'admin', 'developer', 'viewer']));
create policy writer_writes on envsync.projects for all to envsync_api
  using (envsync_private.has_role(workspace_id, array['owner', 'admin', 'developer']))
  with check (envsync_private.has_role(workspace_id, array['owner', 'admin', 'developer']));

create policy member_reads on envsync.environments for select to envsync_api
  using (envsync_private.has_role(envsync_private.project_workspace(project_id), array['owner', 'admin', 'developer', 'viewer']));
create policy writer_writes on envsync.environments for all to envsync_api
  using (envsync_private.has_role(envsync_private.project_workspace(project_id), array['owner', 'admin', 'developer']))
  with check (envsync_private.has_role(envsync_private.project_workspace(project_id), array['owner', 'admin', 'developer']));

create policy member_reads on envsync.variable_definitions for select to envsync_api
  using (envsync_private.has_role(envsync_private.project_workspace(project_id), array['owner', 'admin', 'developer', 'viewer']));
create policy writer_writes on envsync.variable_definitions for all to envsync_api
  using (envsync_private.has_role(envsync_private.project_workspace(project_id), array['owner', 'admin', 'developer']))
  with check (envsync_private.has_role(envsync_private.project_workspace(project_id), array['owner', 'admin', 'developer']));

create function envsync_private.definition_workspace(p_definition uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$ select p.workspace_id from envsync.variable_definitions d join envsync.projects p on p.id = d.project_id where d.id = p_definition $$;

create policy member_reads on envsync.variable_values for select to envsync_api
  using (envsync_private.has_role(envsync_private.definition_workspace(definition_id), array['owner', 'admin', 'developer', 'viewer']));
create policy writer_writes on envsync.variable_values for all to envsync_api
  using (envsync_private.has_role(envsync_private.definition_workspace(definition_id), array['owner', 'admin', 'developer']))
  with check (envsync_private.has_role(envsync_private.definition_workspace(definition_id), array['owner', 'admin', 'developer']));

create policy member_reads on envsync.audit_events for select to envsync_api
  using (envsync_private.has_role(workspace_id, array['owner', 'admin', 'developer', 'viewer']));
create policy member_appends on envsync.audit_events for insert to envsync_api
  with check (actor_id = envsync.current_user_id() and envsync_private.has_role(workspace_id, array['owner', 'admin', 'developer', 'viewer']));

-- The API role: data access only through the policies above; audit events are append-only.
grant select, insert, update, delete on envsync.workspaces, envsync.memberships, envsync.projects,
  envsync.environments, envsync.variable_definitions, envsync.variable_values to envsync_api;
grant select, insert on envsync.audit_events to envsync_api;
grant execute on function envsync.current_user_id() to envsync_api;

-- Storage must match the definition: plain text only for Plain variables, Vault for the others.
-- Enforced here so that even a faulty or compromised API process cannot store a secret as text.
create function envsync_private.check_value_storage() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_visibility text;
  begin
    select visibility into v_visibility from envsync.variable_definitions where id = new.definition_id;
    if (v_visibility = 'plain') <> (new.plain_value is not null) then
      raise exception 'value storage does not match the variable''s visibility' using errcode = '23514';
    end if;
    if not exists (
      select 1 from envsync.environments e join envsync.variable_definitions d on d.project_id = e.project_id
      where e.id = new.environment_id and d.id = new.definition_id
    ) then
      raise exception 'environment belongs to another project' using errcode = '23514';
    end if;
    return new;
  end
  $$;
create trigger check_value_storage before insert or update on envsync.variable_values
  for each row execute function envsync_private.check_value_storage();

-- Visibility is fixed once values exist: changing it would mean exposing or re-encrypting them.
create function envsync_private.check_visibility_change() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if new.visibility <> old.visibility and exists (select 1 from envsync.variable_values where definition_id = old.id) then
      raise exception 'visibility cannot change while values exist' using errcode = '23514';
    end if;
    return new;
  end
  $$;
create trigger check_visibility_change before update on envsync.variable_definitions
  for each row execute function envsync_private.check_visibility_change();

-- Writes a Sensitive or Secret value into Vault and records the reference, creating or updating it.
-- The only way to store such a value; checks the current user's role itself (it bypasses RLS).
create function envsync_private.set_protected_value(p_definition uuid, p_environment uuid, p_secret text)
  returns table (revision integer, updated_at timestamptz)
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_workspace uuid := envsync_private.definition_workspace(p_definition);
    v_visibility text;
    v_value uuid;
    v_secret uuid;
  begin
    if v_workspace is null or not envsync_private.has_role(v_workspace, array['owner', 'admin', 'developer']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    select d.visibility into v_visibility from envsync.variable_definitions d where d.id = p_definition;
    if v_visibility = 'plain' then
      raise exception 'plain values are not stored in Vault' using errcode = '23514';
    end if;
    if char_length(p_secret) > 65536 then
      raise exception 'value too long' using errcode = '22001';
    end if;
    select v.id, v.vault_secret_id into v_value, v_secret
      from envsync.variable_values v where v.definition_id = p_definition and v.environment_id = p_environment
      for update;
    if v_value is null then
      v_secret := vault.create_secret(p_secret, null, 'envsync value');
      insert into envsync.variable_values (definition_id, environment_id, vault_secret_id, updated_by)
        values (p_definition, p_environment, v_secret, envsync.current_user_id());
    else
      perform vault.update_secret(v_secret, p_secret);
      update envsync.variable_values v
        set revision = v.revision + 1, updated_at = now(), updated_by = envsync.current_user_id()
        where v.id = v_value;
    end if;
    return query
      select v.revision, v.updated_at from envsync.variable_values v
      where v.definition_id = p_definition and v.environment_id = p_environment;
  end
  $$;

-- Sensitive values only. Secret values have no decrypting path in this schema at all.
create function envsync_private.reveal_sensitive_value(p_value uuid) returns text
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_secret uuid;
    v_visibility text;
    v_workspace uuid;
    v_plain text;
  begin
    select v.vault_secret_id, d.visibility, p.workspace_id
      into v_secret, v_visibility, v_workspace
      from envsync.variable_values v
      join envsync.variable_definitions d on d.id = v.definition_id
      join envsync.projects p on p.id = d.project_id
      where v.id = p_value;
    if v_workspace is null or not envsync_private.has_role(v_workspace, array['owner', 'admin', 'developer']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_visibility is distinct from 'sensitive' then
      raise exception 'only sensitive values can be revealed' using errcode = '42501';
    end if;
    select decrypted_secret into v_plain from vault.decrypted_secrets where id = v_secret;
    return v_plain;
  end
  $$;

-- Removing a value (directly or by cascade from a definition, project, workspace or user) removes
-- its Vault entry too, so no orphaned encrypted values remain.
create function envsync_private.drop_vault_secret() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if old.vault_secret_id is not null then
      delete from vault.secrets where id = old.vault_secret_id;
    end if;
    return old;
  end
  $$;
create trigger drop_vault_secret after delete on envsync.variable_values
  for each row execute function envsync_private.drop_vault_secret();

revoke all on all functions in schema envsync_private from public, anon, authenticated;
grant execute on function envsync_private.has_role(uuid, text[]), envsync_private.project_workspace(uuid),
  envsync_private.definition_workspace(uuid), envsync_private.set_protected_value(uuid, uuid, text),
  envsync_private.reveal_sensitive_value(uuid) to envsync_api;
