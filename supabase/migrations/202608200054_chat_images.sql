-- Private chat-image attachments. Images are available only to active room members.
alter table public.messages
  add column if not exists image_path text,
  add column if not exists image_width integer,
  add column if not exists image_height integer;

alter table public.messages drop constraint if exists messages_image_dimensions_check;
alter table public.messages add constraint messages_image_dimensions_check check (
  (image_path is null and image_width is null and image_height is null)
  or (
    image_path is not null
    and char_length(image_path) between 10 and 500
    and image_width between 1 and 12000
    and image_height between 1 and 12000
  )
);

alter table public.message_backups
  add column if not exists image_path text,
  add column if not exists image_width integer,
  add column if not exists image_height integer;

create or replace function public.backup_chat_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.message_backups(
    original_message_id, room_id, sender_id, body, moderation_state,
    message_created_at, retention_until, image_path, image_width, image_height
  ) values (
    new.id, new.room_id, new.sender_id, new.body, new.moderation_state,
    new.created_at, new.created_at + interval '1 year',
    new.image_path, new.image_width, new.image_height
  )
  on conflict (original_message_id) do update set
    image_path = excluded.image_path,
    image_width = excluded.image_width,
    image_height = excluded.image_height;
  return new;
end;
$$;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-images', 'chat-images', false, 8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "chat members upload chat images" on storage.objects;
create policy "chat members upload chat images" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'chat-images'
  and name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/'
  and (storage.foldername(name))[2] = auth.uid()::text
  and exists (
    select 1
    from public.chat_members member
    join public.chat_rooms room on room.id = member.room_id
    where member.user_id = auth.uid()
      and room.id::text = (storage.foldername(name))[1]
      and room.closed_at is null
  )
);

drop policy if exists "chat members read chat images" on storage.objects;
create policy "chat members read chat images" on storage.objects
for select to authenticated
using (
  bucket_id = 'chat-images'
  and name ~ '^[0-9a-fA-F-]{36}/'
  and exists (
    select 1
    from public.chat_members member
    join public.chat_rooms room on room.id = member.room_id
    where member.user_id = auth.uid()
      and room.id::text = (storage.foldername(name))[1]
      and room.closed_at is null
  )
);

drop policy if exists "chat senders remove unsent images" on storage.objects;
create policy "chat senders remove unsent images" on storage.objects
for delete to authenticated
using (
  bucket_id = 'chat-images'
  and name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/'
  and (storage.foldername(name))[2] = auth.uid()::text
  and not exists (select 1 from public.messages message where message.image_path = name)
);
