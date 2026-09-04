-- Only a genuinely disposable Phone bootstrap principal may be retired during
-- verified Google/Kakao recovery. Preserve purchases, spending, user activity,
-- custom data and unexplained accounting differences. Record only the legacy
-- 1,000P opening balance that can be proven to predate explicit welcome ledgers.
create table account_private.point_wallet_historical_baselines (
  account_id uuid primary key references account_private.device_accounts(id) on delete cascade,
  amount bigint not null check(amount=1000),
  source text not null check(source='migration_024_opening_balance'),
  recorded_at timestamptz not null default now()
);
revoke all on account_private.point_wallet_historical_baselines from public,anon,authenticated;

with explicit_ledger_start as (
  select min(created_at) as created_at from public.point_transactions where reason='welcome_device'
), ledger as (
  select user_id,coalesce(sum(amount),0) amount from public.point_transactions group by user_id
)
insert into account_private.point_wallet_historical_baselines(account_id,amount,source)
select p.id,1000,'migration_024_opening_balance'
from public.profiles p
join account_private.device_accounts a on a.id=p.id
join public.point_wallets w on w.user_id=p.id
left join ledger l on l.user_id=p.id
cross join explicit_ledger_start cutoff
where cutoff.created_at is not null
  and p.created_at<cutoff.created_at
  and p.welcome_points_claimed
  and w.balance-coalesce(l.amount,0)=1000
on conflict(account_id) do nothing;

create or replace function account_private.phone_recovery_rejection_reason(aid uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare ledger_total bigint; wallet_total bigint; baseline_total bigint;
begin
  if aid is null or (select count(*) from account_private.account_identities b where b.account_id=aid)<>1
    or not exists(select 1 from account_private.account_identities b where b.account_id=aid and b.provider='phone') then
    return 'identity_conflict';
  end if;
  if exists(select 1 from public.point_purchase_receipts r where r.user_id=aid) then return 'purchase_exists'; end if;
  if exists(select 1 from public.point_transactions t where t.user_id=aid and t.reason='admin_adjustment') then
    return 'admin_adjustment_exists'; end if;
  if exists(select 1 from public.point_transactions t where t.user_id=aid
      and t.reason in ('point_purchase','point_purchase_refund')) then return 'purchase_ledger_exists'; end if;
  if exists(select 1 from public.point_transactions t where t.user_id=aid and t.amount<0) then return 'point_spent'; end if;
  if exists(select 1 from public.point_transactions t where t.user_id=aid and not (
      (t.reason='welcome_account' and t.amount=100)
      or (t.reason='welcome_device' and t.amount in (100,1000))
      or (t.reason in ('reward_attendance','reward_talk_write','reward_board_post','reward_board_comment','reward_rewarded_ad') and t.amount=50)
    )) then return 'point_value'; end if;

  select coalesce(sum(t.amount),0) into ledger_total from public.point_transactions t where t.user_id=aid;
  select coalesce((select w.balance from public.point_wallets w where w.user_id=aid),0) into wallet_total;
  select coalesce((select b.amount from account_private.point_wallet_historical_baselines b where b.account_id=aid),0)
    into baseline_total;
  if wallet_total<>baseline_total+ledger_total then return 'ledger_mismatch'; end if;

  if exists(select 1 from public.device_wallet_bindings b
      left join public.device_point_wallets w on w.id=b.wallet_id
      where b.user_id=aid and b.released_at is null
        and (w.id is null or w.status<>'active' or w.balance<>wallet_total)) then return 'wallet_binding'; end if;
  if exists(select 1 from account_private.rewarded_ad_claims c
      where c.account_id=aid and c.processed_at is null and c.expires_at>now()) then return 'pending_reward'; end if;
  if exists(select 1 from account_private.review_access r join account_private.account_identities b on b.auth_user_id=r.auth_user_id
      where b.account_id=aid and r.enabled and r.valid_until>now()) then return 'review_account'; end if;

  if exists(select 1 from public.profiles p where p.id=aid and
      (p.status::text<>'active' or p.suspended_until is not null or p.suspension_reason is not null
       or p.trust_score<>0 or p.is_verified or nullif(p.introduction,'') is not null or p.avatar_url is not null
       or p.language_code<>'ko' or p.country_code<>'KR')) then return 'profile_activity'; end if;
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
      (split_part(o.name,'/',1)=aid::text or position('/'||aid::text||'/' in '/'||o.name||'/')>0)) then return 'storage_exists'; end if;
  return null;
end $$;

create or replace function account_private.phone_recovery_disposition(aid uuid) returns text
language sql stable security definer set search_path='' as $$
  select coalesce(account_private.phone_recovery_rejection_reason(aid),'discardable');
$$;

do $migration$
declare definition text;
  old_source text:=$old$and account_private.phone_recovery_disposition(r.account_id)<>'discardable' then
      return jsonb_build_object('error','manual_merge_required');$old$;
  new_source text:=$new$and account_private.phone_recovery_disposition(r.account_id)<>'discardable' then
      return jsonb_build_object('error','manual_merge_required',
        'reason',account_private.phone_recovery_rejection_reason(r.account_id));$new$;
  old_takeover text:=$old$if account_private.phone_recovery_disposition(other_id)<>'discardable' then
      return jsonb_build_object('error','manual_merge_required'); end if;$old$;
  new_takeover text:=$new$if account_private.phone_recovery_disposition(other_id)<>'discardable' then
      return jsonb_build_object('error','manual_merge_required',
        'reason',account_private.phone_recovery_rejection_reason(other_id)); end if;$new$;
begin
  definition:=pg_get_functiondef('public.finish_account_link(text,text,text,text)'::regprocedure);
  if position(old_source in definition)=0 then raise exception 'phone_recovery_reason_source_guard_missing'; end if;
  definition:=replace(definition,old_source,new_source);
  if position(old_takeover in definition)=0 then raise exception 'phone_recovery_reason_takeover_guard_missing'; end if;
  execute replace(definition,old_takeover,new_takeover);
end $migration$;

revoke all on function account_private.phone_recovery_rejection_reason(uuid),
  account_private.phone_recovery_disposition(uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
