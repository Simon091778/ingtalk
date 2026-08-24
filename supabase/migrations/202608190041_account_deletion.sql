-- Server-only account data cleanup. Auth deletion and Storage removal are handled by the delete-account Edge Function.

create table if not exists public.account_deletion_audit (
  id uuid primary key default gen_random_uuid(),
  completed_at timestamptz not null default now(),
  deletion_version integer not null default 1
);

alter table public.account_deletion_audit enable row level security;
revoke all on public.account_deletion_audit from public, anon, authenticated;

create or replace function public.delete_account_data(target_user_uuid uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_rooms integer := 0;
  deleted_posts integer := 0;
  deleted_messages integer := 0;
  audit_uuid uuid;
begin
  -- This RPC is deliberately unavailable to app users and must only run with the server secret role.
  if current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'service_role_required';
  end if;
  if target_user_uuid is null then raise exception 'target_user_required'; end if;

  select count(*) into deleted_messages
  from public.messages message
  where message.room_id in (select member.room_id from public.chat_members member where member.user_id = target_user_uuid);

  with removed as (
    delete from public.chat_rooms room
    where room.id in (select member.room_id from public.chat_members member where member.user_id = target_user_uuid)
    returning room.id
  ) select count(*) into deleted_rooms from removed;

  -- Rooms must be gone before requests because chat_rooms.request_id is RESTRICT.
  delete from public.chat_requests where target_user_uuid in (sender_id, receiver_id);

  select count(*) into deleted_posts from public.board_posts where author_id = target_user_uuid;
  delete from public.board_comments where author_id = target_user_uuid;
  delete from public.board_posts where author_id = target_user_uuid;
  delete from public.conversation_cards where author_id = target_user_uuid;
  delete from public.reports where reporter_id = target_user_uuid or reported_user_id = target_user_uuid;

  -- Keep only the fact that an operator acted; remove the departed user's identity, notes and state snapshots.
  update public.moderation_actions
  set target_user_id = null, report_id = null, note = '[탈퇴로 개인정보 삭제]',
      before_state = '{}'::jsonb, after_state = '{}'::jsonb
  where target_user_id = target_user_uuid;

  -- Remaining user-owned rows cascade from profiles (locations, tokens, points, rewards, likes and blocks).
  delete from public.profiles where id = target_user_uuid;

  insert into public.account_deletion_audit default values returning id into audit_uuid;
  return jsonb_build_object(
    'audit_id', audit_uuid,
    'deleted_rooms', deleted_rooms,
    'deleted_messages', deleted_messages,
    'deleted_posts', deleted_posts
  );
end;
$$;

revoke all on function public.delete_account_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_account_data(uuid) to service_role;

notify pgrst, 'reload schema';
