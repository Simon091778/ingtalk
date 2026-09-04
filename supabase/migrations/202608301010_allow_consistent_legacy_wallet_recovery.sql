-- Legacy device-wallet rows are audit history, not automatically protected value.
-- A released binding cannot restore points, and an active binding is safe to
-- retire when its device balance exactly matches the account wallet/ledger.
-- Purchases, administrative value, ledger drift, restricted device wallets,
-- and pending callbacks continue to require manual review.
create or replace function account_private.phone_recovery_disposition(aid uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare ledger_total bigint; wallet_total bigint;
begin
  if aid is null or (select count(*) from account_private.account_identities b where b.account_id=aid)<>1
    or not exists(select 1 from account_private.account_identities b where b.account_id=aid and b.provider='phone') then
    return 'identity_conflict';
  end if;

  if exists(select 1 from public.point_purchase_receipts r where r.user_id=aid) then
    return 'purchase_value';
  end if;
  if exists(select 1 from public.point_transactions t where t.user_id=aid and not (
      (t.reason in ('welcome_account','welcome_device') and t.amount=100)
      or (t.reason in ('reward_attendance','reward_talk_write','reward_board_post','reward_board_comment','reward_rewarded_ad') and t.amount=50)
      or (t.reason in ('chat_request','profile_details_update') and t.amount=-100)
    )) then
    return 'point_value';
  end if;

  select coalesce(sum(t.amount),0) into ledger_total
    from public.point_transactions t where t.user_id=aid;
  select coalesce((select w.balance from public.point_wallets w where w.user_id=aid),0)
    into wallet_total;
  if wallet_total<>ledger_total then return 'ledger_mismatch'; end if;

  -- Released bindings are immutable history. An active legacy binding is also
  -- harmless when it represents the exact same balance. Fail closed for a
  -- restricted wallet, a missing wallet row, or any balance disagreement.
  if exists(
    select 1
    from public.device_wallet_bindings b
    left join public.device_point_wallets w on w.id=b.wallet_id
    where b.user_id=aid and b.released_at is null
      and (w.id is null or w.status<>'active' or w.balance<>wallet_total)
  ) then
    return 'wallet_binding';
  end if;

  if exists(select 1 from account_private.rewarded_ad_claims c
      where c.account_id=aid and c.processed_at is null and c.expires_at>now()) then
    return 'pending_reward';
  end if;
  if exists(select 1 from account_private.review_access r
      join account_private.account_identities b on b.auth_user_id=r.auth_user_id
      where b.account_id=aid and r.enabled and r.valid_until>now()) then
    return 'review_account';
  end if;

  return 'discardable';
end $$;

revoke all on function account_private.phone_recovery_disposition(uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
