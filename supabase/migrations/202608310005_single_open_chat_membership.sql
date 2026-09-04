-- Each account may actively participate in only one chat room. Joining or
-- creating another room automatically leaves prior non-owner memberships.
-- Room owners must leave their owned room explicitly so ownership transfer or
-- room closure remains visible and intentional.

create or replace function public.enforce_single_open_chat_membership()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select count(*) from public.open_chat_participants where user_id = new.user_id) > 1 then
    raise exception 'single_room_membership_required';
  end if;
  return new;
end; $$;

drop trigger if exists enforce_single_open_chat_membership on public.open_chat_participants;
create constraint trigger enforce_single_open_chat_membership
after insert or update of user_id on public.open_chat_participants
deferrable initially deferred
for each row execute function public.enforce_single_open_chat_membership();

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

  delete from public.open_chat_participants where user_id = actor;
  insert into public.open_chat_rooms(title, description, category, region, tags, owner_user_id, max_members)
  values (trim(room_title), trim(coalesce(room_description, '')), room_category,
          nullif(trim(coalesce(room_region, '')), ''), coalesce(room_tags, '{}'), actor, room_max_members)
  returning id into new_room;
  insert into public.open_chat_participants(room_id, user_id) values (new_room, actor);
  return new_room;
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

  delete from public.open_chat_participants where user_id = actor;
  insert into public.open_chat_participants(room_id, user_id) values (room_uuid, actor);
end; $$;

revoke all on function public.enforce_single_open_chat_membership() from public;
