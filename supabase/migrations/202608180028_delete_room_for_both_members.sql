create or replace function public.manage_chat_room(room_uuid uuid, action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  other_user_uuid uuid;
begin
  if action not in ('delete', 'block') then
    raise exception 'invalid_room_action';
  end if;

  if not exists (
    select 1 from public.chat_members
    where room_id = room_uuid and user_id = auth.uid()
  ) then
    raise exception 'room_not_allowed';
  end if;

  select user_id into other_user_uuid
  from public.chat_members
  where room_id = room_uuid and user_id <> auth.uid()
  limit 1;

  if other_user_uuid is null then
    raise exception 'room_member_not_found';
  end if;

  -- 삭제와 차단 모두 채팅방을 종료해 양쪽 대화 목록에서 제거한다.
  update public.chat_rooms
  set closed_at = coalesce(closed_at, now())
  where id = room_uuid;

  update public.chat_members
  set hidden_at = now()
  where room_id = room_uuid;

  if action = 'block' then
    insert into public.blocks(blocker_id, blocked_id)
    values (auth.uid(), other_user_uuid)
    on conflict (blocker_id, blocked_id) do nothing;

    update public.chat_requests
    set status = 'cancelled', responded_at = now()
    where status = 'pending'
      and ((sender_id = auth.uid() and receiver_id = other_user_uuid)
        or (sender_id = other_user_uuid and receiver_id = auth.uid()));
  end if;
end;
$$;

revoke all on function public.manage_chat_room(uuid, text) from public;
grant execute on function public.manage_chat_room(uuid, text) to authenticated;
