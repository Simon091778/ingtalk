-- Persist membership notices in the existing system-message history.
-- No schema, policy, kick, deletion, expiration or push-policy changes.
-- CREATE OR REPLACE preserves the existing authenticated-only RPC grants.

create or replace function public.leave_open_chat_room(room_uuid uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid := public.current_account_id(); target public.open_chat_rooms; successor uuid; successor_name text; actor_name text;
begin
  perform public.require_account_access();
  if actor is null then raise exception 'authentication_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  select * into target from public.open_chat_rooms where id = room_uuid for update;
  -- A completed leave (including a closed last-member room) is retry-safe.
  if not exists (select 1 from public.open_chat_participants where room_id = room_uuid and user_id = actor) then return null; end if;
  if target.id is null or target.status <> 'active' then raise exception 'room_not_active'; end if;
  select nickname into actor_name from public.profiles where id = actor;

  if target.owner_user_id <> actor then
    delete from public.open_chat_participants where room_id = room_uuid and user_id = actor;
    insert into public.open_chat_messages(room_id, message_type, content, created_at)
    values (room_uuid, 'system', actor_name || '님이 퇴장했습니다.', clock_timestamp());
    return null;
  end if;

  select participant.user_id, profile.nickname into successor, successor_name
  from public.open_chat_participants participant
  join public.profiles profile on profile.id = participant.user_id and profile.status = 'active'
  where participant.room_id = room_uuid and participant.user_id <> actor
    and not exists (select 1 from public.open_chat_room_bans ban where ban.room_id = room_uuid and ban.user_id = participant.user_id)
  order by random() limit 1;

  if successor is null then
    update public.open_chat_rooms
      set status = 'closed', owner_user_id = null, closed_at = now(), closed_reason = 'empty_room', updated_at = now()
      where id = room_uuid;
    delete from public.open_chat_participants where room_id = room_uuid and user_id = actor;
    return null;
  end if;

  update public.open_chat_rooms set owner_user_id = successor, updated_at = now() where id = room_uuid;
  delete from public.open_chat_participants where room_id = room_uuid and user_id = actor;
  insert into public.open_chat_messages(room_id, message_type, content, created_at)
  values (room_uuid, 'system', actor_name || '님이 퇴장했습니다.', clock_timestamp());
  insert into public.open_chat_messages(room_id, message_type, content, created_at)
  values (room_uuid, 'system', successor_name || '님이 새로운 방장이 되었습니다.', clock_timestamp());
  return successor;
end; $$;

create or replace function public.join_open_chat_room(room_uuid uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid := public.current_account_id(); target public.open_chat_rooms;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  perform public.require_account_access();
  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  select * into target from public.open_chat_rooms where id = room_uuid for update;
  if not found or target.status <> 'active' then raise exception 'room_not_active'; end if;
  if not exists (select 1 from public.profiles where id = actor and status = 'active') then raise exception 'account_not_active'; end if;
  if exists (select 1 from public.open_chat_room_bans where room_id = room_uuid and user_id = actor) then raise exception 'room_banned'; end if;
  if exists (select 1 from public.open_chat_participants where room_id = room_uuid and user_id = actor) then return; end if;
  if exists (select 1 from public.open_chat_rooms where owner_user_id = actor and status = 'active' and id <> room_uuid) then
    raise exception 'owner_must_leave_room_first';
  end if;
  if (select count(*) from public.open_chat_participants where room_id = room_uuid) >= target.max_members then raise exception 'room_full'; end if;

  -- Choosing another room really removes the previous membership. This is not
  -- a screen-close event; bans, profile deletion and room expiry do not use it.
  with departed as (
    delete from public.open_chat_participants where user_id = actor returning room_id
  )
  insert into public.open_chat_messages(room_id, message_type, content, created_at)
  select departed.room_id, 'system', profile.nickname || '님이 퇴장했습니다.', clock_timestamp()
  from departed join public.open_chat_rooms room on room.id = departed.room_id and room.status = 'active'
  join public.profiles profile on profile.id = actor;
  insert into public.open_chat_participants(room_id, user_id) values (room_uuid, actor);
  insert into public.open_chat_messages(room_id, message_type, content, created_at)
  select room_uuid, 'system', nickname || '님이 입장했습니다.', clock_timestamp() from public.profiles where id = actor;
end; $$;

create or replace function public.create_open_chat_room(
  room_title text, room_description text, room_category text,
  room_max_members integer, room_region text default null, room_tags text[] default '{}'
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid := public.current_account_id(); new_room uuid;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  perform public.require_account_access();
  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  if not exists (select 1 from public.profiles where id = actor and status = 'active') then
    raise exception 'account_not_active';
  end if;
  if char_length(trim(coalesce(room_title, ''))) not between 2 and 40 then raise exception 'invalid_room_title'; end if;
  if char_length(coalesce(room_description, '')) > 120 then raise exception 'invalid_room_description'; end if;
  if room_category is null or room_category not in ('수다', '취미', '친구', '연애', '고민상담', '지역') then raise exception 'invalid_room_category'; end if;
  if room_max_members not between 2 and 20 then raise exception 'invalid_max_members'; end if;
  if cardinality(coalesce(room_tags, '{}')) > 10 then raise exception 'too_many_tags'; end if;
  if exists (select 1 from public.open_chat_rooms where owner_user_id = actor and status = 'active') then
    raise exception 'owner_must_leave_room_first';
  end if;

  -- Choosing another room really removes the previous membership. This is not
  -- a screen-close event; bans, profile deletion and room expiry do not use it.
  with departed as (
    delete from public.open_chat_participants where user_id = actor returning room_id
  )
  insert into public.open_chat_messages(room_id, message_type, content, created_at)
  select departed.room_id, 'system', profile.nickname || '님이 퇴장했습니다.', clock_timestamp()
  from departed join public.open_chat_rooms room on room.id = departed.room_id and room.status = 'active'
  join public.profiles profile on profile.id = actor;
  insert into public.open_chat_rooms(title, description, category, region, tags, owner_user_id, max_members)
  values (trim(room_title), trim(coalesce(room_description, '')), room_category,
          nullif(trim(coalesce(room_region, '')), ''), coalesce(room_tags, '{}'), actor, room_max_members)
  returning id into new_room;

  update public.point_wallets
  set balance = balance - 100, updated_at = now()
  where user_id = actor and balance >= 100;
  if not found then raise exception 'insufficient_points'; end if;
  insert into public.point_transactions(user_id, amount, reason, reference_id)
  values (actor, -100, 'open_chat_room_create', new_room);

  insert into public.open_chat_participants(room_id, user_id) values (new_room, actor);
  insert into public.open_chat_messages(room_id, message_type, content, created_at)
  select new_room, 'system', nickname || '님이 입장했습니다.', clock_timestamp() from public.profiles where id = actor;
  return new_room;
end; $$;

notify pgrst, 'reload schema';
