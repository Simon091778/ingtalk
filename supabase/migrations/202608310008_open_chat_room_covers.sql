-- Public room-cover images are discovery content. Only the current room owner
-- can attach or replace an object, while anyone may view the resulting public URL.

alter table public.open_chat_rooms
  add column if not exists cover_storage_path text,
  add column if not exists cover_width integer,
  add column if not exists cover_height integer;

alter table public.open_chat_rooms add constraint open_chat_rooms_cover_payload_check check (
  (cover_storage_path is null and cover_width is null and cover_height is null)
  or (
    cover_storage_path is not null and char_length(cover_storage_path) between 80 and 220
    and cover_width between 1 and 12000 and cover_height between 1 and 12000
  )
);

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'open-chat-covers', 'open-chat-covers', true, 8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "open chat owners upload room covers" on storage.objects;
create policy "open chat owners upload room covers" on storage.objects
for insert to authenticated with check (
  bucket_id = 'open-chat-covers'
  and name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.(jpg|png|webp|heic|heif)$'
  and (storage.foldername(name))[2] = public.current_account_id()::text
  and exists (
    select 1 from public.open_chat_rooms room
    where room.id::text = (storage.foldername(name))[1]
      and room.owner_user_id = public.current_account_id() and room.status = 'active'
  )
  and (select public.account_access_allowed())
);

drop policy if exists "open chat owners remove unused room covers" on storage.objects;
create policy "open chat owners remove unused room covers" on storage.objects
for delete to authenticated using (
  bucket_id = 'open-chat-covers'
  and (storage.foldername(name))[2] = public.current_account_id()::text
  and exists (
    select 1 from public.open_chat_rooms room
    where room.id::text = (storage.foldername(name))[1]
      and room.owner_user_id = public.current_account_id() and room.status = 'active'
  )
  and not exists (select 1 from public.open_chat_rooms room where room.cover_storage_path = name)
  and (select public.account_access_allowed())
);

create or replace function public.set_open_chat_room_cover(
  room_uuid uuid, cover_path text, image_width integer, image_height integer
) returns text language plpgsql security definer set search_path = public, storage, pg_temp as $$
declare actor uuid := public.current_account_id(); target public.open_chat_rooms; previous_path text;
begin
  if actor is null then raise exception 'authentication_required'; end if;
  perform public.require_account_access();
  select * into target from public.open_chat_rooms where id = room_uuid for update;
  if not found or target.status <> 'active' then raise exception 'room_not_active'; end if;
  if target.owner_user_id <> actor then raise exception 'owner_required'; end if;
  previous_path := target.cover_storage_path;

  if cover_path is null then
    if image_width is not null or image_height is not null then raise exception 'invalid_cover_metadata'; end if;
  else
    if image_width not between 1 and 12000 or image_height not between 1 and 12000 then raise exception 'invalid_cover_metadata'; end if;
    if cover_path <> room_uuid::text || '/' || actor::text || '/' || split_part(cover_path, '/', 3)
      or cover_path !~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.(jpg|png|webp|heic|heif)$'
    then raise exception 'invalid_cover_path'; end if;
    if not exists (select 1 from storage.objects object where object.bucket_id='open-chat-covers' and object.name=cover_path)
    then raise exception 'cover_not_uploaded'; end if;
  end if;

  update public.open_chat_rooms set cover_storage_path=cover_path, cover_width=image_width,
    cover_height=image_height, updated_at=now() where id=room_uuid;
  return previous_path;
end; $$;

drop function if exists public.list_open_chat_rooms(text);
create function public.list_open_chat_rooms(sort_by text default 'popular')
returns table(
  room_id uuid, title text, description text, notice text, category text, region text, tags text[],
  member_count bigint, max_members integer, recent_message_at timestamptz,
  is_member boolean, owner_user_id uuid, owner_nickname text, created_at timestamptz,
  cover_storage_path text, cover_width integer, cover_height integer
) language sql stable security definer set search_path = public, pg_temp as $$
  select room.id, room.title, room.description, room.notice, room.category, room.region, room.tags,
    count(distinct participant.user_id), room.max_members, max(message.created_at),
    bool_or(participant.user_id = public.current_account_id()), room.owner_user_id, owner.nickname,
    room.created_at, room.cover_storage_path, room.cover_width, room.cover_height
  from public.open_chat_rooms room
  join public.profiles owner on owner.id = room.owner_user_id
  left join public.open_chat_participants participant on participant.room_id = room.id
  left join public.open_chat_messages message on message.room_id = room.id
  where public.account_access_allowed() and room.status = 'active'
  group by room.id, owner.nickname
  order by
    case when sort_by = 'latest' then room.created_at end desc,
    case when sort_by = 'popular' then count(distinct participant.user_id) end desc,
    coalesce(max(message.created_at), room.created_at) desc;
$$;

revoke all on function public.set_open_chat_room_cover(uuid,text,integer,integer) from public;
grant execute on function public.set_open_chat_room_cover(uuid,text,integer,integer) to authenticated;
revoke all on function public.list_open_chat_rooms(text) from public;
grant execute on function public.list_open_chat_rooms(text) to authenticated;

notify pgrst, 'reload schema';
