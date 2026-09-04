-- Creating an open-chat room costs 100 points. Room creation, membership,
-- wallet debit, and ledger insertion succeed or roll back as one transaction.
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

  update public.point_wallets
  set balance = balance - 100, updated_at = now()
  where user_id = actor and balance >= 100;
  if not found then raise exception 'insufficient_points'; end if;
  insert into public.point_transactions(user_id, amount, reason, reference_id)
  values (actor, -100, 'open_chat_room_create', new_room);

  insert into public.open_chat_participants(room_id, user_id) values (new_room, actor);
  return new_room;
end; $$;

revoke all on function public.create_open_chat_room(text,text,text,integer,text,text[]) from public;
grant execute on function public.create_open_chat_room(text,text,text,integer,text,text[]) to authenticated;
notify pgrst, 'reload schema';
