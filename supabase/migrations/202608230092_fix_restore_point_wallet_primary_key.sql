-- A profile insert automatically creates point_wallets(target_user_uuid).
-- Reinstall recovery must merge the old balance into that row; changing the old
-- wallet's primary key to target_user_uuid collides with the trigger-created row.
do $$
declare
  definition text;
  original_definition text;
begin
  select pg_get_functiondef('public.restore_device_account(text)'::regprocedure)
  into definition;
  original_definition := definition;

  definition := replace(
    definition,
    'update public.point_wallets
  set user_id = target_user_uuid, balance = wallet.balance, updated_at = now()
  where user_id = previous_user;',
    'update public.point_wallets
  set balance = wallet.balance, updated_at = now()
  where user_id = target_user_uuid;
  if not found then
    raise exception ''recovery_target_wallet_missing'';
  end if;
  delete from public.point_wallets where user_id = previous_user;'
  );

  if definition = original_definition
    or position('set user_id = target_user_uuid, balance = wallet.balance' in definition) > 0
    or position('recovery_target_wallet_missing' in definition) = 0 then
    raise exception 'restore_device_account point wallet patch target was not found';
  end if;

  execute definition;
end;
$$;

revoke all on function public.restore_device_account(text) from public, anon;
grant execute on function public.restore_device_account(text) to authenticated;

-- Fail deployment if a future migration accidentally restores the conflicting
-- primary-key move.
do $$
declare definition text;
begin
  select pg_get_functiondef('public.restore_device_account(text)'::regprocedure) into definition;
  if position('set user_id = target_user_uuid, balance = wallet.balance' in definition) > 0
    or position('delete from public.point_wallets where user_id = previous_user' in definition) = 0 then
    raise exception 'unsafe restore_device_account wallet merge';
  end if;
end;
$$;

notify pgrst, 'reload schema';
