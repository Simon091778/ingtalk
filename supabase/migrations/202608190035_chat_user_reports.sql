-- Secure chat-user reports with an immutable snapshot for later moderation.
alter table public.reports
  add column if not exists target_type text not null default 'chat_user',
  add column if not exists content_snapshot jsonb not null default '[]'::jsonb,
  add column if not exists priority text not null default 'normal',
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;

alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check
  check (target_type in ('chat_user', 'message', 'profile', 'card', 'post', 'comment', 'image'));

alter table public.reports drop constraint if exists reports_priority_check;
alter table public.reports add constraint reports_priority_check
  check (priority in ('normal', 'high', 'urgent'));

-- Preserve the meaning of any reports created before target types existed.
update public.reports
set target_type = case when message_id is not null then 'message' else 'profile' end
where target_type = 'chat_user' and (message_id is not null or room_id is null);

create or replace function public.report_chat_user(
  room_uuid uuid,
  reason_code text,
  report_details text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  other_user_uuid uuid;
  report_uuid uuid;
  evidence jsonb;
  report_priority text := 'normal';
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if reason_code not in ('sexual', 'illegal_meeting', 'harassment', 'fraud', 'spam', 'privacy', 'suspected_minor', 'illegal_image', 'other') then
    raise exception 'invalid_report_reason';
  end if;
  if char_length(trim(coalesce(report_details, ''))) > 1000 then raise exception 'report_details_too_long'; end if;

  if not exists (
    select 1 from public.chat_members
    where room_id = room_uuid and user_id = auth.uid()
  ) then raise exception 'room_not_allowed'; end if;

  select user_id into other_user_uuid
  from public.chat_members
  where room_id = room_uuid and user_id <> auth.uid()
  limit 1;
  if other_user_uuid is null then raise exception 'room_member_not_found'; end if;

  -- Serialize duplicate checks for this reporter and room.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || room_uuid::text, 0));
  if exists (
    select 1 from public.reports
    where reporter_id = auth.uid() and room_id = room_uuid and target_type = 'chat_user'
  ) then raise exception 'report_already_exists'; end if;

  if reason_code in ('suspected_minor', 'illegal_image') then report_priority := 'urgent';
  elsif reason_code in ('sexual', 'illegal_meeting', 'fraud') then report_priority := 'high';
  end if;

  select coalesce(jsonb_agg(to_jsonb(recent_message) order by recent_message.created_at), '[]'::jsonb)
  into evidence
  from (
    select message.id, message.sender_id, message.body, message.created_at
    from public.messages message
    where message.room_id = room_uuid
    order by message.created_at desc
    limit 30
  ) recent_message;

  insert into public.reports(
    reporter_id, reported_user_id, room_id, reason, details,
    target_type, content_snapshot, priority
  ) values (
    auth.uid(), other_user_uuid, room_uuid, reason_code,
    trim(coalesce(report_details, '')), 'chat_user', evidence, report_priority
  ) returning id into report_uuid;
  return report_uuid;
end;
$$;

-- Reports must be created through the validated function, not arbitrary inserts.
revoke insert on public.reports from authenticated;
revoke all on function public.report_chat_user(uuid, text, text) from public;
grant execute on function public.report_chat_user(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
