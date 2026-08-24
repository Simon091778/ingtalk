-- Show the same rounded distance used by discovery cards in request lists.
-- Exact coordinates remain private.

drop function if exists public.my_chat_requests();
create function public.my_chat_requests()
returns table (
  request_id uuid, direction text, request_status text, opening_message text,
  card_topic text, other_user_id uuid, other_nickname text, board_alias text,
  room_id uuid, created_at timestamptz, distance_meters integer
)
language sql stable security definer set search_path = public, extensions as $$
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
    request.created_at,
    case when my_location.position is not null and other_location.position is not null
      then (round(extensions.st_distance(my_location.position, other_location.position) / 100.0) * 100)::integer
      else null end
  from public.chat_requests request
  left join public.conversation_cards card on card.id = request.card_id
  join public.profiles other_profile
    on other_profile.id = case when request.sender_id = auth.uid()
      then request.receiver_id else request.sender_id end
  left join public.chat_rooms room on room.request_id = request.id
  left join public.user_locations my_location on my_location.user_id = auth.uid()
  left join public.user_locations other_location
    on other_location.user_id = case when request.sender_id = auth.uid()
      then request.receiver_id else request.sender_id end
  where auth.uid() in (request.sender_id, request.receiver_id)
    and request.withdrawn_at is null
    and case when request.sender_id = auth.uid()
      then request.sender_hidden_at is null
      else request.receiver_hidden_at is null end
  order by request.created_at desc;
$$;

revoke all on function public.my_chat_requests() from public, anon, authenticated;
grant execute on function public.my_chat_requests() to authenticated;
notify pgrst, 'reload schema';
