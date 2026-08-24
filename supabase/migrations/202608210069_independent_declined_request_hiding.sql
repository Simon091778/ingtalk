-- Let each participant independently hide a declined request while preserving
-- the request row for the other participant, point history, and audit records.

alter table public.chat_requests
  add column if not exists sender_hidden_at timestamptz,
  add column if not exists receiver_hidden_at timestamptz;

create or replace function public.clear_withdrawn_chat_request_on_resend()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'pending' and (old.withdrawn_at is not null or old.status <> 'pending') then
    new.withdrawn_at := null;
    new.sender_hidden_at := null;
    new.receiver_hidden_at := null;
  end if;
  return new;
end;
$$;

create or replace function public.hide_declined_chat_request(request_uuid uuid)
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
  if auth.uid() not in (request.sender_id, request.receiver_id) then raise exception 'request_not_allowed'; end if;
  if request.status <> 'declined' then raise exception 'only_declined_request_can_be_hidden'; end if;

  if auth.uid() = request.sender_id then
    update public.chat_requests set sender_hidden_at = now() where id = request_uuid;
  else
    update public.chat_requests set receiver_hidden_at = now() where id = request_uuid;
  end if;
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
    and case when request.sender_id = auth.uid()
      then request.sender_hidden_at is null
      else request.receiver_hidden_at is null end
  order by request.created_at desc;
$$;

revoke all on function public.clear_withdrawn_chat_request_on_resend() from public, anon, authenticated;
revoke all on function public.hide_declined_chat_request(uuid) from public, anon, authenticated;
revoke all on function public.my_chat_requests() from public, anon, authenticated;
grant execute on function public.hide_declined_chat_request(uuid) to authenticated;
grant execute on function public.my_chat_requests() to authenticated;

notify pgrst, 'reload schema';
