-- Hardening after the Phase 4 security review. The database must hold even if SQL runs as
-- envsync_api with arbitrary statements (a compromised API process or a future route bug).

-- L6: functions created later in envsync_private are not callable by everyone by default.
alter default privileges in schema envsync_private revoke execute on functions from public;

-- H1, H2, L7: the API role may write only the columns the API needs. Vault references, owners,
-- workspace kinds and parent links can never be set or changed by it.
revoke insert, update on envsync.workspaces, envsync.memberships, envsync.projects, envsync.environments,
  envsync.variable_definitions, envsync.variable_values from envsync_api;
grant insert (kind, name, owner_id) on envsync.workspaces to envsync_api;
grant update (name) on envsync.workspaces to envsync_api;
grant insert (workspace_id, user_id, role) on envsync.memberships to envsync_api;
grant insert (workspace_id, name, created_by) on envsync.projects to envsync_api;
grant update (name, deleted_at) on envsync.projects to envsync_api;
grant insert (project_id, name) on envsync.environments to envsync_api;
grant insert (project_id, name, visibility, type, required, description, updated_by) on envsync.variable_definitions to envsync_api;
grant update (visibility, type, required, description, updated_by, updated_at, revision) on envsync.variable_definitions to envsync_api;
grant insert (definition_id, environment_id, plain_value, updated_by) on envsync.variable_values to envsync_api;
grant update (plain_value, updated_by, updated_at, revision) on envsync.variable_values to envsync_api;

-- H1: a Vault entry belongs to exactly one value row, and a row's parents never change.
create unique index variable_values_one_row_per_vault_entry on envsync.variable_values (vault_secret_id) where vault_secret_id is not null;

create function envsync_private.check_value_identity() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if new.definition_id <> old.definition_id or new.environment_id <> old.environment_id
       or new.vault_secret_id is distinct from old.vault_secret_id then
      raise exception 'a value cannot move to another variable, environment or Vault entry' using errcode = '42501';
    end if;
    return new;
  end
  $$;
create trigger check_value_identity before update on envsync.variable_values
  for each row execute function envsync_private.check_value_identity();

-- L4, L5: lookups return a workspace only for live projects the current user belongs to. Policies
-- that use them therefore also hide variables and values of soft-deleted projects.
create or replace function envsync_private.project_workspace(p_project uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$
    select p.workspace_id from envsync.projects p
    where p.id = p_project and p.deleted_at is null
      and envsync_private.has_role(p.workspace_id, array['owner', 'admin', 'developer', 'viewer'])
  $$;

create or replace function envsync_private.definition_workspace(p_definition uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$
    select p.workspace_id from envsync.variable_definitions d join envsync.projects p on p.id = d.project_id
    where d.id = p_definition and p.deleted_at is null
      and envsync_private.has_role(p.workspace_id, array['owner', 'admin', 'developer', 'viewer'])
  $$;

-- The Vault entry name ties it to its value: envsync:<definition id>:<environment id>.
create function envsync_private.vault_name(p_definition uuid, p_environment uuid) returns text
  language sql immutable set search_path = ''
  as $$ select 'envsync:' || p_definition::text || ':' || p_environment::text $$;

-- M1: the definition row is locked (FOR SHARE) while a value is written, so a concurrent visibility
-- change waits and then sees the value (and is refused), instead of slipping in between.
create or replace function envsync_private.check_value_storage() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_visibility text;
  begin
    select visibility into v_visibility from envsync.variable_definitions where id = new.definition_id for share;
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

create or replace function envsync_private.check_visibility_change() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if new.visibility <> old.visibility and exists (select 1 from envsync.variable_values where definition_id = old.id) then
      raise exception 'visibility cannot change while values exist' using errcode = '23514';
    end if;
    if new.project_id <> old.project_id or new.name <> old.name then
      raise exception 'a variable cannot move or be renamed in place' using errcode = '42501';
    end if;
    return new;
  end
  $$;

create or replace function envsync_private.set_protected_value(p_definition uuid, p_environment uuid, p_secret text)
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
    select d.visibility into v_visibility from envsync.variable_definitions d where d.id = p_definition for share;
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
      v_secret := vault.create_secret(p_secret, envsync_private.vault_name(p_definition, p_environment), 'envsync value');
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

create or replace function envsync_private.reveal_sensitive_value(p_value uuid) returns text
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_secret uuid;
    v_definition uuid;
    v_environment uuid;
    v_visibility text;
    v_workspace uuid;
    v_plain text;
  begin
    select v.vault_secret_id, v.definition_id, v.environment_id, d.visibility, p.workspace_id
      into v_secret, v_definition, v_environment, v_visibility, v_workspace
      from envsync.variable_values v
      join envsync.variable_definitions d on d.id = v.definition_id
      join envsync.projects p on p.id = d.project_id and p.deleted_at is null
      where v.id = p_value
      for share of d;
    if v_workspace is null or not envsync_private.has_role(v_workspace, array['owner', 'admin', 'developer']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_visibility is distinct from 'sensitive' then
      raise exception 'only sensitive values can be revealed' using errcode = '42501';
    end if;
    -- The Vault entry must be the one created for exactly this variable and environment.
    select decrypted_secret into v_plain from vault.decrypted_secrets
      where id = v_secret and name = envsync_private.vault_name(v_definition, v_environment);
    if not found then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    return v_plain;
  end
  $$;

-- Only EnvSync's own Vault entries are ever deleted with a value.
create or replace function envsync_private.drop_vault_secret() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if old.vault_secret_id is not null then
      delete from vault.secrets
        where id = old.vault_secret_id and name = envsync_private.vault_name(old.definition_id, old.environment_id);
    end if;
    return old;
  end
  $$;

-- L3: attribution is always the signed-in user, whatever the statement says.
create function envsync_private.stamp_created_by() returns trigger
  language plpgsql set search_path = ''
  as $$ begin new.created_by := envsync.current_user_id(); return new; end $$;
create function envsync_private.stamp_updated_by() returns trigger
  language plpgsql set search_path = ''
  as $$
  begin
    -- Inside set_protected_value (run as the owner) the same user id is set; keep it consistent.
    new.updated_by := envsync.current_user_id();
    return new;
  end
  $$;
create trigger stamp_created_by before insert on envsync.projects
  for each row execute function envsync_private.stamp_created_by();
create trigger stamp_updated_by before insert or update on envsync.variable_definitions
  for each row execute function envsync_private.stamp_updated_by();
create trigger stamp_updated_by before insert or update on envsync.variable_values
  for each row execute function envsync_private.stamp_updated_by();

-- L1: users can create only their own personal workspace.
drop policy owner_creates_personal on envsync.workspaces;
create policy owner_creates_personal on envsync.workspaces for insert to envsync_api
  with check (owner_id = envsync.current_user_id() and kind = 'personal');
-- H2: the owner may rename the workspace; owner and kind cannot change (column grants above).
drop policy owner_updates on envsync.workspaces;
create policy owner_updates on envsync.workspaces for update to envsync_api
  using (envsync_private.has_role(id, array['owner']))
  with check (envsync_private.has_role(id, array['owner']) and owner_id = envsync.current_user_id());

-- L2: audit events must belong to a project of the same workspace (or to the workspace itself).
drop policy member_appends on envsync.audit_events;
create policy member_appends on envsync.audit_events for insert to envsync_api
  with check (
    actor_id = envsync.current_user_id()
    and envsync_private.has_role(workspace_id, array['owner', 'admin', 'developer', 'viewer'])
    and (project_id is null or envsync_private.project_workspace(project_id) = workspace_id)
  );

revoke all on all functions in schema envsync_private from public, anon, authenticated;
grant execute on function envsync_private.has_role(uuid, text[]), envsync_private.project_workspace(uuid),
  envsync_private.definition_workspace(uuid), envsync_private.set_protected_value(uuid, uuid, text),
  envsync_private.reveal_sensitive_value(uuid) to envsync_api;
