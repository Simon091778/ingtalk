-- Keep board identities anonymous until a request is accepted, then retain the alias as context.

alter table public.chat_requests
  add column if not exists sender_board_alias text,
  add column if not exists receiver_board_alias text;
alter table public.chat_rooms
  add column if not exists board_sender_id uuid references public.profiles(id) on delete set null,
  add column if not exists board_sender_alias text,
  add column if not exists board_receiver_id uuid references public.profiles(id) on delete set null,
  add column if not exists board_receiver_alias text;

update public.chat_requests r set
  sender_board_alias = coalesce(
    (select c.anonymous_name from public.board_comments c where c.post_id = r.board_post_id and c.author_id = r.sender_id order by c.created_at limit 1),
    (select p.anonymous_name from public.board_posts p where p.id = r.board_post_id and p.author_id = r.sender_id),
    public.generate_board_alias((select gender from public.profiles where id = r.sender_id))
  ),
  receiver_board_alias = coalesce(
    (select p.anonymous_name from public.board_posts p where p.id = r.board_post_id and p.author_id = r.receiver_id),
    (select c.anonymous_name from public.board_comments c where c.post_id = r.board_post_id and c.author_id = r.receiver_id order by c.created_at limit 1),
    public.generate_board_alias((select gender from public.profiles where id = r.receiver_id))
  )
where r.board_post_id is not null
  and (r.sender_board_alias is null or r.receiver_board_alias is null);

update public.chat_rooms room set
  board_sender_id = request.sender_id, board_sender_alias = request.sender_board_alias,
  board_receiver_id = request.receiver_id, board_receiver_alias = request.receiver_board_alias
from public.chat_requests request
where room.request_id = request.id and request.board_post_id is not null;

create or replace function public.create_board_chat_request(post_uuid uuid, receiver_uuid uuid, opening_text text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  target_post public.board_posts; request_uuid uuid := gen_random_uuid(); existing_room_uuid uuid;
  sender_alias text; receiver_alias text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(opening_text)) < 2 or char_length(trim(opening_text)) > 200 then raise exception 'opening_message_length'; end if;
  if receiver_uuid = auth.uid() then raise exception 'cannot_request_self'; end if;
  select * into target_post from public.board_posts where id = post_uuid;
  if target_post.id is null then raise exception 'post_not_available'; end if;
  if not exists (select 1 from public.profiles where id = receiver_uuid and status = 'active') then raise exception 'receiver_not_available'; end if;
  if receiver_uuid <> target_post.author_id and not exists (select 1 from public.board_comments where post_id = post_uuid and author_id = receiver_uuid) then raise exception 'receiver_not_in_post'; end if;
  if exists (select 1 from public.blocks where (blocker_id = auth.uid() and blocked_id = receiver_uuid) or (blocker_id = receiver_uuid and blocked_id = auth.uid())) then raise exception 'users_blocked'; end if;

  select coalesce(
    (select anonymous_name from public.board_comments where post_id = post_uuid and author_id = auth.uid() order by created_at limit 1),
    (select anonymous_name from public.board_posts where id = post_uuid and author_id = auth.uid()),
    public.generate_board_alias((select gender from public.profiles where id = auth.uid()))
  ) into sender_alias;
  select coalesce(
    (select anonymous_name from public.board_posts where id = post_uuid and author_id = receiver_uuid),
    (select anonymous_name from public.board_comments where post_id = post_uuid and author_id = receiver_uuid order by created_at limit 1),
    public.generate_board_alias((select gender from public.profiles where id = receiver_uuid))
  ) into receiver_alias;

  perform pg_advisory_xact_lock(hashtextextended(least(auth.uid()::text, receiver_uuid::text) || ':' || greatest(auth.uid()::text, receiver_uuid::text), 0));
  select room.id into existing_room_uuid from public.chat_rooms room
  join public.chat_members mine on mine.room_id = room.id and mine.user_id = auth.uid()
  join public.chat_members other_member on other_member.room_id = room.id and other_member.user_id = receiver_uuid
  where room.closed_at is null order by room.created_at limit 1;

  update public.point_wallets set balance = balance - 100, updated_at = now() where user_id = auth.uid() and balance >= 100;
  if not found then raise exception 'insufficient_points'; end if;
  insert into public.point_transactions(user_id, amount, reason, reference_id) values (auth.uid(), -100, 'chat_request', request_uuid);

  if existing_room_uuid is not null then
    update public.chat_members set hidden_at = null where room_id = existing_room_uuid;
    update public.chat_rooms set board_sender_id = auth.uid(), board_sender_alias = sender_alias,
      board_receiver_id = receiver_uuid, board_receiver_alias = receiver_alias where id = existing_room_uuid;
    insert into public.messages(room_id, sender_id, body) values (existing_room_uuid, auth.uid(), trim(opening_text));
    return existing_room_uuid;
  end if;

  insert into public.chat_requests(id, card_id, board_post_id, source_topic, sender_id, receiver_id, opening_message, sender_board_alias, receiver_board_alias)
  values (request_uuid, null, post_uuid, left(target_post.body, 120), auth.uid(), receiver_uuid, trim(opening_text), sender_alias, receiver_alias);
  return request_uuid;
exception when unique_violation then raise exception 'request_already_exists';
end;
$$;

drop function if exists public.my_chat_requests();
create function public.my_chat_requests()
returns table (
  request_id uuid, direction text, request_status text, opening_message text,
  card_topic text, other_user_id uuid, other_nickname text, board_alias text,
  room_id uuid, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select r.id,
    case when r.sender_id = auth.uid() then 'sent' else 'received' end,
    r.status::text, r.opening_message, coalesce(c.topic, r.source_topic, '게시판 대화'),
    case when r.sender_id = auth.uid() then r.receiver_id else r.sender_id end,
    case when r.board_post_id is not null and r.status = 'pending' then null else other_profile.nickname end,
    case when r.board_post_id is null then null
      when r.sender_id = auth.uid() then r.receiver_board_alias else r.sender_board_alias end,
    room.id, r.created_at
  from public.chat_requests r
  left join public.conversation_cards c on c.id = r.card_id
  join public.profiles other_profile on other_profile.id = case when r.sender_id = auth.uid() then r.receiver_id else r.sender_id end
  left join public.chat_rooms room on room.request_id = r.id
  where auth.uid() in (r.sender_id, r.receiver_id)
  order by r.created_at desc;
$$;

drop function if exists public.my_chat_rooms();
create function public.my_chat_rooms()
returns table (
  room_id uuid, other_user_id uuid, other_nickname text, other_board_alias text,
  other_avatar_url text, other_gender text, other_birth_year integer,
  last_message text, last_message_at timestamptz, unread_count bigint
)
language sql stable security definer set search_path = public as $$
  select room.id, other_member.user_id, other_profile.nickname,
    case when room.board_sender_id = other_member.user_id then room.board_sender_alias
         when room.board_receiver_id = other_member.user_id then room.board_receiver_alias end,
    other_profile.avatar_url, other_profile.gender, other_profile.birth_year, last_msg.body,
    coalesce(last_msg.created_at, room.created_at),
    (select count(*) from public.messages unread where unread.room_id = room.id
      and unread.sender_id <> auth.uid() and unread.created_at > coalesce(mine.last_read_at, room.created_at)
      and unread.moderation_state = 'visible')
  from public.chat_rooms room
  join public.chat_members mine on mine.room_id = room.id and mine.user_id = auth.uid() and mine.hidden_at is null
  join public.chat_members other_member on other_member.room_id = room.id and other_member.user_id <> auth.uid()
  join public.profiles other_profile on other_profile.id = other_member.user_id
  left join lateral (select body, created_at from public.messages latest where latest.room_id = room.id
    and latest.moderation_state = 'visible' order by latest.created_at desc limit 1) last_msg on true
  where room.closed_at is null and not exists (select 1 from public.blocks block
    where (block.blocker_id = auth.uid() and block.blocked_id = other_member.user_id)
       or (block.blocker_id = other_member.user_id and block.blocked_id = auth.uid()))
  order by coalesce(last_msg.created_at, room.created_at) desc;
$$;

-- Copy board aliases into a newly accepted room at the moment identities are revealed.
create or replace function public.capture_board_alias_on_room()
returns trigger language plpgsql security definer set search_path = public as $$
declare request public.chat_requests;
begin
  select * into request from public.chat_requests where id = new.request_id;
  if request.board_post_id is not null then
    new.board_sender_id := request.sender_id;
    new.board_sender_alias := request.sender_board_alias;
    new.board_receiver_id := request.receiver_id;
    new.board_receiver_alias := request.receiver_board_alias;
  end if;
  return new;
end;
$$;
drop trigger if exists capture_board_alias_before_room on public.chat_rooms;
create trigger capture_board_alias_before_room before insert on public.chat_rooms
for each row execute function public.capture_board_alias_on_room();

revoke all on function public.create_board_chat_request(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.my_chat_requests() from public, anon, authenticated;
revoke all on function public.my_chat_rooms() from public, anon, authenticated;
revoke all on function public.capture_board_alias_on_room() from public, anon, authenticated;
grant execute on function public.create_board_chat_request(uuid, uuid, text) to authenticated;
grant execute on function public.my_chat_requests() to authenticated;
grant execute on function public.my_chat_rooms() to authenticated;

notify pgrst, 'reload schema';
