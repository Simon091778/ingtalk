drop function if exists public.my_chat_rooms();

create function public.my_chat_rooms()
returns table (
  room_id uuid,
  other_user_id uuid,
  other_nickname text,
  other_avatar_url text,
  other_gender text,
  other_birth_year integer,
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
    other_profile.avatar_url,
    other_profile.gender,
    other_profile.birth_year,
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

notify pgrst, 'reload schema';
