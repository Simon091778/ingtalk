-- Keep legally/operationally required purchase evidence without retaining a link
-- to an account that the user asked us to delete.
alter table public.point_purchase_receipts
  add column if not exists account_deleted_at timestamptz;

alter table public.point_purchase_receipts
  alter column user_id drop not null;

alter table public.point_purchase_receipts
  drop constraint if exists point_purchase_receipts_user_id_fkey;

alter table public.point_purchase_receipts
  add constraint point_purchase_receipts_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete set null;

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
  if current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'service_role_required';
  end if;
  if target_user_uuid is null then raise exception 'target_user_required'; end if;

  select count(*) into deleted_messages
  from public.messages message
  where message.room_id in (
    select member.room_id from public.chat_members member
    where member.user_id = target_user_uuid
  );

  -- Backups are retained only for the configured moderation/retention period.
  -- Remove the departing user's identity and message/photo content immediately.
  update public.message_backups
  set sender_id = '00000000-0000-0000-0000-000000000000'::uuid,
      body = '[account deleted]',
      image_path = null,
      image_width = null,
      image_height = null
  where sender_id = target_user_uuid;

  with removed as (
    delete from public.chat_rooms room
    where room.id in (
      select member.room_id from public.chat_members member
      where member.user_id = target_user_uuid
    )
    returning room.id
  ) select count(*) into deleted_rooms from removed;

  delete from public.chat_requests where target_user_uuid in (sender_id, receiver_id);

  select count(*) into deleted_posts
  from public.board_posts where author_id = target_user_uuid;
  delete from public.board_comments where author_id = target_user_uuid;
  delete from public.board_posts where author_id = target_user_uuid;
  delete from public.conversation_cards where author_id = target_user_uuid;
  delete from public.reports
  where reporter_id = target_user_uuid or reported_user_id = target_user_uuid;

  update public.moderation_actions
  set target_user_id = null,
      report_id = null,
      note = '[account deleted]',
      before_state = '{}'::jsonb,
      after_state = '{}'::jsonb
  where target_user_id = target_user_uuid;

  -- Purchase identifiers must remain unique for refund/idempotency handling, but
  -- RevenueCat payloads and the profile relation are no longer needed afterward.
  update public.point_purchase_receipts
  set user_id = null,
      raw_event = '{}'::jsonb,
      account_deleted_at = now(),
      updated_at = now()
  where user_id = target_user_uuid;

  update public.device_wallet_bindings
  set released_at = coalesce(released_at, now()),
      recovery_reason = 'account_deleted',
      user_id = null
  where user_id = target_user_uuid;

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
