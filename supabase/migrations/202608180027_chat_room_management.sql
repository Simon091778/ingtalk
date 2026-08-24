alter table public.chat_members
add column if not exists hidden_at timestamptz;

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

  update public.chat_members
  set hidden_at = now()
  where room_id = room_uuid and user_id = auth.uid();

  if action = 'block' then
    insert into public.blocks(blocker_id, blocked_id)
    values (auth.uid(), other_user_uuid)
    on conflict (blocker_id, blocked_id) do nothing;

    update public.chat_rooms
    set closed_at = coalesce(closed_at, now())
    where id = room_uuid;

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

drop policy if exists "members send own messages" on public.messages;
create policy "members send own messages" on public.messages
for insert to authenticated
with check (
  sender_id = auth.uid()
  and public.is_room_member(room_id)
  and exists (
    select 1 from public.chat_rooms room
    where room.id = messages.room_id and room.closed_at is null
  )
  and not exists (
    select 1
    from public.chat_members other_member
    join public.blocks block
      on (block.blocker_id = auth.uid() and block.blocked_id = other_member.user_id)
      or (block.blocker_id = other_member.user_id and block.blocked_id = auth.uid())
    where other_member.room_id = messages.room_id
      and other_member.user_id <> auth.uid()
  )
);

create or replace function public.my_chat_rooms()
returns table (
  room_id uuid,
  other_user_id uuid,
  other_nickname text,
  last_message text,
  last_message_at timestamptz,
  unread_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    room.id,
    other_member.user_id,
    other_profile.nickname,
    last_msg.body,
    coalesce(last_msg.created_at, room.created_at),
    (
      select count(*) from public.messages unread
      where unread.room_id = room.id
        and unread.sender_id <> auth.uid()
        and unread.created_at > coalesce(mine.last_read_at, room.created_at)
        and unread.moderation_state = 'visible'
    )
  from public.chat_rooms room
  join public.chat_members mine
    on mine.room_id = room.id
   and mine.user_id = auth.uid()
   and mine.hidden_at is null
  join public.chat_members other_member
    on other_member.room_id = room.id
   and other_member.user_id <> auth.uid()
  join public.profiles other_profile on other_profile.id = other_member.user_id
  left join lateral (
    select body, created_at from public.messages latest
    where latest.room_id = room.id and latest.moderation_state = 'visible'
    order by latest.created_at desc limit 1
  ) last_msg on true
  where room.closed_at is null
    and not exists (
      select 1 from public.blocks block
      where (block.blocker_id = auth.uid() and block.blocked_id = other_member.user_id)
         or (block.blocker_id = other_member.user_id and block.blocked_id = auth.uid())
    )
  order by coalesce(last_msg.created_at, room.created_at) desc;
$$;

revoke all on function public.my_chat_rooms() from public;
grant execute on function public.my_chat_rooms() to authenticated;
