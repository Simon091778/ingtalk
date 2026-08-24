-- Moderator-only operational views for requests, rooms and retained messages.

create or replace function public.admin_list_chat_requests(
  search_text text default null,
  result_limit integer default 300
)
returns table (
  request_id uuid,
  sender_id uuid,
  sender_nickname text,
  receiver_id uuid,
  receiver_nickname text,
  request_status text,
  opening_message text,
  source_topic text,
  board_post_id uuid,
  room_id uuid,
  room_closed_at timestamptz,
  created_at timestamptz,
  responded_at timestamptz,
  withdrawn_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare normalized_search text := trim(coalesce(search_text, ''));
begin
  if not public.admin_has_role('moderator') then raise exception 'admin_role_required'; end if;
  return query
  select request.id, request.sender_id, sender.nickname,
         request.receiver_id, receiver.nickname, request.status::text,
         request.opening_message, coalesce(card.topic, request.source_topic, '게시판 대화'),
         request.board_post_id, room.id, room.closed_at,
         request.created_at, request.responded_at, request.withdrawn_at
  from public.chat_requests request
  join public.profiles sender on sender.id = request.sender_id
  join public.profiles receiver on receiver.id = request.receiver_id
  left join public.conversation_cards card on card.id = request.card_id
  left join public.chat_rooms room on room.request_id = request.id
  where normalized_search = ''
     or request.id::text ilike '%' || normalized_search || '%'
     or request.sender_id::text ilike '%' || normalized_search || '%'
     or request.receiver_id::text ilike '%' || normalized_search || '%'
     or coalesce(room.id::text, '') ilike '%' || normalized_search || '%'
     or sender.nickname ilike '%' || normalized_search || '%'
     or receiver.nickname ilike '%' || normalized_search || '%'
  order by request.created_at desc
  limit least(greatest(coalesce(result_limit, 300), 1), 1000);
end;
$$;

create or replace function public.admin_list_chat_rooms(
  search_text text default null,
  result_limit integer default 300
)
returns table (
  room_id uuid,
  request_id uuid,
  sender_id uuid,
  sender_nickname text,
  receiver_id uuid,
  receiver_nickname text,
  room_status text,
  live_message_count bigint,
  backup_message_count bigint,
  deleted_message_count bigint,
  created_at timestamptz,
  closed_at timestamptz,
  last_message_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare normalized_search text := trim(coalesce(search_text, ''));
begin
  if not public.admin_has_role('moderator') then raise exception 'admin_role_required'; end if;
  return query
  select room.id, room.request_id, request.sender_id, sender.nickname,
         request.receiver_id, receiver.nickname,
         case when room.closed_at is null then 'active' else 'deleted' end,
         (select count(*) from public.messages message where message.room_id = room.id),
         (select count(*) from public.message_backups backup where backup.room_id = room.id),
         (select count(*) from public.message_backups backup where backup.room_id = room.id and backup.deleted_from_live_at is not null),
         room.created_at, room.closed_at,
         (select max(backup.message_created_at) from public.message_backups backup where backup.room_id = room.id)
  from public.chat_rooms room
  join public.chat_requests request on request.id = room.request_id
  join public.profiles sender on sender.id = request.sender_id
  join public.profiles receiver on receiver.id = request.receiver_id
  where normalized_search = ''
     or room.id::text ilike '%' || normalized_search || '%'
     or request.id::text ilike '%' || normalized_search || '%'
     or request.sender_id::text ilike '%' || normalized_search || '%'
     or request.receiver_id::text ilike '%' || normalized_search || '%'
     or sender.nickname ilike '%' || normalized_search || '%'
     or receiver.nickname ilike '%' || normalized_search || '%'
  order by coalesce(
    (select max(backup.message_created_at) from public.message_backups backup where backup.room_id = room.id),
    room.created_at
  ) desc
  limit least(greatest(coalesce(result_limit, 300), 1), 1000);
end;
$$;

revoke all on function public.admin_list_chat_requests(text, integer) from public, anon, authenticated;
revoke all on function public.admin_list_chat_rooms(text, integer) from public, anon, authenticated;
grant execute on function public.admin_list_chat_requests(text, integer) to authenticated;
grant execute on function public.admin_list_chat_rooms(text, integer) to authenticated;

notify pgrst, 'reload schema';
