-- Secure voice attachments and same-room replies for open chat.

alter table public.open_chat_messages
  add column if not exists audio_storage_path text,
  add column if not exists audio_duration_ms integer,
  add column if not exists reply_to_message_id bigint,
  add column if not exists reply_to_room_id uuid;

alter table public.open_chat_messages alter column content drop not null;
alter table public.open_chat_messages drop constraint if exists open_chat_messages_message_type_check;
alter table public.open_chat_messages drop constraint if exists open_chat_messages_content_check;
alter table public.open_chat_messages add constraint open_chat_messages_message_type_check
  check (message_type in ('text', 'system', 'audio'));
alter table public.open_chat_messages add constraint open_chat_messages_payload_check check (
  (message_type in ('text', 'system')
    and content is not null and char_length(content) between 1 and 2000
    and audio_storage_path is null and audio_duration_ms is null)
  or
  (message_type = 'audio'
    and content is null
    and audio_storage_path is not null and char_length(audio_storage_path) between 80 and 200
    and audio_duration_ms between 1 and 30000)
);
alter table public.open_chat_messages add constraint open_chat_messages_reply_pair_check check (
  (reply_to_message_id is null and reply_to_room_id is null)
  or (reply_to_message_id is not null and reply_to_room_id = room_id)
);
alter table public.open_chat_messages add constraint open_chat_messages_room_id_id_unique unique (room_id, id);
alter table public.open_chat_messages add constraint open_chat_messages_reply_fkey
  foreign key (reply_to_room_id, reply_to_message_id)
  references public.open_chat_messages(room_id, id) on delete set null;
create index open_chat_messages_reply_idx on public.open_chat_messages(reply_to_room_id, reply_to_message_id)
  where reply_to_message_id is not null;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'open-chat-audio', 'open-chat-audio', false, 1048576,
  array['audio/mp4', 'audio/m4a', 'audio/x-m4a']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "open chat members upload own audio" on storage.objects;
create policy "open chat members upload own audio" on storage.objects
for insert to authenticated with check (
  bucket_id = 'open-chat-audio'
  and name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.m4a$'
  and (storage.foldername(name))[2] = public.current_account_id()::text
  and exists (
    select 1 from public.open_chat_rooms room
    join public.open_chat_participants participant
      on participant.room_id = room.id and participant.user_id = public.current_account_id()
    where room.id::text = (storage.foldername(name))[1]
      and room.status = 'active'
      and not exists (
        select 1 from public.open_chat_room_bans ban
        where ban.room_id = room.id and ban.user_id = public.current_account_id()
      )
  )
  and (select public.account_access_allowed())
);

drop policy if exists "open chat members read audio" on storage.objects;
create policy "open chat members read audio" on storage.objects
for select to authenticated using (
  bucket_id = 'open-chat-audio'
  and name ~ '^[0-9a-fA-F-]{36}/'
  and exists (
    select 1 from public.open_chat_rooms room
    join public.open_chat_participants participant
      on participant.room_id = room.id and participant.user_id = public.current_account_id()
    where room.id::text = (storage.foldername(name))[1] and room.status = 'active'
  )
  and (select public.account_access_allowed())
);

drop policy if exists "open chat senders remove unsent audio" on storage.objects;
create policy "open chat senders remove unsent audio" on storage.objects
for delete to authenticated using (
  bucket_id = 'open-chat-audio'
  and name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.m4a$'
  and (storage.foldername(name))[2] = public.current_account_id()::text
  and not exists (
    select 1 from public.open_chat_messages message where message.audio_storage_path = name
  )
  and (select public.account_access_allowed())
);

create or replace function public.create_open_chat_message(
  room_uuid uuid,
  message_kind text,
  text_content text,
  audio_path text,
  duration_ms integer,
  reply_message_id bigint
) returns bigint language plpgsql security definer set search_path = public, storage, pg_temp as $$
declare
  actor uuid := public.current_account_id();
  target public.open_chat_rooms;
  created_id bigint;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  perform public.require_account_access();
  select * into target from public.open_chat_rooms where id = room_uuid for share;
  if not found or target.status <> 'active' then raise exception 'room_not_active'; end if;
  if not public.is_open_chat_member(room_uuid, actor) then raise exception 'room_access_required'; end if;
  if exists (select 1 from public.open_chat_room_bans where room_id = room_uuid and user_id = actor) then
    raise exception 'room_banned';
  end if;
  if reply_message_id is not null and not exists (
    select 1 from public.open_chat_messages
    where room_id = room_uuid and id = reply_message_id and message_type in ('text', 'audio')
  ) then raise exception 'invalid_reply_target'; end if;

  if message_kind = 'text' then
    if char_length(trim(coalesce(text_content, ''))) not between 1 and 2000 then
      raise exception 'invalid_message_content';
    end if;
    if audio_path is not null or duration_ms is not null then raise exception 'invalid_message_payload'; end if;
    insert into public.open_chat_messages(
      room_id, sender_user_id, message_type, content, reply_to_room_id, reply_to_message_id
    ) values (
      room_uuid, actor, 'text', trim(text_content),
      case when reply_message_id is null then null else room_uuid end, reply_message_id
    ) returning id into created_id;
  elsif message_kind = 'audio' then
    if text_content is not null or duration_ms not between 1 and 30000 then
      raise exception 'invalid_audio_metadata';
    end if;
    if audio_path is null
      or audio_path <> room_uuid::text || '/' || actor::text || '/' || split_part(audio_path, '/', 3)
      or audio_path !~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.m4a$'
    then raise exception 'invalid_audio_path'; end if;
    if not exists (
      select 1 from storage.objects object
      where object.bucket_id = 'open-chat-audio' and object.name = audio_path
    ) then raise exception 'audio_not_uploaded'; end if;
    insert into public.open_chat_messages(
      room_id, sender_user_id, message_type, content, audio_storage_path, audio_duration_ms,
      reply_to_room_id, reply_to_message_id
    ) values (
      room_uuid, actor, 'audio', null, audio_path, duration_ms,
      case when reply_message_id is null then null else room_uuid end, reply_message_id
    ) returning id into created_id;
  else
    raise exception 'invalid_message_type';
  end if;
  return created_id;
end; $$;

revoke all on function public.create_open_chat_message(uuid,text,text,text,integer,bigint) from public;
grant execute on function public.create_open_chat_message(uuid,text,text,text,integer,bigint) to authenticated;

create or replace function public.enrich_open_chat_message_report_snapshot()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare attachment jsonb;
begin
  if new.target_type <> 'open_chat_message' or new.open_chat_message_id is null then return new; end if;
  select jsonb_build_object(
    'audio_storage_path', message.audio_storage_path,
    'audio_duration_ms', message.audio_duration_ms,
    'reply_to_message_id', message.reply_to_message_id
  ) into attachment
  from public.open_chat_messages message where message.id = new.open_chat_message_id;
  new.content_snapshot := coalesce(new.content_snapshot, '{}'::jsonb) || coalesce(attachment, '{}'::jsonb);
  return new;
end; $$;
drop trigger if exists enrich_open_chat_message_report_snapshot on public.reports;
create trigger enrich_open_chat_message_report_snapshot before insert or update of content_snapshot on public.reports
for each row execute function public.enrich_open_chat_message_report_snapshot();

notify pgrst, 'reload schema';
