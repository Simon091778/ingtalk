-- Recovery may discard only a phone-only account containing technical rows and
-- free rewards. Paid value, user activity, settings, storage, or ledger drift
-- requires manual review. Reward timestamps move to the canonical account;
-- balances and point transactions never do.
create table account_private.account_recovery_aliases (
  retired_account_id uuid primary key,
  canonical_account_id uuid not null references account_private.device_accounts(id) on delete cascade,
  reason text not null check(reason in ('verified_social_recovery','verified_phone_link')),
  created_at timestamptz not null default now()
);
revoke all on account_private.account_recovery_aliases from public,anon,authenticated;

create or replace function account_private.phone_recovery_disposition(aid uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare ledger_total bigint; wallet_total bigint;
begin
  if aid is null or (select count(*) from account_private.account_identities b where b.account_id=aid)<>1
    or not exists(select 1 from account_private.account_identities b where b.account_id=aid and b.provider='phone') then
    return 'identity_conflict';
  end if;
  if exists(select 1 from public.profiles p where p.id=aid and
      (p.status::text<>'active' or p.suspended_until is not null or p.suspension_reason is not null
       or p.trust_score<>0 or p.is_verified or nullif(p.introduction,'') is not null or p.avatar_url is not null
       or p.language_code<>'ko' or p.country_code<>'KR')) then return 'profile_activity'; end if;
  if exists(select 1 from public.point_purchase_receipts r where r.user_id=aid) then return 'purchase_value'; end if;
  if exists(select 1 from public.device_wallet_bindings d where d.user_id=aid) then return 'wallet_binding'; end if;
  if exists(select 1 from public.point_transactions t where t.user_id=aid and not (
      (t.reason in ('welcome_account','welcome_device') and t.amount=100)
      or (t.reason in ('reward_attendance','reward_talk_write','reward_board_post','reward_board_comment','reward_rewarded_ad') and t.amount=50)
    )) then return 'point_value'; end if;
  select coalesce(sum(t.amount),0) into ledger_total from public.point_transactions t where t.user_id=aid;
  select coalesce((select w.balance from public.point_wallets w where w.user_id=aid),0) into wallet_total;
  if wallet_total<>ledger_total then return 'ledger_mismatch'; end if;
  if exists(select 1 from account_private.rewarded_ad_claims c where c.account_id=aid and c.processed_at is null and c.expires_at>now()) then
    return 'pending_reward'; end if;
  if exists(select 1 from account_private.review_access r join account_private.account_identities b on b.auth_user_id=r.auth_user_id
      where b.account_id=aid and r.enabled and r.valid_until>now()) then return 'review_account'; end if;
  if exists(select 1 from public.notification_preferences n where n.user_id=aid and
      not (n.message_enabled and n.request_enabled and n.preview_enabled and n.sound_enabled and n.vibration_enabled)) then
    return 'custom_settings'; end if;
  if exists(select 1 from public.conversation_cards c where c.author_id=aid)
    or exists(select 1 from public.blocks b where b.blocker_id=aid or b.blocked_id=aid)
    or exists(select 1 from public.chat_requests c where c.sender_id=aid or c.receiver_id=aid)
    or exists(select 1 from public.chat_members c where c.user_id=aid)
    or exists(select 1 from public.messages m where m.sender_id=aid)
    or exists(select 1 from public.message_backups m where m.sender_id=aid or m.deleted_by_user_id=aid)
    or exists(select 1 from public.chat_rooms r where r.board_sender_id=aid or r.board_receiver_id=aid)
    or exists(select 1 from public.board_posts p where p.author_id=aid)
    or exists(select 1 from public.board_comments c where c.author_id=aid)
    or exists(select 1 from public.board_post_likes l where l.user_id=aid)
    or exists(select 1 from public.board_comment_likes l where l.user_id=aid)
    or exists(select 1 from public.board_post_dislikes l where l.user_id=aid)
    or exists(select 1 from public.hidden_discovery_cards h where h.user_id=aid)
    or exists(select 1 from public.reports r where r.reporter_id=aid or r.reported_user_id=aid)
    or exists(select 1 from public.moderation_actions m where m.target_user_id=aid)
    or exists(select 1 from public.support_threads s where s.user_id=aid)
    or exists(select 1 from public.support_messages s where s.sender_user_id=aid)
    or exists(select 1 from public.user_locations l where l.user_id=aid) then return 'user_activity'; end if;
  if exists(select 1 from storage.objects o where o.bucket_id in ('avatars','board-images','chat-images') and
      (split_part(o.name,'/',1)=aid::text or position('/'||aid::text||'/' in '/'||o.name||'/')>0)) then return 'storage_data'; end if;
  return 'discardable';
end $$;

create or replace function account_private.phone_transport_unambiguous(uid uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.users u where u.id=uid and u.phone_confirmed_at is not null
    and nullif(u.phone,'') is not null and nullif(u.phone_change,'') is null
    and not exists(select 1 from auth.users other where other.id<>u.id and nullif(other.phone_change,'')=u.phone));
$$;

create or replace function account_private.identity_hash(uid uuid,provider_name text) returns text
language sql stable security definer set search_path='' as $$
  select case when provider_name='google' then account_private.google_identity_hash(uid)
    when provider_name='kakao' then account_private.kakao_identity_hash(uid)
    when provider_name='phone' then (select account_private.hash_phone(u.phone) from auth.users u
      where u.id=uid and account_private.phone_transport_unambiguous(u.id)
        and nullif(u.email,'') is null and not coalesce(u.is_anonymous,false)
        and not exists(select 1 from auth.identities i where i.user_id=uid and i.provider<>'phone')) end;
$$;

do $migration$
declare definition text;
  old_source_policy text:=$old$and (select count(*) from account_private.account_identities where account_id=r.account_id)=1
      and device_count=1
      and (exists(select 1 from public.profiles where id=other_id)
        or exists(select 1 from public.point_wallets where user_id=other_id))$old$;
  new_source_policy text:=$new$and (select count(*) from account_private.account_identities where account_id=r.account_id)=1
      and device_count=1
      and account_private.phone_recovery_disposition(r.account_id)='discardable'
      and (exists(select 1 from public.profiles where id=other_id)
        or exists(select 1 from public.point_wallets where user_id=other_id))$new$;
  old_target_phone_guard text:=$old$or exists(select 1 from account_private.account_identities where account_id=other_id and provider='phone')$old$;
  new_target_phone_guard text:=$new$or exists(select 1 from account_private.account_identities b where b.account_id=other_id and b.provider='phone'
          and b.identity_hash<>source_identity.identity_hash)
        or exists(select 1 from account_private.account_identities b where b.provider='phone'
          and b.identity_hash=source_identity.identity_hash and b.account_id not in (r.account_id,other_id))$new$;
  old_source_move text:=$old$perform public.delete_account_data(r.account_id);
      update account_private.account_identities set account_id=other_id
        where account_id=r.account_id and auth_user_id=r.source_user and provider='phone';$old$;
  new_source_move text:=$new$insert into account_private.account_recovery_aliases(retired_account_id,canonical_account_id,reason)
        values(r.account_id,other_id,'verified_social_recovery') on conflict(retired_account_id) do nothing;
      if exists(select 1 from account_private.account_recovery_aliases a where a.retired_account_id=r.account_id and a.canonical_account_id<>other_id) then
        return jsonb_build_object('error','account_link_conflict'); end if;
      insert into public.point_reward_claims(user_id,reward_type,claimed_at)
        select other_id,c.reward_type,c.claimed_at from public.point_reward_claims c where c.user_id=r.account_id
        on conflict(user_id,reward_type) do update set claimed_at=greatest(public.point_reward_claims.claimed_at,excluded.claimed_at);
      perform public.delete_account_data(r.account_id);
      if exists(select 1 from account_private.account_identities b where b.account_id=other_id and b.provider='phone'
          and b.identity_hash=source_identity.identity_hash) then
        delete from account_private.account_identities where account_id=r.account_id and auth_user_id=r.source_user and provider='phone';
      else
        update account_private.account_identities set account_id=other_id
          where account_id=r.account_id and auth_user_id=r.source_user and provider='phone';
      end if;$new$;
  old_source_branch text:=$old$    if source_shell then$old$;
  new_source_branch text:=$new$    if not source_shell and source_identity.provider='phone'
        and account_private.identity_active(source_identity)
        and (select count(*) from account_private.account_identities where account_id=r.account_id)=1
        and device_count=1
        and (exists(select 1 from public.profiles where id=other_id)
          or exists(select 1 from public.point_wallets where user_id=other_id))
        and account_private.phone_recovery_disposition(r.account_id)<>'discardable' then
      return jsonb_build_object('error','manual_merge_required');
    end if;
    if source_shell then$new$;
  old_takeover_validation text:=$old$if not exists(select 1 from account_private.account_identities b where b.account_id=r.account_id
        and b.provider in ('google','kakao') and account_private.identity_active(b))
      or exists(select 1 from unnest(target_account_ids) target(account_id) where$old$;
  new_takeover_validation text:=$new$if cardinality(target_account_ids)<>1 then return jsonb_build_object('error','account_link_conflict'); end if;
    if account_private.phone_recovery_disposition(other_id)<>'discardable' then
      return jsonb_build_object('error','manual_merge_required'); end if;
    if not exists(select 1 from account_private.account_identities b where b.account_id=r.account_id
        and b.provider in ('google','kakao') and account_private.identity_active(b))
      or exists(select 1 from unnest(target_account_ids) target(account_id) where$new$;
  old_takeover_delete text:=$old$foreach target_id in array target_account_ids loop
      perform public.delete_account_data(target_id);
      delete from account_private.device_accounts where id=target_id;
    end loop;$old$;
  new_takeover_delete text:=$new$foreach target_id in array target_account_ids loop
      insert into account_private.account_recovery_aliases(retired_account_id,canonical_account_id,reason)
        values(target_id,r.account_id,'verified_phone_link') on conflict(retired_account_id) do nothing;
      if exists(select 1 from account_private.account_recovery_aliases a where a.retired_account_id=target_id and a.canonical_account_id<>r.account_id) then
        return jsonb_build_object('error','account_link_conflict'); end if;
      insert into public.point_reward_claims(user_id,reward_type,claimed_at)
        select r.account_id,c.reward_type,c.claimed_at from public.point_reward_claims c where c.user_id=target_id
        on conflict(user_id,reward_type) do update set claimed_at=greatest(public.point_reward_claims.claimed_at,excluded.claimed_at);
      perform public.delete_account_data(target_id);
      delete from account_private.device_accounts where id=target_id;
    end loop;$new$;
begin
  definition:=pg_get_functiondef('public.finish_account_link(text,text,text,text)'::regprocedure);
  if position(old_source_policy in definition)=0 then raise exception 'recovery_source_policy_missing'; end if;
  definition:=replace(definition,old_source_policy,new_source_policy);
  if position(old_target_phone_guard in definition)=0 then raise exception 'recovery_target_phone_guard_missing'; end if;
  definition:=replace(definition,old_target_phone_guard,new_target_phone_guard);
  if position(old_source_move in definition)=0 then raise exception 'recovery_source_move_missing'; end if;
  definition:=replace(definition,old_source_move,new_source_move);
  if position(old_source_branch in definition)=0 then raise exception 'recovery_source_branch_missing'; end if;
  definition:=replace(definition,old_source_branch,new_source_branch);
  if position(old_takeover_validation in definition)=0 then raise exception 'phone_takeover_validation_missing'; end if;
  definition:=replace(definition,old_takeover_validation,new_takeover_validation);
  if position(old_takeover_delete in definition)=0 then raise exception 'phone_takeover_delete_missing'; end if;
  execute replace(definition,old_takeover_delete,new_takeover_delete);
end $migration$;

do $migration$
declare definition text;
  insertion_point text:=$old$      foreach prior_account in array prior_phone_accounts loop$old$;
  hardened text:=$new$      if cardinality(prior_phone_accounts)>1 then return jsonb_build_object('error','account_resolution_required'); end if;
      if exists(select 1 from unnest(prior_phone_accounts) target(account_id)
        where not exists(select 1 from account_private.account_identities s where s.account_id=target.account_id and s.provider in ('google','kakao'))
          and account_private.phone_recovery_disposition(target.account_id)<>'discardable') then
        return jsonb_build_object('error','manual_merge_required'); end if;
      foreach prior_account in array prior_phone_accounts loop$new$;
begin
  definition:=pg_get_functiondef('account_private.authorize_identity(text,text,text,text)'::regprocedure);
  if position(insertion_point in definition)=0 then raise exception 'phone_reassignment_hardening_point_missing'; end if;
  execute replace(definition,insertion_point,hardened);
end $migration$;

revoke all on function account_private.phone_recovery_disposition(uuid),account_private.phone_transport_unambiguous(uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
