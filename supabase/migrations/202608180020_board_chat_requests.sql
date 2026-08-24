-- Allow chat requests to originate from an anonymous board post or comment author.

alter table public.chat_requests add column if not exists board_post_id uuid;
alter table public.chat_requests add column if not exists source_topic text;
alter table public.chat_requests alter column card_id drop not null;

update public.chat_requests request
set source_topic = card.topic
from public.conversation_cards card
where card.id = request.card_id and request.source_topic is null;

alter table public.chat_requests drop constraint if exists chat_requests_card_id_sender_id_key;
alter table public.chat_requests drop constraint if exists chat_requests_source_check;
alter table public.chat_requests add constraint chat_requests_source_check
check ((card_id is not null)::integer + (board_post_id is not null)::integer = 1);

create unique index if not exists chat_requests_card_sender_unique
on public.chat_requests(card_id, sender_id) where card_id is not null;
create unique index if not exists chat_requests_board_sender_receiver_unique
on public.chat_requests(board_post_id, sender_id, receiver_id) where board_post_id is not null;

create or replace function public.create_board_chat_request(post_uuid uuid, receiver_uuid uuid, opening_text text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_post public.board_posts;
  request_uuid uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(opening_text)) < 2 or char_length(trim(opening_text)) > 200 then raise exception 'opening_message_length'; end if;
  if receiver_uuid = auth.uid() then raise exception 'cannot_request_self'; end if;

  select * into target_post from public.board_posts where id = post_uuid;
  if target_post.id is null then raise exception 'post_not_available'; end if;
  if not exists (select 1 from public.profiles where id = receiver_uuid and status = 'active') then raise exception 'receiver_not_available'; end if;
  if receiver_uuid <> target_post.author_id and not exists (
    select 1 from public.board_comments where post_id = post_uuid and author_id = receiver_uuid
  ) then raise exception 'receiver_not_in_post'; end if;
  if exists (
    select 1 from public.blocks
    where (blocker_id = auth.uid() and blocked_id = receiver_uuid)
       or (blocker_id = receiver_uuid and blocked_id = auth.uid())
  ) then raise exception 'users_blocked'; end if;

  insert into public.chat_requests(card_id, board_post_id, source_topic, sender_id, receiver_id, opening_message)
  values (null, post_uuid, left(target_post.body, 120), auth.uid(), receiver_uuid, trim(opening_text))
  returning id into request_uuid;
  return request_uuid;
exception when unique_violation then raise exception 'request_already_exists';
end;
$$;

revoke all on function public.create_board_chat_request(uuid, uuid, text) from public;
grant execute on function public.create_board_chat_request(uuid, uuid, text) to authenticated;

create or replace function public.my_chat_requests()
returns table (
  request_id uuid, direction text, request_status text, opening_message text,
  card_topic text, other_user_id uuid, other_nickname text, room_id uuid, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    r.id,
    case when r.sender_id = auth.uid() then 'sent' else 'received' end,
    r.status::text,
    r.opening_message,
    coalesce(c.topic, r.source_topic, '게시판 대화'),
    case when r.sender_id = auth.uid() then r.receiver_id else r.sender_id end,
    other_profile.nickname,
    room.id,
    r.created_at
  from public.chat_requests r
  left join public.conversation_cards c on c.id = r.card_id
  join public.profiles other_profile on other_profile.id = case when r.sender_id = auth.uid() then r.receiver_id else r.sender_id end
  left join public.chat_rooms room on room.request_id = r.id
  where auth.uid() in (r.sender_id, r.receiver_id)
  order by r.created_at desc;
$$;

revoke all on function public.my_chat_requests() from public;
grant execute on function public.my_chat_requests() to authenticated;
notify pgrst, 'reload schema';
