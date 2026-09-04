begin;

alter table account_private.account_recovery_aliases
  drop constraint account_recovery_aliases_reason_check;
alter table account_private.account_recovery_aliases
  add constraint account_recovery_aliases_reason_check
  check(reason in ('verified_social_recovery','verified_phone_link','verified_account_merge'));

create table account_private.account_merge_audit (
  id uuid primary key default gen_random_uuid(),
  survivor_account_id uuid not null,
  losing_account_id uuid not null unique,
  source_session_id uuid not null,
  verified_session_id uuid not null,
  verified_provider text not null check(verified_provider in ('phone','google','kakao')),
  survivor_balance bigint not null,
  losing_balance bigint not null,
  merged_balance bigint not null,
  losing_point_ledger jsonb not null,
  asset_counts jsonb not null,
  created_at timestamptz not null default now(),
  check(survivor_account_id<>losing_account_id),
  check(merged_balance=greatest(survivor_balance,losing_balance))
);
revoke all on account_private.account_merge_audit from public,anon,authenticated;
grant select on account_private.account_merge_audit to service_role;

create function account_private.merge_verified_accounts(
  survivor uuid,loser uuid,source_session uuid,verified_session uuid,verified_provider text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  survivor_balance bigint:=0;
  loser_balance bigint:=0;
  final_balance bigint:=0;
  loser_ledger jsonb:='[]'::jsonb;
  counts jsonb;
  survivor_support uuid;
  loser_support uuid;
begin
  if survivor is null or loser is null or survivor=loser
      or verified_provider not in ('phone','google','kakao') then
    raise exception 'invalid_verified_account_merge';
  end if;
  perform 1 from account_private.device_accounts
    where id in(survivor,loser) order by id for update;
  if (select count(*) from account_private.device_accounts where id in(survivor,loser))<>2 then
    raise exception 'account_merge_missing_principal';
  end if;

  -- An explicit link proves ownership, but it does not resolve incompatible
  -- duplicate provider slots or ambiguous user-to-user relationships.
  if exists(select 1 from account_private.account_identities a
      join account_private.account_identities b on b.account_id=loser
        and (b.provider=a.provider or b.auth_user_id=a.auth_user_id)
      where a.account_id=survivor)
    or exists(select 1 from account_private.account_devices a
      join account_private.account_devices b on b.account_id=loser
        and (b.device_hash=a.device_hash or b.device_scope_hash=a.device_scope_hash)
      where a.account_id=survivor)
    or exists(select 1 from public.blocks where blocker_id in(survivor,loser)
        and blocked_id in(survivor,loser))
    or exists(select 1 from public.chat_requests where sender_id in(survivor,loser)
        and receiver_id in(survivor,loser))
    or exists(select 1 from public.reports where reporter_id in(survivor,loser)
        and reported_user_id in(survivor,loser))
    or exists(select 1 from public.open_chat_room_bans where user_id in(survivor,loser)
        and banned_by in(survivor,loser))
    or (exists(select 1 from public.open_chat_participants where user_id=survivor)
        and exists(select 1 from public.open_chat_participants where user_id=loser
          and room_id not in(select room_id from public.open_chat_participants where user_id=survivor))) then
    raise exception 'account_merge_asset_conflict';
  end if;

  perform 1 from public.point_wallets where user_id in(survivor,loser)
    order by user_id for update;
  select coalesce((select balance from public.point_wallets where user_id=survivor),0),
         coalesce((select balance from public.point_wallets where user_id=loser),0)
    into survivor_balance,loser_balance;
  final_balance:=greatest(survivor_balance,loser_balance);
  select coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'amount',amount,'reason',reason,'reference_id',reference_id,'created_at',created_at)
      order by id),'[]'::jsonb)
    into loser_ledger from public.point_transactions where user_id=loser;
  counts:=jsonb_build_object(
    'posts',(select count(*) from public.board_posts where author_id=loser),
    'comments',(select count(*) from public.board_comments where author_id=loser),
    'messages',(select count(*) from public.messages where sender_id=loser),
    'purchases',(select count(*) from public.point_purchase_receipts where user_id=loser),
    'conversation_cards',(select count(*) from public.conversation_cards where author_id=loser));

  insert into account_private.account_recovery_aliases(
    retired_account_id,canonical_account_id,reason)
    values(loser,survivor,'verified_account_merge')
    on conflict(retired_account_id) do nothing;
  if exists(select 1 from account_private.account_recovery_aliases
      where retired_account_id=loser and canonical_account_id<>survivor) then
    raise exception 'account_merge_alias_conflict';
  end if;

  -- Points are not additive. The existing audited adjustment raises only the
  -- lower survivor balance to MAX; the losing ledger is retained in the merge
  -- audit before its principal is retired.
  perform account_private.preserve_higher_point_balance(loser,survivor);
  insert into public.point_reward_claims(user_id,reward_type,claimed_at)
    select survivor,reward_type,claimed_at from public.point_reward_claims where user_id=loser
    on conflict(user_id,reward_type) do update
      set claimed_at=greatest(public.point_reward_claims.claimed_at,excluded.claimed_at);
  delete from public.point_reward_claims where user_id=loser;
  update public.point_purchase_receipts set user_id=survivor,updated_at=now() where user_id=loser;
  update public.rewarded_ad_verifications set user_id=survivor where user_id=loser;
  update account_private.rewarded_ad_claims set account_id=survivor where account_id=loser;

  update public.conversation_cards set author_id=survivor where author_id=loser;
  update public.board_posts set author_id=survivor where author_id=loser;
  update public.board_comments set author_id=survivor where author_id=loser;
  update public.messages set sender_id=survivor where sender_id=loser;
  update public.message_backups set sender_id=survivor where sender_id=loser;
  update public.message_backups set deleted_by_user_id=survivor where deleted_by_user_id=loser;
  update public.chat_requests set sender_id=survivor where sender_id=loser;
  update public.chat_requests set receiver_id=survivor where receiver_id=loser;
  update public.chat_rooms set board_sender_id=survivor where board_sender_id=loser;
  update public.chat_rooms set board_receiver_id=survivor where board_receiver_id=loser;

  insert into public.chat_members(room_id,user_id,joined_at,last_read_at)
    select room_id,survivor,joined_at,last_read_at from public.chat_members where user_id=loser
    on conflict(room_id,user_id) do update set
      joined_at=least(public.chat_members.joined_at,excluded.joined_at),
      last_read_at=greatest(public.chat_members.last_read_at,excluded.last_read_at);
  delete from public.chat_members where user_id=loser;

  insert into public.board_post_likes(post_id,user_id,created_at)
    select post_id,survivor,created_at from public.board_post_likes where user_id=loser
    on conflict(post_id,user_id) do nothing;
  delete from public.board_post_likes where user_id=loser;
  insert into public.board_post_dislikes(post_id,user_id,created_at)
    select post_id,survivor,created_at from public.board_post_dislikes where user_id=loser
    on conflict(post_id,user_id) do nothing;
  delete from public.board_post_dislikes where user_id=loser;
  insert into public.board_comment_likes(comment_id,user_id,created_at)
    select comment_id,survivor,created_at from public.board_comment_likes where user_id=loser
    on conflict(comment_id,user_id) do nothing;
  delete from public.board_comment_likes where user_id=loser;
  insert into public.hidden_discovery_cards(user_id,card_id,hidden_at)
    select survivor,card_id,hidden_at from public.hidden_discovery_cards where user_id=loser
    on conflict(user_id,card_id) do nothing;
  delete from public.hidden_discovery_cards where user_id=loser;

  insert into public.blocks(blocker_id,blocked_id,created_at)
    select case when blocker_id=loser then survivor else blocker_id end,
      case when blocked_id=loser then survivor else blocked_id end,created_at
    from public.blocks where blocker_id=loser or blocked_id=loser
    on conflict(blocker_id,blocked_id) do nothing;
  delete from public.blocks where blocker_id=loser or blocked_id=loser;
  update public.reports set reporter_id=survivor where reporter_id=loser;
  update public.reports set reported_user_id=survivor where reported_user_id=loser;
  update public.moderation_actions set target_user_id=survivor where target_user_id=loser;

  insert into public.open_chat_participants(room_id,user_id,joined_at,last_read_at)
    select room_id,survivor,joined_at,last_read_at from public.open_chat_participants where user_id=loser
    on conflict(room_id,user_id) do update set
      joined_at=least(public.open_chat_participants.joined_at,excluded.joined_at),
      last_read_at=greatest(public.open_chat_participants.last_read_at,excluded.last_read_at);
  delete from public.open_chat_participants where user_id=loser;
  update public.open_chat_rooms set owner_user_id=survivor where owner_user_id=loser;
  update public.open_chat_messages set sender_user_id=survivor where sender_user_id=loser;
  insert into public.open_chat_room_bans(room_id,user_id,banned_by,created_at)
    select room_id,survivor,case when banned_by=loser then survivor else banned_by end,created_at
      from public.open_chat_room_bans where user_id=loser
    on conflict(room_id,user_id) do nothing;
  delete from public.open_chat_room_bans where user_id=loser;
  update public.open_chat_room_bans set banned_by=survivor where banned_by=loser;

  select id into survivor_support from public.support_threads where user_id=survivor for update;
  select id into loser_support from public.support_threads where user_id=loser for update;
  if loser_support is not null and survivor_support is not null then
    update public.support_messages set thread_id=survivor_support where thread_id=loser_support;
    delete from public.support_threads where id=loser_support;
  elsif loser_support is not null then
    update public.support_threads set user_id=survivor where id=loser_support;
  end if;
  update public.support_messages set sender_user_id=survivor where sender_user_id=loser;

  insert into public.notification_preferences(
    user_id,message_enabled,request_enabled,preview_enabled,sound_enabled,vibration_enabled,updated_at)
    select survivor,message_enabled,request_enabled,preview_enabled,sound_enabled,vibration_enabled,updated_at
      from public.notification_preferences where user_id=loser
    on conflict(user_id) do nothing;
  delete from public.notification_preferences where user_id=loser;
  if not exists(select 1 from public.user_locations where user_id=survivor) then
    update public.user_locations set user_id=survivor where user_id=loser;
  else
    delete from public.user_locations where user_id=loser;
  end if;
  update public.device_wallet_bindings set user_id=survivor where user_id=loser;
  update public.push_notifications set user_id=survivor where user_id=loser;

  -- Losing sessions and push endpoints are revoked, not inherited. The newly
  -- verified session is rebound by finish_account_link after this helper.
  delete from public.push_tokens where user_id=loser
    or auth_session_id in(select session_id from account_private.sessions where account_id=loser);
  delete from auth.sessions where id in(
      select session_id from account_private.sessions where account_id=loser)
    and id<>verified_session;
  delete from account_private.sessions where account_id=loser;
  delete from account_private.account_link_requests where account_id=loser;

  update account_private.phone_device_bindings set account_id=survivor where account_id=loser;
  update account_private.account_devices set is_primary=false where account_id=loser;
  update account_private.account_devices set account_id=survivor where account_id=loser;
  update account_private.account_identities set account_id=survivor where account_id=loser;

  insert into account_private.account_merge_audit(
    survivor_account_id,losing_account_id,source_session_id,verified_session_id,
    verified_provider,survivor_balance,losing_balance,merged_balance,
    losing_point_ledger,asset_counts)
  values(survivor,loser,source_session,verified_session,verified_provider,
    survivor_balance,loser_balance,final_balance,loser_ledger,counts);

  delete from account_private.device_accounts where id=loser;
  return jsonb_build_object('ok',true,'account_id',survivor,'merged',true,
    'merged_balance',final_balance);
end $$;

revoke all on function account_private.merge_verified_accounts(uuid,uuid,uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function account_private.merge_verified_accounts(uuid,uuid,uuid,uuid,text)
  to service_role;

-- Replace only the established-account conflict branch. All validation above
-- it (source session, device binding, fresh target proof, suspension/deletion)
-- remains mandatory, and no normal login resolver calls the merge helper.
do $migration$
declare
  definition text:=pg_get_functiondef('public.finish_account_link(text,text,text,text)'::regprocedure);
  old_guard text:=$old$if other_id is not null
      and account_private.account_is_established(r.account_id)
      and account_private.account_is_established(other_id) then
    return jsonb_build_object('error','account_link_conflict');
  end if;$old$;
  verified_merge text:=$new$if other_id is not null
      and account_private.account_is_established(r.account_id)
      and account_private.account_is_established(other_id) then
    if identity_count<>1 then return jsonb_build_object('error','account_link_conflict'); end if;
    perform account_private.merge_verified_accounts(
      r.account_id,other_id,r.source_session,sid,provider_name);
    insert into account_private.sessions(session_id,user_id,account_id,device_id,expires_at)
      values(sid,uid,r.account_id,binding_id,now()+interval '30 days')
      on conflict(session_id) do update set user_id=excluded.user_id,
        account_id=excluded.account_id,device_id=excluded.device_id,expires_at=excluded.expires_at;
    update account_private.account_link_requests set used_at=now() where token_hash=r.token_hash;
    return jsonb_build_object('ok',true,'account_id',r.account_id,'merged',true);
  end if;$new$;
begin
  if position(old_guard in definition)=0 then
    raise exception 'finish_account_link established merge anchor not found';
  end if;
  execute replace(definition,old_guard,verified_merge);
end $migration$;

notify pgrst,'reload schema';
commit;
