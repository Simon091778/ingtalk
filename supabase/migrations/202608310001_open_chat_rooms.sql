-- Multi-user open chat rooms. Membership and ownership mutations are exposed
-- only through serialized SECURITY DEFINER functions.

create table public.open_chat_rooms (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 2 and 40),
  description text not null default '' check (char_length(description) <= 120),
  category text not null check (category in ('수다', '취미', '친구', '연애', '고민상담', '지역')),
  region text check (region is null or char_length(region) <= 40),
  tags text[] not null default '{}',
  owner_user_id uuid references public.profiles(id) on delete restrict,
  max_members integer not null check (max_members between 2 and 100),
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_reason text,
  check ((status = 'active' and owner_user_id is not null and closed_at is null)
      or (status = 'closed' and owner_user_id is null and closed_at is not null)),
  unique (id, owner_user_id)
);

create table public.open_chat_participants (
  room_id uuid not null references public.open_chat_rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (room_id, user_id)
);

alter table public.open_chat_rooms
  add constraint open_chat_owner_is_participant
  foreign key (id, owner_user_id)
  references public.open_chat_participants(room_id, user_id)
  deferrable initially deferred;

create table public.open_chat_room_bans (
  room_id uuid not null references public.open_chat_rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  banned_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (room_id, user_id),
  check (user_id <> banned_by)
);

create table public.open_chat_messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.open_chat_rooms(id) on delete cascade,
  sender_user_id uuid references public.profiles(id) on delete set null,
  message_type text not null default 'text' check (message_type in ('text', 'system')),
  content text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now(),
  check ((message_type = 'text' and sender_user_id is not null) or message_type = 'system')
);

create index open_chat_rooms_feed_idx on public.open_chat_rooms(status, created_at desc);
create index open_chat_participants_user_idx on public.open_chat_participants(user_id, joined_at desc);
create index open_chat_messages_room_idx on public.open_chat_messages(room_id, created_at desc);

alter table public.open_chat_rooms enable row level security;
alter table public.open_chat_participants enable row level security;
alter table public.open_chat_room_bans enable row level security;
alter table public.open_chat_messages enable row level security;

grant select on public.open_chat_rooms to authenticated;
grant select on public.open_chat_participants to authenticated;
grant select, insert on public.open_chat_messages to authenticated;
revoke all on public.open_chat_room_bans from authenticated;

create or replace function public.is_open_chat_member(room_uuid uuid, account_uuid uuid default public.current_account_id())
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select account_uuid is not null and exists (
    select 1 from public.open_chat_participants
    where room_id = room_uuid and user_id = account_uuid
  );
$$;

create policy "active open rooms are discoverable" on public.open_chat_rooms
for select to authenticated using (status = 'active' or public.is_open_chat_member(id));
create policy "members read open chat participants" on public.open_chat_participants
for select to authenticated using (public.is_open_chat_member(room_id));
create policy "members read open chat messages" on public.open_chat_messages
for select to authenticated using (public.is_open_chat_member(room_id));
create policy "members send open chat messages" on public.open_chat_messages
for insert to authenticated with check (
  sender_user_id = public.current_account_id()
  and message_type = 'text'
  and public.is_open_chat_member(room_id)
  and exists (select 1 from public.open_chat_rooms where id = room_id and status = 'active')
);
create policy "open chat rooms account gate" on public.open_chat_rooms as restrictive
for all to authenticated using ((select public.account_access_allowed()))
with check ((select public.account_access_allowed()));
create policy "open chat participants account gate" on public.open_chat_participants as restrictive
for all to authenticated using ((select public.account_access_allowed()))
with check ((select public.account_access_allowed()));
create policy "open chat messages account gate" on public.open_chat_messages as restrictive
for all to authenticated using ((select public.account_access_allowed()))
with check ((select public.account_access_allowed()));

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
  if room_max_members not between 2 and 100 then raise exception 'invalid_max_members'; end if;
  if cardinality(coalesce(room_tags, '{}')) > 10 then raise exception 'too_many_tags'; end if;

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
  select * into target from public.open_chat_rooms where id = room_uuid for update;
  if not found or target.status <> 'active' then raise exception 'room_not_active'; end if;
  if not exists (select 1 from public.profiles where id = actor and status = 'active') then raise exception 'account_not_active'; end if;
  if exists (select 1 from public.open_chat_room_bans where room_id = room_uuid and user_id = actor) then raise exception 'room_banned'; end if;
  if exists (select 1 from public.open_chat_participants where room_id = room_uuid and user_id = actor) then return; end if;
  if (select count(*) from public.open_chat_participants where room_id = room_uuid) >= target.max_members then raise exception 'room_full'; end if;
  insert into public.open_chat_participants(room_id, user_id) values (room_uuid, actor);
end; $$;

create or replace function public.transfer_open_chat_ownership(room_uuid uuid, new_owner_uuid uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid := public.current_account_id(); target public.open_chat_rooms; new_name text;
begin
  perform public.require_account_access();
  select * into target from public.open_chat_rooms where id = room_uuid for update;
  if not found or target.status <> 'active' then raise exception 'room_not_active'; end if;
  if actor is null or target.owner_user_id <> actor then raise exception 'owner_required'; end if;
  if new_owner_uuid = actor then raise exception 'already_owner'; end if;
  select profile.nickname into new_name
  from public.open_chat_participants participant join public.profiles profile on profile.id = participant.user_id
  where participant.room_id = room_uuid and participant.user_id = new_owner_uuid and profile.status = 'active';
  if not found then raise exception 'target_not_active_participant'; end if;
  if exists (select 1 from public.open_chat_room_bans where room_id = room_uuid and user_id = new_owner_uuid) then raise exception 'target_not_active_participant'; end if;
  update public.open_chat_rooms set owner_user_id = new_owner_uuid, updated_at = now() where id = room_uuid;
  insert into public.open_chat_messages(room_id, message_type, content)
  values (room_uuid, 'system', new_name || '님이 새로운 방장이 되었습니다.');
end; $$;

create or replace function public.leave_open_chat_room(room_uuid uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid := public.current_account_id(); target public.open_chat_rooms; successor uuid; successor_name text;
begin
  perform public.require_account_access();
  select * into target from public.open_chat_rooms where id = room_uuid for update;
  if not found or target.status <> 'active' then raise exception 'room_not_active'; end if;
  if actor is null or not exists (select 1 from public.open_chat_participants where room_id = room_uuid and user_id = actor) then raise exception 'not_room_member'; end if;

  if target.owner_user_id <> actor then
    delete from public.open_chat_participants where room_id = room_uuid and user_id = actor;
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
  insert into public.open_chat_messages(room_id, message_type, content)
  values (room_uuid, 'system', successor_name || '님이 새로운 방장이 되었습니다.');
  return successor;
end; $$;

create or replace function public.kick_open_chat_member(room_uuid uuid, member_uuid uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid := public.current_account_id(); target public.open_chat_rooms; member_name text;
begin
  perform public.require_account_access();
  select * into target from public.open_chat_rooms where id = room_uuid for update;
  if not found or target.status <> 'active' then raise exception 'room_not_active'; end if;
  if actor is null or target.owner_user_id <> actor then raise exception 'owner_required'; end if;
  if member_uuid = actor then raise exception 'cannot_kick_owner'; end if;
  select profile.nickname into member_name from public.open_chat_participants participant
    join public.profiles profile on profile.id = participant.user_id
    where participant.room_id = room_uuid and participant.user_id = member_uuid;
  if not found then raise exception 'not_room_member'; end if;
  insert into public.open_chat_room_bans(room_id, user_id, banned_by)
    values (room_uuid, member_uuid, actor) on conflict (room_id, user_id) do nothing;
  delete from public.open_chat_participants where room_id = room_uuid and user_id = member_uuid;
  insert into public.open_chat_messages(room_id, message_type, content)
    values (room_uuid, 'system', member_name || '님이 방에서 내보내졌습니다.');
end; $$;

create or replace function public.list_open_chat_rooms(sort_by text default 'popular')
returns table(
  room_id uuid, title text, description text, category text, region text, tags text[],
  member_count bigint, max_members integer, recent_message_at timestamptz,
  is_member boolean, owner_user_id uuid, created_at timestamptz
) language sql stable security definer set search_path = public, pg_temp as $$
  select room.id, room.title, room.description, room.category, room.region, room.tags,
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

create or replace function public.open_chat_participant_profiles(room_uuid uuid)
returns table(user_id uuid, nickname text, avatar_url text, gender text, birth_year integer, joined_at timestamptz, is_owner boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select profile.id, profile.nickname, profile.avatar_url, profile.gender, profile.birth_year,
    participant.joined_at, room.owner_user_id = participant.user_id
  from public.open_chat_participants participant
  join public.open_chat_rooms room on room.id = participant.room_id
  join public.profiles profile on profile.id = participant.user_id
  where public.account_access_allowed()
    and participant.room_id = room_uuid and public.is_open_chat_member(room_uuid)
  order by (room.owner_user_id = participant.user_id) desc, participant.joined_at;
$$;

do $$ begin
  alter publication supabase_realtime add table public.open_chat_messages;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.open_chat_participants;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.open_chat_rooms;
exception when duplicate_object then null;
end $$;

revoke all on function public.is_open_chat_member(uuid, uuid) from public;
revoke all on function public.create_open_chat_room(text,text,text,integer,text,text[]) from public;
revoke all on function public.join_open_chat_room(uuid) from public;
revoke all on function public.transfer_open_chat_ownership(uuid,uuid) from public;
revoke all on function public.leave_open_chat_room(uuid) from public;
revoke all on function public.kick_open_chat_member(uuid,uuid) from public;
revoke all on function public.list_open_chat_rooms(text) from public;
revoke all on function public.open_chat_participant_profiles(uuid) from public;
grant execute on function public.is_open_chat_member(uuid, uuid) to authenticated;
grant execute on function public.create_open_chat_room(text,text,text,integer,text,text[]) to authenticated;
grant execute on function public.join_open_chat_room(uuid) to authenticated;
grant execute on function public.transfer_open_chat_ownership(uuid,uuid) to authenticated;
grant execute on function public.leave_open_chat_room(uuid) to authenticated;
grant execute on function public.kick_open_chat_member(uuid,uuid) to authenticated;
grant execute on function public.list_open_chat_rooms(text) to authenticated;
grant execute on function public.open_chat_participant_profiles(uuid) to authenticated;
