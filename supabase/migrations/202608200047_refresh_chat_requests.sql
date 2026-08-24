-- Re-sending a request refreshes the existing sent request instead of creating
-- another row. Each send still consumes the normal 100 points.

create or replace function public.create_chat_request(card_uuid uuid, opening_text text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  target_card public.conversation_cards;
  request_uuid uuid;
  point_reference_uuid uuid := gen_random_uuid();
  existing_room_uuid uuid;
  refresh_existing boolean := false;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(opening_text)) < 2 or char_length(trim(opening_text)) > 200 then raise exception 'opening_message_length'; end if;

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

  perform pg_advisory_xact_lock(hashtextextended(
    least(auth.uid()::text, target_card.author_id::text) || ':' ||
    greatest(auth.uid()::text, target_card.author_id::text), 0
  ));

  select room.id into existing_room_uuid
  from public.chat_rooms room
  join public.chat_members mine on mine.room_id = room.id and mine.user_id = auth.uid()
  join public.chat_members other_member on other_member.room_id = room.id and other_member.user_id = target_card.author_id
  where room.closed_at is null
  order by room.created_at
  limit 1;

  if existing_room_uuid is null then
    select request.id into request_uuid
    from public.chat_requests request
    where request.card_id = card_uuid and request.sender_id = auth.uid()
    for update;
    refresh_existing := request_uuid is not null;
  end if;

  if request_uuid is null then request_uuid := gen_random_uuid(); end if;

  update public.point_wallets
  set balance = balance - 100, updated_at = now()
  where user_id = auth.uid() and balance >= 100;
  if not found then raise exception 'insufficient_points'; end if;

  insert into public.point_transactions(user_id, amount, reason, reference_id)
  values (auth.uid(), -100, 'chat_request', point_reference_uuid);

  if existing_room_uuid is not null then
    update public.chat_members set hidden_at = null where room_id = existing_room_uuid;
    insert into public.messages(room_id, sender_id, body)
    values (existing_room_uuid, auth.uid(), trim(opening_text));
    return existing_room_uuid;
  end if;

  if refresh_existing then
    update public.chat_requests
    set receiver_id = target_card.author_id,
        opening_message = trim(opening_text),
        status = 'pending',
        responded_at = null,
        created_at = now()
    where id = request_uuid;
  else
    insert into public.chat_requests(id, card_id, sender_id, receiver_id, opening_message)
    values (request_uuid, card_uuid, auth.uid(), target_card.author_id, trim(opening_text));
  end if;

  return request_uuid;
end;
$$;

create or replace function public.create_board_chat_request(post_uuid uuid, receiver_uuid uuid, opening_text text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  target_post public.board_posts;
  request_uuid uuid;
  point_reference_uuid uuid := gen_random_uuid();
  existing_room_uuid uuid;
  sender_alias text;
  receiver_alias text;
  refresh_existing boolean := false;
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

  perform pg_advisory_xact_lock(hashtextextended(
    least(auth.uid()::text, receiver_uuid::text) || ':' ||
    greatest(auth.uid()::text, receiver_uuid::text), 0
  ));

  select room.id into existing_room_uuid
  from public.chat_rooms room
  join public.chat_members mine on mine.room_id = room.id and mine.user_id = auth.uid()
  join public.chat_members other_member on other_member.room_id = room.id and other_member.user_id = receiver_uuid
  where room.closed_at is null
  order by room.created_at
  limit 1;

  if existing_room_uuid is null then
    select request.id into request_uuid
    from public.chat_requests request
    where request.board_post_id = post_uuid
      and request.sender_id = auth.uid()
      and request.receiver_id = receiver_uuid
    for update;
    refresh_existing := request_uuid is not null;
  end if;

  if request_uuid is null then request_uuid := gen_random_uuid(); end if;

  update public.point_wallets
  set balance = balance - 100, updated_at = now()
  where user_id = auth.uid() and balance >= 100;
  if not found then raise exception 'insufficient_points'; end if;

  insert into public.point_transactions(user_id, amount, reason, reference_id)
  values (auth.uid(), -100, 'chat_request', point_reference_uuid);

  if existing_room_uuid is not null then
    update public.chat_members set hidden_at = null where room_id = existing_room_uuid;
    update public.chat_rooms
    set board_sender_id = auth.uid(), board_sender_alias = sender_alias,
        board_receiver_id = receiver_uuid, board_receiver_alias = receiver_alias
    where id = existing_room_uuid;
    insert into public.messages(room_id, sender_id, body)
    values (existing_room_uuid, auth.uid(), trim(opening_text));
    return existing_room_uuid;
  end if;

  if refresh_existing then
    update public.chat_requests
    set source_topic = left(target_post.body, 120),
        opening_message = trim(opening_text),
        sender_board_alias = sender_alias,
        receiver_board_alias = receiver_alias,
        status = 'pending',
        responded_at = null,
        created_at = now()
    where id = request_uuid;
  else
    insert into public.chat_requests(
      id, card_id, board_post_id, source_topic, sender_id, receiver_id,
      opening_message, sender_board_alias, receiver_board_alias
    ) values (
      request_uuid, null, post_uuid, left(target_post.body, 120), auth.uid(), receiver_uuid,
      trim(opening_text), sender_alias, receiver_alias
    );
  end if;

  return request_uuid;
end;
$$;

-- A refreshed request can be linked to a previously closed room. Reuse that
-- room when the receiver accepts instead of trying to insert a duplicate room.
create or replace function public.respond_to_chat_request(request_uuid uuid, decision text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  req public.chat_requests;
  room_uuid uuid;
begin
  select * into req from public.chat_requests where id = request_uuid for update;
  if req.id is null then raise exception 'request_not_found'; end if;
  if req.receiver_id <> auth.uid() then raise exception 'request_not_allowed'; end if;
  if req.status <> 'pending' then
    select room.id into room_uuid
    from public.chat_rooms room
    join public.chat_members first_member on first_member.room_id = room.id and first_member.user_id = req.sender_id
    join public.chat_members second_member on second_member.room_id = room.id and second_member.user_id = req.receiver_id
    where room.closed_at is null order by room.created_at limit 1;
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

  perform pg_advisory_xact_lock(hashtextextended(
    least(req.sender_id::text, req.receiver_id::text) || ':' ||
    greatest(req.sender_id::text, req.receiver_id::text), 0
  ));

  select room.id into room_uuid
  from public.chat_rooms room
  join public.chat_members first_member on first_member.room_id = room.id and first_member.user_id = req.sender_id
  join public.chat_members second_member on second_member.room_id = room.id and second_member.user_id = req.receiver_id
  where room.closed_at is null order by room.created_at limit 1;

  if room_uuid is null then
    select id into room_uuid from public.chat_rooms where request_id = request_uuid for update;
  end if;

  update public.chat_requests set status = 'accepted', responded_at = now() where id = request_uuid;

  if room_uuid is null then
    insert into public.chat_rooms(request_id) values (request_uuid) returning id into room_uuid;
    insert into public.chat_members(room_id, user_id)
    values (room_uuid, req.sender_id), (room_uuid, req.receiver_id);
  else
    update public.chat_rooms set closed_at = null where id = room_uuid;
    update public.chat_members set hidden_at = null where room_id = room_uuid;
  end if;

  insert into public.messages(room_id, sender_id, body)
  values (room_uuid, req.sender_id, req.opening_message);
  return room_uuid;
end;
$$;

revoke all on function public.create_chat_request(uuid, text) from public, anon, authenticated;
revoke all on function public.create_board_chat_request(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.respond_to_chat_request(uuid, text) from public, anon, authenticated;
grant execute on function public.create_chat_request(uuid, text) to authenticated;
grant execute on function public.create_board_chat_request(uuid, uuid, text) to authenticated;
grant execute on function public.respond_to_chat_request(uuid, text) to authenticated;

notify pgrst, 'reload schema';
