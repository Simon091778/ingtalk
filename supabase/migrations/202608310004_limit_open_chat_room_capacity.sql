-- New chat rooms support capacities from 2 through 20. Existing rooms are unchanged.
create or replace function public.create_open_chat_room(
  room_title text, room_description text, room_category text,
  room_max_members integer, room_region text default null, room_tags text[] default '{}'
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid := public.current_account_id(); new_room uuid;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  perform public.require_account_access();
  if not exists (select 1 from public.profiles where id = actor and status = 'active') then
    raise exception 'account_not_active';
  end if;
  if char_length(trim(coalesce(room_title, ''))) not between 2 and 40 then raise exception 'invalid_room_title'; end if;
  if char_length(coalesce(room_description, '')) > 120 then raise exception 'invalid_room_description'; end if;
  if room_category is null or room_category not in ('수다', '취미', '친구', '연애', '고민상담', '지역') then raise exception 'invalid_room_category'; end if;
  if room_max_members not between 2 and 20 then raise exception 'invalid_max_members'; end if;
  if cardinality(coalesce(room_tags, '{}')) > 10 then raise exception 'too_many_tags'; end if;

  insert into public.open_chat_rooms(title, description, category, region, tags, owner_user_id, max_members)
  values (trim(room_title), trim(coalesce(room_description, '')), room_category,
          nullif(trim(coalesce(room_region, '')), ''), coalesce(room_tags, '{}'), actor, room_max_members)
  returning id into new_room;
  insert into public.open_chat_participants(room_id, user_id) values (new_room, actor);
  return new_room;
end; $$;
