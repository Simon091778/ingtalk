-- Secure request lifecycle and read models for the complete 1:1 chat flow.

drop policy if exists "receiver responds to request" on public.chat_requests;
drop policy if exists "sender creates request" on public.chat_requests;

revoke insert, update, delete on public.chat_requests from authenticated;
grant select on public.chat_requests to authenticated;
grant select on public.chat_rooms, public.chat_members to authenticated;
grant select, insert on public.messages to authenticated;
grant update(last_read_at) on public.chat_members to authenticated;

create or replace function public.create_chat_request(card_uuid uuid, opening_text text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_card public.conversation_cards;
  request_uuid uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(opening_text)) < 2 or char_length(trim(opening_text)) > 200 then
    raise exception 'opening_message_length';
  end if;

  select * into target_card
  from public.conversation_cards
  where id = card_uuid and is_active and expires_at > now();

  if target_card.id is null then raise exception 'card_not_available'; end if;
  if target_card.author_id = auth.uid() then raise exception 'cannot_request_self'; end if;
  if exists (
    select 1 from public.blocks
    where (blocker_id = auth.uid() and blocked_id = target_card.author_id)
       or (blocker_id = target_card.author_id and blocked_id = auth.uid())
  ) then raise exception 'users_blocked'; end if;

  insert into public.chat_requests(card_id, sender_id, receiver_id, opening_message)
  values (card_uuid, auth.uid(), target_card.author_id, trim(opening_text))
  returning id into request_uuid;

  return request_uuid;
exception
  when unique_violation then raise exception 'request_already_exists';
end;
$$;

revoke all on function public.create_chat_request(uuid, text) from public;
grant execute on function public.create_chat_request(uuid, text) to authenticated;

create or replace function public.respond_to_chat_request(request_uuid uuid, decision text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  req public.chat_requests;
  room_uuid uuid;
begin
  select * into req from public.chat_requests where id = request_uuid for update;
  if req.id is null then raise exception 'request_not_found'; end if;
  if req.receiver_id <> auth.uid() then raise exception 'request_not_allowed'; end if;
  if req.status <> 'pending' then
    select id into room_uuid from public.chat_rooms where request_id = request_uuid;
    return room_uuid;
  end if;
  if decision not in ('accepted', 'declined') then raise exception 'invalid_decision'; end if;

  if decision = 'declined' then
    update public.chat_requests set status = 'declined', responded_at = now() where id = request_uuid;
    return null;
  end if;

  if exists (
    select 1 from public.blocks
    where (blocker_id = req.sender_id and blocked_id = req.receiver_id)
       or (blocker_id = req.receiver_id and blocked_id = req.sender_id)
  ) then raise exception 'users_blocked'; end if;

  update public.chat_requests set status = 'accepted', responded_at = now() where id = request_uuid;
  insert into public.chat_rooms(request_id) values (request_uuid) returning id into room_uuid;
  insert into public.chat_members(room_id, user_id)
  values (room_uuid, req.sender_id), (room_uuid, req.receiver_id);
  insert into public.messages(room_id, sender_id, body)
  values (room_uuid, req.sender_id, req.opening_message);
  return room_uuid;
end;
$$;

revoke all on function public.respond_to_chat_request(uuid, text) from public;
grant execute on function public.respond_to_chat_request(uuid, text) to authenticated;

create or replace function public.mark_room_read(room_uuid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chat_members set last_read_at = now()
  where room_id = room_uuid and user_id = auth.uid();
  if not found then raise exception 'room_not_allowed'; end if;
end;
$$;

revoke all on function public.mark_room_read(uuid) from public;
grant execute on function public.mark_room_read(uuid) to authenticated;

create or replace function public.my_chat_requests()
returns table (
  request_id uuid,
  direction text,
  request_status text,
  opening_message text,
  card_topic text,
  other_user_id uuid,
  other_nickname text,
  room_id uuid,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.id,
    case when r.sender_id = auth.uid() then 'sent' else 'received' end,
    r.status::text,
    r.opening_message,
    c.topic,
    case when r.sender_id = auth.uid() then r.receiver_id else r.sender_id end,
    other_profile.nickname,
    room.id,
    r.created_at
  from public.chat_requests r
  join public.conversation_cards c on c.id = r.card_id
  join public.profiles other_profile
    on other_profile.id = case when r.sender_id = auth.uid() then r.receiver_id else r.sender_id end
  left join public.chat_rooms room on room.request_id = r.id
  where auth.uid() in (r.sender_id, r.receiver_id)
  order by r.created_at desc;
$$;

revoke all on function public.my_chat_requests() from public;
grant execute on function public.my_chat_requests() to authenticated;

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
  join public.chat_members mine on mine.room_id = room.id and mine.user_id = auth.uid()
  join public.chat_members other_member on other_member.room_id = room.id and other_member.user_id <> auth.uid()
  join public.profiles other_profile on other_profile.id = other_member.user_id
  left join lateral (
    select body, created_at from public.messages latest
    where latest.room_id = room.id and latest.moderation_state = 'visible'
    order by latest.created_at desc limit 1
  ) last_msg on true
  where room.closed_at is null
  order by coalesce(last_msg.created_at, room.created_at) desc;
$$;

revoke all on function public.my_chat_rooms() from public;
grant execute on function public.my_chat_rooms() to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.chat_requests;
exception when duplicate_object then null;
end $$;

