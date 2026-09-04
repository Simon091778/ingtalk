-- Extend open chat into the existing private-request and moderation systems.

alter table public.open_chat_rooms
  add column notice text not null default '' check (char_length(notice) <= 500);

alter table public.open_chat_room_bans drop constraint if exists open_chat_room_bans_banned_by_fkey;
alter table public.open_chat_room_bans alter column banned_by drop not null;
alter table public.open_chat_room_bans add constraint open_chat_room_bans_banned_by_fkey
  foreign key (banned_by) references public.profiles(id) on delete set null;
-- Text senders are always enforced at insert time by RLS. Allow the profile FK
-- to null the sender later so account deletion can retain moderated history.
alter table public.open_chat_messages drop constraint if exists open_chat_messages_check;

create or replace function public.prepare_open_chat_profile_deletion()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare owned_room record; successor uuid; successor_name text;
begin
  for owned_room in select id from public.open_chat_rooms
    where owner_user_id = old.id and status = 'active' order by id for update
  loop
    successor := null; successor_name := null;
    select participant.user_id, profile.nickname into successor, successor_name
    from public.open_chat_participants participant
    join public.profiles profile on profile.id = participant.user_id and profile.status = 'active'
    where participant.room_id = owned_room.id and participant.user_id <> old.id
      and not exists (select 1 from public.open_chat_room_bans ban where ban.room_id = owned_room.id and ban.user_id = participant.user_id)
    order by random() limit 1;
    if successor is null then
      update public.open_chat_rooms set status='closed', owner_user_id=null, closed_at=now(),
        closed_reason='owner_account_deleted', updated_at=now() where id=owned_room.id;
    else
      update public.open_chat_rooms set owner_user_id=successor, updated_at=now() where id=owned_room.id;
      insert into public.open_chat_messages(room_id,message_type,content)
      values (owned_room.id,'system',successor_name || '님이 새로운 방장이 되었습니다.');
    end if;
    delete from public.open_chat_participants where room_id=owned_room.id and user_id=old.id;
  end loop;
  return old;
end; $$;
drop trigger if exists prepare_open_chat_profile_deletion on public.profiles;
create trigger prepare_open_chat_profile_deletion before delete on public.profiles
for each row execute function public.prepare_open_chat_profile_deletion();

alter table public.chat_requests
  add column open_chat_room_id uuid references public.open_chat_rooms(id) on delete restrict;
alter table public.chat_requests drop constraint if exists chat_requests_source_check;
alter table public.chat_requests add constraint chat_requests_source_check check (
  (card_id is not null)::integer
  + (board_post_id is not null)::integer
  + (open_chat_room_id is not null)::integer = 1
);
create unique index chat_requests_open_chat_sender_receiver_unique
  on public.chat_requests(open_chat_room_id, sender_id, receiver_id)
  where open_chat_room_id is not null;

alter table public.reports
  add column open_chat_room_id uuid references public.open_chat_rooms(id) on delete set null,
  add column open_chat_message_id bigint references public.open_chat_messages(id) on delete set null;
alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check check (target_type in (
  'chat_user', 'message', 'profile', 'card', 'post', 'comment', 'image',
  'open_chat_user', 'open_chat_message', 'open_chat_room'
));
create unique index reports_open_chat_room_once
  on public.reports(reporter_id, open_chat_room_id)
  where target_type = 'open_chat_room';
create unique index reports_open_chat_message_once
  on public.reports(reporter_id, open_chat_message_id)
  where target_type = 'open_chat_message';
create unique index reports_open_chat_user_once
  on public.reports(reporter_id, open_chat_room_id, reported_user_id)
  where target_type = 'open_chat_user';

drop function if exists public.list_open_chat_rooms(text);
create function public.list_open_chat_rooms(sort_by text default 'popular')
returns table(
  room_id uuid, title text, description text, notice text, category text, region text, tags text[],
  member_count bigint, max_members integer, recent_message_at timestamptz,
  is_member boolean, owner_user_id uuid, created_at timestamptz
) language sql stable security definer set search_path = public, pg_temp as $$
  select room.id, room.title, room.description, room.notice, room.category, room.region, room.tags,
    count(distinct participant.user_id), room.max_members,
    max(message.created_at),
    bool_or(participant.user_id = public.current_account_id()), room.owner_user_id, room.created_at
  from public.open_chat_rooms room
  left join public.open_chat_participants participant on participant.room_id = room.id
  left join public.open_chat_messages message on message.room_id = room.id
  where public.account_access_allowed() and room.status = 'active'
  group by room.id
  order by
    case when sort_by = 'latest' then room.created_at end desc,
    case when sort_by = 'popular' then count(distinct participant.user_id) end desc,
    coalesce(max(message.created_at), room.created_at) desc;
$$;

create or replace function public.create_open_chat_request(room_uuid uuid, receiver_uuid uuid, opening_text text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor uuid := public.current_account_id();
  target_room public.open_chat_rooms;
  request_uuid uuid;
  point_reference_uuid uuid := gen_random_uuid();
  existing_room_uuid uuid;
  refresh_existing boolean := false;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  perform public.require_account_access();
  if char_length(trim(coalesce(opening_text, ''))) not between 1 and 200 then raise exception 'opening_message_length'; end if;
  if receiver_uuid = actor then raise exception 'cannot_request_self'; end if;

  select * into target_room from public.open_chat_rooms where id = room_uuid for share;
  if not found or target_room.status <> 'active' then raise exception 'room_not_active'; end if;
  if not exists (select 1 from public.open_chat_participants where room_id = room_uuid and user_id = actor)
     or not exists (select 1 from public.open_chat_participants participant join public.profiles profile on profile.id = participant.user_id
       where participant.room_id = room_uuid and participant.user_id = receiver_uuid and profile.status = 'active') then
    raise exception 'participants_required';
  end if;
  if exists (select 1 from public.blocks where
      (blocker_id = actor and blocked_id = receiver_uuid)
      or (blocker_id = receiver_uuid and blocked_id = actor)) then raise exception 'users_blocked'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    least(actor::text, receiver_uuid::text) || ':' || greatest(actor::text, receiver_uuid::text), 0
  ));

  select private_room.id into existing_room_uuid
  from public.chat_rooms private_room
  join public.chat_members mine on mine.room_id = private_room.id and mine.user_id = actor
  join public.chat_members other_member on other_member.room_id = private_room.id and other_member.user_id = receiver_uuid
  where private_room.closed_at is null order by private_room.created_at limit 1;

  if existing_room_uuid is null then
    select request.id into request_uuid from public.chat_requests request
    where request.open_chat_room_id = room_uuid and request.sender_id = actor and request.receiver_id = receiver_uuid
    for update;
    refresh_existing := request_uuid is not null;
  end if;
  if request_uuid is null then request_uuid := gen_random_uuid(); end if;

  update public.point_wallets set balance = balance - 100, updated_at = now()
  where user_id = actor and balance >= 100;
  if not found then raise exception 'insufficient_points'; end if;
  insert into public.point_transactions(user_id, amount, reason, reference_id)
  values (actor, -100, 'chat_request', point_reference_uuid);

  if existing_room_uuid is not null then
    update public.chat_members set hidden_at = null where room_id = existing_room_uuid;
    insert into public.messages(room_id, sender_id, body) values (existing_room_uuid, actor, trim(opening_text));
    return existing_room_uuid;
  end if;

  if refresh_existing then
    update public.chat_requests set opening_message = trim(opening_text), source_topic = target_room.title,
      status = 'pending', responded_at = null, created_at = now(), withdrawn_at = null,
      sender_hidden_at = null, receiver_hidden_at = null where id = request_uuid;
  else
    insert into public.chat_requests(id, open_chat_room_id, source_topic, sender_id, receiver_id, opening_message)
    values (request_uuid, room_uuid, target_room.title, actor, receiver_uuid, trim(opening_text));
  end if;
  return request_uuid;
end; $$;

create or replace function public.update_open_chat_room(
  room_uuid uuid, next_title text, next_description text, next_category text,
  next_region text, next_notice text
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid := public.current_account_id(); target public.open_chat_rooms;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  perform public.require_account_access();
  select * into target from public.open_chat_rooms where id = room_uuid for update;
  if not found or target.status <> 'active' then raise exception 'room_not_active'; end if;
  if target.owner_user_id <> actor then raise exception 'owner_required'; end if;
  if char_length(trim(coalesce(next_title, ''))) not between 2 and 40 then raise exception 'invalid_room_title'; end if;
  if char_length(coalesce(next_description, '')) > 120 then raise exception 'invalid_room_description'; end if;
  if next_category not in ('수다', '취미', '친구', '연애', '고민상담', '지역') then raise exception 'invalid_room_category'; end if;
  if char_length(coalesce(next_region, '')) > 40 then raise exception 'invalid_room_region'; end if;
  if char_length(coalesce(next_notice, '')) > 500 then raise exception 'invalid_room_notice'; end if;
  update public.open_chat_rooms set title = trim(next_title), description = trim(coalesce(next_description, '')),
    category = next_category, region = nullif(trim(coalesce(next_region, '')), ''),
    notice = trim(coalesce(next_notice, '')), updated_at = now() where id = room_uuid;
end; $$;

create or replace function public.report_open_chat(
  target_kind text, room_uuid uuid, target_user_uuid uuid default null,
  message_id bigint default null, reason_code text default 'other', report_details text default ''
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid := public.current_account_id(); target_room public.open_chat_rooms; reported uuid; report_uuid uuid; snapshot jsonb := '{}'::jsonb;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  perform public.require_account_access();
  if target_kind not in ('open_chat_user','open_chat_message','open_chat_room') then raise exception 'invalid_report_target'; end if;
  if reason_code not in ('abuse','sexual','spam','impersonation','dangerous','other') then raise exception 'invalid_report_reason'; end if;
  if char_length(coalesce(report_details, '')) > 1000 then raise exception 'report_details_too_long'; end if;
  select * into target_room from public.open_chat_rooms where id = room_uuid;
  if not found or not public.is_open_chat_member(room_uuid, actor) then raise exception 'room_access_required'; end if;

  if target_kind = 'open_chat_user' then
    if target_user_uuid is null or not public.is_open_chat_member(room_uuid, target_user_uuid) then raise exception 'invalid_report_target'; end if;
    reported := target_user_uuid;
    snapshot := jsonb_build_object('room_title', target_room.title, 'reported_nickname',
      (select nickname from public.profiles where id = reported));
  elsif target_kind = 'open_chat_message' then
    select sender_user_id, jsonb_build_object('message_id', id, 'message_type', message_type, 'content', content, 'created_at', created_at)
      into reported, snapshot from public.open_chat_messages where id = message_id and room_id = room_uuid;
    if not found or reported is null then raise exception 'invalid_report_target'; end if;
  else
    reported := target_room.owner_user_id;
    snapshot := jsonb_build_object('room_title', target_room.title, 'description', target_room.description, 'notice', target_room.notice);
  end if;
  if reported = actor then raise exception 'cannot_report_self'; end if;

  begin
    insert into public.reports(reporter_id, reported_user_id, reason, details, target_type, content_snapshot,
      priority, open_chat_room_id, open_chat_message_id)
    values (actor, reported, reason_code, trim(coalesce(report_details, '')), target_kind, snapshot,
      case when reason_code in ('sexual','dangerous') then 'high' else 'normal' end,
      room_uuid, case when target_kind = 'open_chat_message' then message_id else null end)
    returning id into report_uuid;
  exception when unique_violation then raise exception 'report_already_exists';
  end;
  return report_uuid;
end; $$;

grant select on public.open_chat_room_bans to authenticated;
create policy "users read own open chat bans" on public.open_chat_room_bans
for select to authenticated using (user_id = public.current_account_id() and (select public.account_access_allowed()));
alter table public.open_chat_room_bans replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.open_chat_room_bans;
exception when duplicate_object then null;
end $$;

revoke all on function public.list_open_chat_rooms(text) from public;
revoke all on function public.create_open_chat_request(uuid,uuid,text) from public;
revoke all on function public.update_open_chat_room(uuid,text,text,text,text,text) from public;
revoke all on function public.report_open_chat(text,uuid,uuid,bigint,text,text) from public;
grant execute on function public.list_open_chat_rooms(text) to authenticated;
grant execute on function public.create_open_chat_request(uuid,uuid,text) to authenticated;
grant execute on function public.update_open_chat_room(uuid,text,text,text,text,text) to authenticated;
grant execute on function public.report_open_chat(text,uuid,uuid,bigint,text,text) to authenticated;

notify pgrst, 'reload schema';
