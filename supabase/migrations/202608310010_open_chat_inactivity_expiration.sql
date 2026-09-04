-- Close inactive open-chat rooms after a visible 24-hour grace period.
-- Only messages sent by real users advance the activity clock. In particular,
-- the inactivity warning itself must never keep a room alive.

alter table public.open_chat_rooms
  add column if not exists last_user_message_at timestamptz,
  add column if not exists inactivity_warning_at timestamptz;

update public.open_chat_rooms room
set last_user_message_at = coalesce(
  (
    select max(message.created_at)
    from public.open_chat_messages message
    where message.room_id = room.id
      and message.sender_user_id is not null
      and message.message_type in ('text', 'audio', 'image')
  ),
  room.created_at
)
where room.last_user_message_at is null;

alter table public.open_chat_rooms
  alter column last_user_message_at set default now(),
  alter column last_user_message_at set not null;

create index if not exists open_chat_rooms_inactivity_warning_idx
  on public.open_chat_rooms(last_user_message_at)
  where status = 'active' and inactivity_warning_at is null;

create index if not exists open_chat_rooms_inactivity_close_idx
  on public.open_chat_rooms(inactivity_warning_at)
  where status = 'active' and inactivity_warning_at is not null;

create or replace function public.record_open_chat_user_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.sender_user_id is not null
    and new.message_type in ('text', 'audio', 'image')
  then
    update public.open_chat_rooms
    set last_user_message_at = greatest(last_user_message_at, new.created_at),
        inactivity_warning_at = null
    where id = new.room_id and status = 'active';
  end if;
  return new;
end;
$$;

drop trigger if exists open_chat_messages_record_user_activity on public.open_chat_messages;
create trigger open_chat_messages_record_user_activity
after insert on public.open_chat_messages
for each row execute function public.record_open_chat_user_activity();

create or replace function public.run_open_chat_inactivity_maintenance(
  evaluation_time timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  warned_count integer := 0;
  closed_count integer := 0;
begin
  if evaluation_time is null then
    raise exception 'evaluation_time_required';
  end if;

  -- Updating the room first serializes this decision against message creation.
  -- The inserted system message is intentionally ignored by the activity trigger.
  with warned_rooms as (
    update public.open_chat_rooms
    set inactivity_warning_at = evaluation_time
    where status = 'active'
      and inactivity_warning_at is null
      and last_user_message_at <= evaluation_time - interval '30 days'
    returning id
  )
  insert into public.open_chat_messages(room_id, message_type, content, created_at)
  select id, 'system',
    '30일 동안 대화가 없어 이 수다방은 24시간 후 자동으로 종료됩니다. 대화를 시작하면 종료 예정이 취소됩니다.',
    evaluation_time
  from warned_rooms;
  get diagnostics warned_count = row_count;

  -- A user message clears inactivity_warning_at. Therefore only rooms with no
  -- real conversation during the entire grace period can reach this update.
  with closed_rooms as (
    update public.open_chat_rooms
    set status = 'closed',
        owner_user_id = null,
        closed_at = evaluation_time,
        closed_reason = 'inactive_after_30_day_warning',
        updated_at = evaluation_time
    where status = 'active'
      and inactivity_warning_at is not null
      and inactivity_warning_at <= evaluation_time - interval '24 hours'
      and last_user_message_at <= inactivity_warning_at
    returning id
  ), removed_participants as (
    delete from public.open_chat_participants participant
    using closed_rooms room
    where participant.room_id = room.id
    returning participant.room_id
  )
  select count(*)::integer into closed_count from closed_rooms;

  return jsonb_build_object('warned_count', warned_count, 'closed_count', closed_count);
end;
$$;

-- Keep discovery ordering tied to real conversation, not maintenance notices.
drop function if exists public.list_open_chat_rooms(text);
create function public.list_open_chat_rooms(sort_by text default 'popular')
returns table(
  room_id uuid, title text, description text, notice text, category text, region text, tags text[],
  member_count bigint, max_members integer, recent_message_at timestamptz,
  is_member boolean, owner_user_id uuid, owner_nickname text, created_at timestamptz,
  cover_storage_path text, cover_width integer, cover_height integer
) language sql stable security definer set search_path = public, pg_temp as $$
  select room.id, room.title, room.description, room.notice, room.category, room.region, room.tags,
    count(participant.user_id), room.max_members, room.last_user_message_at,
    coalesce(bool_or(participant.user_id = public.current_account_id()), false),
    room.owner_user_id, owner.nickname, room.created_at,
    room.cover_storage_path, room.cover_width, room.cover_height
  from public.open_chat_rooms room
  join public.profiles owner on owner.id = room.owner_user_id
  left join public.open_chat_participants participant on participant.room_id = room.id
  where public.account_access_allowed() and room.status = 'active'
  group by room.id, owner.nickname
  order by
    case when sort_by = 'latest' then room.created_at end desc,
    case when sort_by = 'popular' then count(participant.user_id) end desc,
    room.last_user_message_at desc;
$$;

revoke all on function public.record_open_chat_user_activity() from public, anon, authenticated;
revoke all on function public.run_open_chat_inactivity_maintenance(timestamptz) from public, anon, authenticated;
grant execute on function public.run_open_chat_inactivity_maintenance(timestamptz) to service_role;
revoke all on function public.list_open_chat_rooms(text) from public;
grant execute on function public.list_open_chat_rooms(text) to authenticated;

do $$
declare scheduled_job record;
begin
  for scheduled_job in
    select jobid from cron.job where jobname = 'ingtalk-open-chat-inactivity-minute'
  loop
    perform cron.unschedule(scheduled_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'ingtalk-open-chat-inactivity-minute',
  '* * * * *',
  $cron$select public.run_open_chat_inactivity_maintenance();$cron$
);

notify pgrst, 'reload schema';
