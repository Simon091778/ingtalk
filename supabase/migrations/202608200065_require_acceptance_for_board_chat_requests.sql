-- Board-originated chat requests must always remain pending until the receiver
-- explicitly accepts them. Never deliver a board opening message directly to
-- an existing room because doing so bypasses the anonymous request boundary.

create or replace function public.create_board_chat_request(
  post_uuid uuid,
  receiver_uuid uuid,
  opening_text text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_post public.board_posts;
  request_uuid uuid;
  point_reference_uuid uuid := gen_random_uuid();
  sender_alias text;
  receiver_alias text;
  refresh_existing boolean := false;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(opening_text)) < 2 or char_length(trim(opening_text)) > 200 then
    raise exception 'opening_message_length';
  end if;
  if receiver_uuid = auth.uid() then raise exception 'cannot_request_self'; end if;

  select * into target_post from public.board_posts where id = post_uuid;
  if target_post.id is null then raise exception 'post_not_available'; end if;
  if not exists (
    select 1 from public.profiles where id = receiver_uuid and status = 'active'
  ) then raise exception 'receiver_not_available'; end if;
  if receiver_uuid <> target_post.author_id and not exists (
    select 1 from public.board_comments
    where post_id = post_uuid and author_id = receiver_uuid
  ) then raise exception 'receiver_not_in_post'; end if;
  if exists (
    select 1 from public.blocks
    where (blocker_id = auth.uid() and blocked_id = receiver_uuid)
       or (blocker_id = receiver_uuid and blocked_id = auth.uid())
  ) then raise exception 'users_blocked'; end if;

  select coalesce(
    (select anonymous_name from public.board_comments
      where post_id = post_uuid and author_id = auth.uid()
      order by created_at limit 1),
    (select anonymous_name from public.board_posts
      where id = post_uuid and author_id = auth.uid()),
    public.generate_board_alias((select gender from public.profiles where id = auth.uid()))
  ) into sender_alias;

  select coalesce(
    (select anonymous_name from public.board_posts
      where id = post_uuid and author_id = receiver_uuid),
    (select anonymous_name from public.board_comments
      where post_id = post_uuid and author_id = receiver_uuid
      order by created_at limit 1),
    public.generate_board_alias((select gender from public.profiles where id = receiver_uuid))
  ) into receiver_alias;

  perform pg_advisory_xact_lock(hashtextextended(
    least(auth.uid()::text, receiver_uuid::text) || ':' ||
    greatest(auth.uid()::text, receiver_uuid::text), 0
  ));

  select request.id into request_uuid
  from public.chat_requests request
  where request.board_post_id = post_uuid
    and request.sender_id = auth.uid()
    and request.receiver_id = receiver_uuid
  for update;
  refresh_existing := request_uuid is not null;

  if request_uuid is null then request_uuid := gen_random_uuid(); end if;

  update public.point_wallets
  set balance = balance - 100, updated_at = now()
  where user_id = auth.uid() and balance >= 100;
  if not found then raise exception 'insufficient_points'; end if;

  insert into public.point_transactions(user_id, amount, reason, reference_id)
  values (auth.uid(), -100, 'chat_request', point_reference_uuid);

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
      request_uuid, null, post_uuid, left(target_post.body, 120),
      auth.uid(), receiver_uuid, trim(opening_text), sender_alias, receiver_alias
    );
  end if;

  return request_uuid;
end;
$$;

revoke all on function public.create_board_chat_request(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.create_board_chat_request(uuid, uuid, text)
to authenticated;

notify pgrst, 'reload schema';
