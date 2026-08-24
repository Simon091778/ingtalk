-- Reinstall recovery predates regional preferences and several later user-owned
-- tables. Move those rows too, and return the restored language/country so the
-- app can ask the user to confirm them once.
create or replace function public.restore_device_account(device_fingerprint text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  normalized_hash text := lower(trim(coalesce(device_fingerprint, '')));
  wallet public.device_point_wallets;
  previous_user uuid;
  target_user_uuid uuid := auth.uid();
  restored_profile jsonb;
begin
  if target_user_uuid is null then raise exception 'authentication_required'; end if;
  if normalized_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_device_fingerprint'; end if;
  perform pg_advisory_xact_lock(hashtextextended(normalized_hash, 0));

  select * into wallet from public.device_point_wallets where device_hash = normalized_hash for update;
  if wallet.id is null then return jsonb_build_object('recovered', false); end if;
  if wallet.status <> 'active' then raise exception 'device_wallet_restricted'; end if;

  select binding.user_id into previous_user from public.device_wallet_bindings binding
  where binding.wallet_id = wallet.id and binding.released_at is null for update;
  update public.device_point_wallets set last_seen_at = now() where id = wallet.id;
  if previous_user is null or previous_user = target_user_uuid then return jsonb_build_object('recovered', false); end if;
  if not exists (select 1 from public.profiles where id = previous_user) then
    update public.device_wallet_bindings set released_at = now(), recovery_reason = 'account_deleted'
    where wallet_id = wallet.id and released_at is null;
    return jsonb_build_object('recovered', false, 'balance_available', wallet.balance);
  end if;
  if exists (select 1 from public.profiles where id = target_user_uuid) then raise exception 'recovery_target_already_has_profile'; end if;

  insert into public.profiles (
    id, nickname, birth_year, region_code, introduction, trust_score, is_verified,
    status, created_at, updated_at, gender, interests, avatar_url,
    suspended_until, suspension_reason, welcome_points_claimed, language_code, country_code
  )
  select target_user_uuid, nickname, birth_year, region_code, introduction, trust_score, is_verified,
    status, created_at, now(), gender, interests, avatar_url,
    suspended_until, suspension_reason, true, language_code, country_code
  from public.profiles where id = previous_user;

  update public.chat_members set user_id = target_user_uuid where user_id = previous_user;
  update public.messages set sender_id = target_user_uuid where sender_id = previous_user;
  update public.message_backups set sender_id = target_user_uuid where sender_id = previous_user;
  update public.chat_requests set sender_id = target_user_uuid where sender_id = previous_user;
  update public.chat_requests set receiver_id = target_user_uuid where receiver_id = previous_user;
  update public.chat_rooms set board_sender_id = target_user_uuid where board_sender_id = previous_user;
  update public.chat_rooms set board_receiver_id = target_user_uuid where board_receiver_id = previous_user;
  update public.reports set reporter_id = target_user_uuid where reporter_id = previous_user;
  update public.reports set reported_user_id = target_user_uuid where reported_user_id = previous_user;
  update public.conversation_cards set author_id = target_user_uuid where author_id = previous_user;
  update public.board_posts set author_id = target_user_uuid where author_id = previous_user;
  update public.board_comments set author_id = target_user_uuid where author_id = previous_user;
  update public.board_post_likes set user_id = target_user_uuid where user_id = previous_user;
  update public.board_comment_likes set user_id = target_user_uuid where user_id = previous_user;
  update public.board_post_dislikes set user_id = target_user_uuid where user_id = previous_user;
  update public.user_locations set user_id = target_user_uuid where user_id = previous_user;
  update public.push_notifications set user_id = target_user_uuid where user_id = previous_user;
  delete from public.push_tokens where user_id = target_user_uuid;
  update public.push_tokens set user_id = target_user_uuid where user_id = previous_user;
  update public.support_threads set user_id = target_user_uuid where user_id = previous_user;
  update public.support_messages set sender_user_id = target_user_uuid where sender_type = 'user' and sender_user_id = previous_user;
  update public.rewarded_ad_verifications set user_id = target_user_uuid where user_id = previous_user;
  update public.point_purchase_receipts set user_id = target_user_uuid where user_id = previous_user;

  insert into public.blocks(blocker_id, blocked_id, created_at)
  select case when blocker_id = previous_user then target_user_uuid else blocker_id end,
         case when blocked_id = previous_user then target_user_uuid else blocked_id end, created_at
  from public.blocks block where block.blocker_id = previous_user or block.blocked_id = previous_user
  on conflict do nothing;
  delete from public.blocks block where block.blocker_id = previous_user or block.blocked_id = previous_user;

  update public.point_transactions set user_id = target_user_uuid where user_id = previous_user;
  update public.point_reward_claims set user_id = target_user_uuid where user_id = previous_user;
  update public.point_wallets
  set user_id = target_user_uuid, balance = wallet.balance, updated_at = now()
  where user_id = previous_user;
  update public.device_wallet_bindings set released_at = now(), recovery_reason = 'reinstall'
  where wallet_id = wallet.id and released_at is null;
  insert into public.device_wallet_bindings(wallet_id, user_id, recovery_reason)
  values (wallet.id, target_user_uuid, 'reinstall');
  update public.moderation_actions set target_user_id = target_user_uuid where target_user_id = previous_user;
  delete from public.profiles where id = previous_user;

  select jsonb_build_object(
    'nickname', profile.nickname, 'birth_year', profile.birth_year, 'gender', profile.gender,
    'avatar_url', profile.avatar_url, 'language_code', profile.language_code, 'country_code', profile.country_code
  ) into restored_profile from public.profiles profile where profile.id = target_user_uuid;
  return jsonb_build_object('recovered', true, 'balance', wallet.balance, 'profile', restored_profile);
end;
$$;

revoke all on function public.restore_device_account(text) from public, anon;
grant execute on function public.restore_device_account(text) to authenticated;
notify pgrst, 'reload schema';
