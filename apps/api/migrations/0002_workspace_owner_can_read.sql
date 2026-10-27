-- INSERT ... ON CONFLICT checks the new row against the table's SELECT policy as well. A new
-- personal workspace has no membership yet, so "members can read" rejected it. Owners can always
-- read their own workspace; members (Phase 5 teams) still read through their membership.
drop policy member_reads on envsync.workspaces;
create policy owner_or_member_reads on envsync.workspaces for select to envsync_api
  using (owner_id = envsync.current_user_id() or envsync_private.has_role(id, array['owner', 'admin', 'developer', 'viewer']));
