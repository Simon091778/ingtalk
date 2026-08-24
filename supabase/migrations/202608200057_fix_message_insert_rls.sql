-- Keep block relationships private while allowing the messages INSERT policy
-- to decide whether the authenticated sender may post to an open room.
create or replace function public.can_send_room_message(room_uuid uuid, sender_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select sender_uuid = auth.uid()
    and exists (
      select 1
      from public.chat_members member
      join public.chat_rooms room on room.id = member.room_id
      where member.room_id = room_uuid
        and member.user_id = auth.uid()
        and room.closed_at is null
    )
    and not exists (
      select 1
      from public.chat_members other_member
      join public.blocks block
        on (block.blocker_id = auth.uid() and block.blocked_id = other_member.user_id)
        or (block.blocker_id = other_member.user_id and block.blocked_id = auth.uid())
      where other_member.room_id = room_uuid
        and other_member.user_id <> auth.uid()
    );
$$;

revoke all on function public.can_send_room_message(uuid, uuid) from public, anon;
grant execute on function public.can_send_room_message(uuid, uuid) to authenticated;

drop policy if exists "members send own messages" on public.messages;
create policy "members send own messages"
on public.messages for insert to authenticated
with check (public.can_send_room_message(room_id, sender_id));

notify pgrst, 'reload schema';
