-- Reduce only synthetic review grants; ordinary signup/ad/purchase points are unchanged.
create or replace function account_private.prepare_review_account(aid uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare uid uuid; ph text;
begin
  -- Serialize with login/link/delete; never trust user-editable Auth metadata.
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  select a.auth_user_id,a.phone_hash into uid,ph
  from account_private.device_accounts a
  join account_private.review_access r on r.auth_user_id=a.auth_user_id and r.phone_hash=a.phone_hash
  join auth.users u on u.id=a.auth_user_id
  where a.id=aid and a.auth_provider='phone' and r.enabled and r.valid_until>now()
    and u.phone ~ '^120255501[0-9]{2}$'
    and account_private.identity_hash(u.id,'phone')=r.phone_hash
    and (u.banned_until is null or u.banned_until<now())
    and not exists(select 1 from account_private.identity_deletions d where d.auth_user_id=u.id)
    and exists(select 1 from account_private.account_identities b where b.account_id=aid
      and b.provider='phone' and b.auth_user_id=u.id and b.identity_hash=r.phone_hash);
  if uid is null then return false; end if;
  -- Only a new synthetic profile receives the one-time review balance. Never
  -- overwrite an existing profile, restore spent points, or undo moderation.
  insert into public.profiles(id,nickname,birth_year,region_code,gender,introduction,
    language_code,country_code,welcome_points_claimed)
  values(aid,'Review'||left(replace(aid::text,'-',''),3),1990,'UNSET','other',
    'Synthetic app review account.','en','KR',true)
  on conflict(id) do nothing;
  if not found then return false; end if;
  -- This is a review grant, not a purchase or an ad reward. Keep an audit ledger.
  update public.point_wallets set balance=balance+1000,updated_at=now() where user_id=aid;
  if not found then raise exception 'wallet_missing'; end if;
  insert into public.point_transactions(user_id,amount,reason,reference_id)
    values(aid,1000,'review_access',aid);
  return true;
end $$;
revoke all on function account_private.prepare_review_account(uuid) from public,anon,authenticated;

-- Keep the original grant and append a traceable correction. This routine is
-- private, idempotent, and accepts no arbitrary account/amount from a client.
create function account_private.reduce_legacy_review_grants() returns integer
language plpgsql security definer set search_path='' as $$
declare item record; adjusted integer:=0;
begin
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  for item in
    select w.user_id,w.balance from public.point_wallets w
    join account_private.device_accounts a on a.id=w.user_id and a.auth_provider='phone'
    join account_private.review_access r on r.auth_user_id=a.auth_user_id and r.phone_hash=a.phone_hash
    join auth.users u on u.id=r.auth_user_id and u.phone ~ '^120255501[0-9]{2}$'
    where exists(select 1 from public.point_transactions t where t.user_id=w.user_id
      and t.reason='review_access' and t.reference_id=w.user_id and t.amount=10000)
    and not exists(select 1 from public.point_transactions t where t.user_id=w.user_id
      and t.reason='review_access_adjustment' and t.reference_id=w.user_id)
    order by w.user_id for update of w
  loop
    -- Never produce a negative balance or silently remove later earned points
    -- on a second run. Insufficient balances require an explicit manual decision.
    if item.balance<9000 then raise exception 'review_grant_adjustment_requires_manual_review'; end if;
    update public.point_wallets set balance=balance-9000,updated_at=now() where user_id=item.user_id;
    insert into public.point_transactions(user_id,amount,reason,reference_id)
      values(item.user_id,-9000,'review_access_adjustment',item.user_id);
    adjusted:=adjusted+1;
  end loop;
  return adjusted;
end $$;
revoke all on function account_private.reduce_legacy_review_grants() from public,anon,authenticated;
select account_private.reduce_legacy_review_grants();

