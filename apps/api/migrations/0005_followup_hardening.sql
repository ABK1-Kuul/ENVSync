-- Follow-up hardening after the second Phase 4 review.

-- M-A: a per-schema REVOKE cannot remove PostgreSQL's built-in PUBLIC EXECUTE on new functions;
-- only the role-wide default can. Functions this owner creates from now on are not executable by
-- PUBLIC; each migration grants what envsync_api needs explicitly (and a test checks the allowlist).
alter default privileges revoke execute on functions from public;

-- Low 1: Vault entries created before 0003 have no name, so reveal and cleanup (which match on the
-- name) would skip them. Name every EnvSync entry after its variable and environment.
do $$
declare
  r record;
begin
  for r in
    select v.vault_secret_id, v.definition_id, v.environment_id
    from envsync.variable_values v join vault.secrets s on s.id = v.vault_secret_id
    where s.name is distinct from envsync_private.vault_name(v.definition_id, v.environment_id)
  loop
    perform vault.update_secret(r.vault_secret_id, null, envsync_private.vault_name(r.definition_id, r.environment_id));
  end loop;
end $$;

-- Low 4: stamp the signed-in user only when there is one. Cascades (e.g. ON DELETE SET NULL when
-- an account is deleted) run without a user and must keep their NULL.
create or replace function envsync_private.stamp_updated_by() returns trigger
  language plpgsql set search_path = ''
  as $$
  begin
    if envsync.current_user_id() is not null then
      new.updated_by := envsync.current_user_id();
    end if;
    return new;
  end
  $$;
create or replace function envsync_private.stamp_created_by() returns trigger
  language plpgsql set search_path = ''
  as $$
  begin
    if envsync.current_user_id() is not null then
      new.created_by := envsync.current_user_id();
    end if;
    return new;
  end
  $$;

-- Low 7: any member with the owner role may rename; the owner and kind columns cannot change at all
-- (no update grant), so the check need not compare owner_id.
drop policy owner_updates on envsync.workspaces;
create policy owner_updates on envsync.workspaces for update to envsync_api
  using (envsync_private.has_role(id, array['owner']))
  with check (envsync_private.has_role(id, array['owner']));

-- Low 8: only members who can change the project write audit events (viewers only read).
drop policy member_appends on envsync.audit_events;
create policy writer_appends on envsync.audit_events for insert to envsync_api
  with check (
    actor_id = envsync.current_user_id()
    and envsync_private.has_role(workspace_id, array['owner', 'admin', 'developer'])
    and (project_id is null or exists (select 1 from envsync.projects p where p.id = project_id and p.workspace_id = audit_events.workspace_id))
  );

-- Low 9: projects are only soft-deleted through the API; hard deletion (and purge after 30 days) is
-- for the owner role. Memberships cannot be deleted by the API role either.
revoke delete on envsync.projects, envsync.memberships, envsync.workspaces from envsync_api;

-- M1 (intent): a protected write names the visibility the caller saw. If the variable's visibility
-- changed in the meantime (for example Secret -> Sensitive while the value was being written), the
-- write is refused instead of silently storing a value the caller believed was write-only.
drop function envsync_private.set_protected_value(uuid, uuid, text);
create function envsync_private.set_protected_value(p_definition uuid, p_environment uuid, p_secret text, p_expected_visibility text)
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
    if v_visibility is distinct from p_expected_visibility then
      raise exception 'the variable''s visibility changed; try again' using errcode = '40001';
    end if;
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

-- Re-assert the allowlist (the function above is new, and new functions are no longer PUBLIC).
revoke all on all functions in schema envsync_private from public, anon, authenticated;
grant execute on function envsync_private.has_role(uuid, text[]), envsync_private.project_workspace(uuid),
  envsync_private.definition_workspace(uuid), envsync_private.set_protected_value(uuid, uuid, text, text),
  envsync_private.reveal_sensitive_value(uuid) to envsync_api;
