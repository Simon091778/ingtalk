-- A verified social identity is the durable owner during phone-account recovery.
-- Retire a phone-only account even when it contains ordinary content or has spent
-- free rewards. Paid/admin value, an inconsistent ledger, pending callbacks, and
-- identity ambiguity still require manual review. The canonical account never
-- receives the retired wallet or ledger; reward claim identities are unioned by
-- finish_account_link before delete_account_data removes the phone-only account.
create or replace function account_private.phone_recovery_disposition(aid uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare ledger_total bigint; wallet_total bigint;
begin
  if aid is null or (select count(*) from account_private.account_identities b where b.account_id=aid)<>1
    or not exists(select 1 from account_private.account_identities b where b.account_id=aid and b.provider='phone') then
    return 'identity_conflict';
  end if;

  -- Purchases and administrative grants/corrections are financial or audit
  -- records. Unknown ledger reasons fail closed instead of being discarded.
  if exists(select 1 from public.point_purchase_receipts r where r.user_id=aid) then
    return 'purchase_value';
  end if;
  if exists(select 1 from public.device_wallet_bindings d where d.user_id=aid) then
    return 'wallet_binding';
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

  if exists(select 1 from account_private.rewarded_ad_claims c
      where c.account_id=aid and c.processed_at is null and c.expires_at>now()) then
    return 'pending_reward';
  end if;
  if exists(select 1 from account_private.review_access r
      join account_private.account_identities b on b.auth_user_id=r.auth_user_id
      where b.account_id=aid and r.enabled and r.valid_until>now()) then
    return 'review_account';
  end if;

  -- Profile settings and ordinary chat/board activity belong to the disposable
  -- phone-only account. delete_account_data removes them; they are never merged
  -- into the verified Google/Kakao account.
  return 'discardable';
end $$;

revoke all on function account_private.phone_recovery_disposition(uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
