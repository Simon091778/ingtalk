-- Senders may withdraw a non-accepted request. Keep the row for point/audit
-- integrity, but remove it from both participants' request lists.

alter table public.chat_requests
  add column if not exists withdrawn_at timestamptz;

create index if not exists chat_requests_visible_participants_idx
  on public.chat_requests(sender_id, receiver_id, created_at desc)
  where withdrawn_at is null;

create or replace function public.clear_withdrawn_chat_request_on_resend()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'pending' and old.withdrawn_at is not null then
    new.withdrawn_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_withdrawn_chat_request_on_resend on public.chat_requests;
create trigger clear_withdrawn_chat_request_on_resend
before update on public.chat_requests
for each row execute function public.clear_withdrawn_chat_request_on_resend();

create or replace function public.withdraw_chat_request(request_uuid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  request public.chat_requests;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;

  select * into request
  from public.chat_requests
  where id = request_uuid
  for update;

  if request.id is null then raise exception 'request_not_found'; end if;
  if request.sender_id <> auth.uid() then raise exception 'request_not_allowed'; end if;
  if request.status = 'accepted' then raise exception 'accepted_request_not_withdrawable'; end if;

  update public.chat_requests
  set status = 'cancelled', responded_at = now(), withdrawn_at = now()
  where id = request_uuid;
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
  select request.id,
    case when request.sender_id = auth.uid() then 'sent' else 'received' end,
    request.status::text,
    request.opening_message,
    coalesce(card.topic, request.source_topic, '게시판 대화'),
    case when request.sender_id = auth.uid() then request.receiver_id else request.sender_id end,
    case when request.board_post_id is not null and request.status = 'pending'
      then null else other_profile.nickname end,
    case when request.board_post_id is null then null
      when request.sender_id = auth.uid() then request.receiver_board_alias
      else request.sender_board_alias end,
    room.id,
    request.created_at
  from public.chat_requests request
  left join public.conversation_cards card on card.id = request.card_id
  join public.profiles other_profile
    on other_profile.id = case when request.sender_id = auth.uid()
      then request.receiver_id else request.sender_id end
  left join public.chat_rooms room on room.request_id = request.id
  where auth.uid() in (request.sender_id, request.receiver_id)
    and request.withdrawn_at is null
  order by request.created_at desc;
$$;

revoke all on function public.clear_withdrawn_chat_request_on_resend() from public, anon, authenticated;
revoke all on function public.withdraw_chat_request(uuid) from public, anon, authenticated;
revoke all on function public.my_chat_requests() from public, anon, authenticated;
grant execute on function public.withdraw_chat_request(uuid) to authenticated;
grant execute on function public.my_chat_requests() to authenticated;

notify pgrst, 'reload schema';
