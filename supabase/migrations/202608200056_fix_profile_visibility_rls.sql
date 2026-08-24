-- Profile SELECT previously queried blocks directly from an authenticated RLS
-- policy. That both lacked table permission and could not safely inspect blocks
-- created by the other user. Keep block relationships private behind a narrow
-- SECURITY DEFINER predicate.
create or replace function public.can_view_profile(profile_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select profile_uuid = auth.uid()
    or (
      exists (
        select 1 from public.profiles profile
        where profile.id = profile_uuid and profile.status = 'active'
      )
      and not exists (
        select 1 from public.blocks block
        where (block.blocker_id = auth.uid() and block.blocked_id = profile_uuid)
           or (block.blocker_id = profile_uuid and block.blocked_id = auth.uid())
      )
    );
$$;

revoke all on function public.can_view_profile(uuid) from public, anon;
grant execute on function public.can_view_profile(uuid) to authenticated;

drop policy if exists "active profiles are discoverable" on public.profiles;
create policy "safe profiles are discoverable"
on public.profiles for select to authenticated
using (public.can_view_profile(id));

notify pgrst, 'reload schema';
