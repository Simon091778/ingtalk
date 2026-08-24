-- Deleting a room removes its live/user-visible history for both members while
-- retaining the immutable server backup for authorized moderation review.

alter table public.message_backups
  add column if not exists deleted_from_live_at timestamptz,
  add column if not exists deleted_by_user_id uuid,
  add column if not exists deletion_action text
    check (deletion_action is null or deletion_action in ('delete', 'block'));

create or replace function public.manage_chat_room(room_uuid uuid, action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  other_user_uuid uuid;
  room_request_uuid uuid;
  deleted_at timestamptz := now();
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if action not in ('delete', 'block') then raise exception 'invalid_room_action'; end if;

  if not exists (
    select 1 from public.chat_members
    where room_id = room_uuid and user_id = auth.uid()
  ) then raise exception 'room_not_allowed'; end if;

  select room.request_id into room_request_uuid
  from public.chat_rooms room
  where room.id = room_uuid
  for update;
  if room_request_uuid is null then raise exception 'room_not_found'; end if;

  select member.user_id into other_user_uuid
  from public.chat_members member
  where member.room_id = room_uuid and member.user_id <> auth.uid()
  limit 1;
  if other_user_uuid is null then raise exception 'room_member_not_found'; end if;

  -- The normal insert trigger already backs up messages. This extra copy makes
  -- the delete operation safe for legacy rows created before that trigger.
  insert into public.message_backups(
    original_message_id, room_id, sender_id, body, moderation_state,
    message_created_at, deleted_from_live_at, deleted_by_user_id, deletion_action
  )
  select message.id, message.room_id, message.sender_id, message.body,
         message.moderation_state, message.created_at,
         deleted_at, auth.uid(), action
  from public.messages message
  where message.room_id = room_uuid
  on conflict (original_message_id) do update
  set deleted_from_live_at = excluded.deleted_from_live_at,
      deleted_by_user_id = excluded.deleted_by_user_id,
      deletion_action = excluded.deletion_action;

  -- Remove the live copy. Ordinary users have no access to message_backups, so
  -- reopening this room later starts with a genuinely empty visible history.
  delete from public.messages where room_id = room_uuid;

  update public.chat_rooms
  set closed_at = deleted_at
  where id = room_uuid;

  update public.chat_members
  set hidden_at = deleted_at
  where room_id = room_uuid;

  update public.chat_requests
  set status = 'cancelled', responded_at = deleted_at
  where id = room_request_uuid;

  if action = 'block' then
    insert into public.blocks(blocker_id, blocked_id)
    values (auth.uid(), other_user_uuid)
    on conflict (blocker_id, blocked_id) do nothing;

    update public.chat_requests
    set status = 'cancelled', responded_at = deleted_at
    where status = 'pending'
      and ((sender_id = auth.uid() and receiver_id = other_user_uuid)
        or (sender_id = other_user_uuid and receiver_id = auth.uid()));
  end if;
end;
$$;

-- Message backups remain inaccessible as a table. Moderators can inspect a
-- bounded room history only through this role-checked RPC.
create or replace function public.admin_list_message_backups(
  target_room_uuid uuid,
  result_limit integer default 300
)
returns table (
  original_message_id bigint,
  room_id uuid,
  sender_id uuid,
  sender_nickname text,
  body text,
  moderation_state text,
  message_created_at timestamptz,
  backed_up_at timestamptz,
  deleted_from_live_at timestamptz,
  deleted_by_user_id uuid,
  deletion_action text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.admin_has_role('moderator') then
    raise exception 'admin_role_required';
  end if;
  if target_room_uuid is null then raise exception 'room_required'; end if;

  return query
  select backup.original_message_id,
         backup.room_id,
         backup.sender_id,
         profile.nickname,
         backup.body,
         backup.moderation_state,
         backup.message_created_at,
         backup.backed_up_at,
         backup.deleted_from_live_at,
         backup.deleted_by_user_id,
         backup.deletion_action
  from public.message_backups backup
  left join public.profiles profile on profile.id = backup.sender_id
  where backup.room_id = target_room_uuid
  order by backup.message_created_at asc
  limit least(greatest(coalesce(result_limit, 300), 1), 1000);
end;
$$;

revoke all on function public.manage_chat_room(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_list_message_backups(uuid, integer) from public, anon, authenticated;
grant execute on function public.manage_chat_room(uuid, text) to authenticated;
grant execute on function public.admin_list_message_backups(uuid, integer) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.chat_rooms;
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';
