-- 0003 made audit events check their project through project_workspace(), which treats
-- soft-deleted projects as unreachable. The "project.deleted" event is written right after the
-- deletion, so it was refused. Audit events now check that the project belongs to the event's
-- workspace directly, whether or not it is deleted (projects stay visible to members under RLS).
drop policy member_appends on envsync.audit_events;
create policy member_appends on envsync.audit_events for insert to envsync_api
  with check (
    actor_id = envsync.current_user_id()
    and envsync_private.has_role(workspace_id, array['owner', 'admin', 'developer', 'viewer'])
    and (project_id is null or exists (select 1 from envsync.projects p where p.id = project_id and p.workspace_id = audit_events.workspace_id))
  );
