-- Closing a live room must remove its accepted request from both users' request
-- lists. Keep the row for point/audit integrity and hide it with withdrawn_at.
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

  delete from public.messages where room_id = room_uuid;

  update public.chat_rooms
  set closed_at = deleted_at
  where id = room_uuid;

  update public.chat_members
  set hidden_at = deleted_at
  where room_id = room_uuid;

  update public.chat_requests
  set status = 'cancelled', responded_at = deleted_at, withdrawn_at = deleted_at
  where id = room_request_uuid;

  if action = 'block' then
    insert into public.blocks(blocker_id, blocked_id)
    values (auth.uid(), other_user_uuid)
    on conflict (blocker_id, blocked_id) do nothing;

    update public.chat_requests
    set status = 'cancelled', responded_at = deleted_at, withdrawn_at = deleted_at
    where status = 'pending'
      and ((sender_id = auth.uid() and receiver_id = other_user_uuid)
        or (sender_id = other_user_uuid and receiver_id = auth.uid()));
  end if;
end;
$$;

-- Repair requests left visible by room deletions performed before this fix.
update public.chat_requests request
set withdrawn_at = coalesce(request.withdrawn_at, room.closed_at, now())
from public.chat_rooms room
where room.request_id = request.id
  and room.closed_at is not null
  and request.status = 'cancelled'
  and request.withdrawn_at is null;

revoke all on function public.manage_chat_room(uuid, text) from public, anon, authenticated;
grant execute on function public.manage_chat_room(uuid, text) to authenticated;

notify pgrst, 'reload schema';
