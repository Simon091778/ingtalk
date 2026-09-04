-- A successor owner must be able to remove a cover uploaded by the previous
-- owner after replacing it. The room ownership check remains authoritative.

drop policy if exists "open chat owners remove unused room covers" on storage.objects;
create policy "open chat owners remove unused room covers" on storage.objects
for delete to authenticated using (
  bucket_id = 'open-chat-covers'
  and name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.(jpg|png|webp|heic|heif)$'
  and exists (
    select 1 from public.open_chat_rooms room
    where room.id::text = (storage.foldername(name))[1]
      and room.owner_user_id = public.current_account_id() and room.status = 'active'
  )
  and not exists (select 1 from public.open_chat_rooms room where room.cover_storage_path = name)
  and (select public.account_access_allowed())
);
