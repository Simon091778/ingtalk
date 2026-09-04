-- chat_rooms.request_id is RESTRICT. A room may exist before chat_members rows
-- are populated, so deletion must discover rooms through both membership and
-- their originating request before deleting chat_requests.
create or replace function public.delete_account_data(target_user_uuid uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $delete_account_data$
declare
  affected_room_ids uuid[] := '{}';
  deleted_rooms integer := 0;
  deleted_posts integer := 0;
  deleted_messages integer := 0;
  audit_uuid uuid;
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'service_role_required';
  end if;
  if target_user_uuid is null then raise exception 'target_user_required'; end if;

  select coalesce(array_agg(room.id order by room.id), '{}') into affected_room_ids
  from public.chat_rooms room
  where exists (
      select 1 from public.chat_members member
      where member.room_id=room.id and member.user_id=target_user_uuid
    )
    or exists (
      select 1 from public.chat_requests request
      where request.id=room.request_id
        and target_user_uuid in (request.sender_id,request.receiver_id)
    )
    or target_user_uuid in (room.board_sender_id,room.board_receiver_id);

  select count(*) into deleted_messages
  from public.messages message
  where message.room_id=any(affected_room_ids);

  -- Backups are retained only for the configured moderation/retention period.
  -- Remove the departing user's identity and message/photo content immediately.
  update public.message_backups
  set sender_id='00000000-0000-0000-0000-000000000000'::uuid,
      body='[account deleted]',
      image_path=null,
      image_width=null,
      image_height=null
  where sender_id=target_user_uuid;

  with removed as (
    delete from public.chat_rooms room
    where room.id=any(affected_room_ids)
    returning room.id
  ) select count(*) into deleted_rooms from removed;

  -- All referencing rooms are gone, so the RESTRICT FK can no longer abort the
  -- account-recovery transaction at this point.
  delete from public.chat_requests
  where target_user_uuid in (sender_id,receiver_id);

  select count(*) into deleted_posts
  from public.board_posts where author_id=target_user_uuid;
  delete from public.board_comments where author_id=target_user_uuid;
  delete from public.board_posts where author_id=target_user_uuid;
  delete from public.conversation_cards where author_id=target_user_uuid;
  delete from public.reports
  where reporter_id=target_user_uuid or reported_user_id=target_user_uuid;

  update public.moderation_actions
  set target_user_id=null,
      report_id=null,
      note='[account deleted]',
      before_state='{}'::jsonb,
      after_state='{}'::jsonb
  where target_user_id=target_user_uuid;

  -- Purchase identifiers remain for refund/idempotency handling, detached from
  -- the deleted profile and stripped of the provider payload.
  update public.point_purchase_receipts
  set user_id=null,
      raw_event='{}'::jsonb,
      account_deleted_at=now(),
      updated_at=now()
  where user_id=target_user_uuid;

  update public.device_wallet_bindings
  set released_at=coalesce(released_at,now()),
      recovery_reason='account_deleted',
      user_id=null
  where user_id=target_user_uuid;

  delete from public.profiles where id=target_user_uuid;

  insert into public.account_deletion_audit default values returning id into audit_uuid;
  return jsonb_build_object(
    'audit_id',audit_uuid,
    'deleted_rooms',deleted_rooms,
    'deleted_messages',deleted_messages,
    'deleted_posts',deleted_posts
  );
end;
$delete_account_data$;

revoke all on function public.delete_account_data(uuid) from public,anon,authenticated;
grant execute on function public.delete_account_data(uuid) to service_role;
notify pgrst,'reload schema';
