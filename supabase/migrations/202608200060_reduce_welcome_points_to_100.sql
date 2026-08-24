-- Grant 100 points, rather than the legacy 1,000 points, on the first claim for a device.
-- Existing wallet balances are intentionally left unchanged.
create or replace function public.claim_device_welcome_points(device_fingerprint text)
returns table (awarded boolean, balance bigint)
language plpgsql security definer set search_path = public as $$
declare
  normalized_hash text := lower(trim(coalesce(device_fingerprint, '')));
  wallet_uuid uuid;
  wallet_balance bigint;
  inserted_count integer := 0;
  profile_already_claimed boolean;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if normalized_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_device_fingerprint'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then raise exception 'profile_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(normalized_hash, 0));
  select profile.welcome_points_claimed into profile_already_claimed
  from public.profiles profile where profile.id = auth.uid() for update;

  select wallet.id, wallet.balance into wallet_uuid, wallet_balance
  from public.device_point_wallets wallet where wallet.device_hash = normalized_hash for update;

  if wallet_uuid is null then
    insert into public.device_welcome_grants(device_hash) values (normalized_hash)
    on conflict (device_hash) do nothing;
    get diagnostics inserted_count = row_count;
    wallet_balance := coalesce((
      select point_wallet.balance
      from public.point_wallets point_wallet
      where point_wallet.user_id = auth.uid()
    ), 0);
    if inserted_count = 1 and not profile_already_claimed then wallet_balance := wallet_balance + 100; end if;
    insert into public.device_point_wallets(device_hash, balance, welcome_granted_at)
    values (normalized_hash, wallet_balance, case when inserted_count = 1 and not profile_already_claimed then now() end)
    returning id into wallet_uuid;
    if inserted_count = 1 and not profile_already_claimed then
      insert into public.point_transactions(user_id, amount, reason)
      values (auth.uid(), 100, 'welcome_device');
    end if;
  else
    update public.device_point_wallets wallet set last_seen_at = now() where wallet.id = wallet_uuid;
  end if;

  if exists (
    select 1 from public.device_wallet_bindings binding
    where binding.wallet_id = wallet_uuid and binding.released_at is null and binding.user_id <> auth.uid()
  ) then raise exception 'device_account_recovery_required'; end if;
  insert into public.device_wallet_bindings(wallet_id, user_id, recovery_reason)
  select wallet_uuid, auth.uid(), 'initial'
  where not exists (
    select 1 from public.device_wallet_bindings binding
    where binding.wallet_id = wallet_uuid and binding.released_at is null
  );

  update public.point_wallets point_wallet
  set balance = wallet_balance, updated_at = now()
  where point_wallet.user_id = auth.uid();
  update public.profiles profile
  set welcome_points_claimed = true, updated_at = now()
  where profile.id = auth.uid();
  update public.device_welcome_grants grant_record
  set last_seen_at = now()
  where grant_record.device_hash = normalized_hash;
  return query select inserted_count = 1 and not profile_already_claimed, wallet_balance;
end;
$$;

revoke all on function public.claim_device_welcome_points(text) from public, anon;
grant execute on function public.claim_device_welcome_points(text) to authenticated;

notify pgrst, 'reload schema';
