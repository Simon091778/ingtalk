create or replace function public.my_blocked_users()
returns table (
  blocked_id uuid,
  nickname text,
  avatar_url text,
  blocked_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select block.blocked_id, profile.nickname, profile.avatar_url, block.created_at
  from public.blocks block
  join public.profiles profile on profile.id = block.blocked_id
  where block.blocker_id = auth.uid()
  order by block.created_at desc;
$$;

create or replace function public.unblock_user(blocked_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  delete from public.blocks
  where blocker_id = auth.uid() and blocked_id = blocked_user_id;

  return found;
end;
$$;

revoke all on function public.my_blocked_users() from public, anon;
revoke all on function public.unblock_user(uuid) from public, anon;
grant execute on function public.my_blocked_users() to authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;

notify pgrst, 'reload schema';
