-- A failed recovery could leave a new anonymous profile created before the
-- device wallet claim. Permit recovery to replace only an unbound placeholder
-- profile, while still protecting a profile already bound to another wallet.
do $$
declare
  definition text;
  original_definition text;
begin
  select pg_get_functiondef('public.restore_device_account(text)'::regprocedure) into definition;
  original_definition := definition;
  definition := replace(
    definition,
    'if exists (select 1 from public.profiles where id = target_user_uuid) then raise exception ''recovery_target_already_has_profile''; end if;',
    'if exists (select 1 from public.profiles where id = target_user_uuid) then
      if exists (select 1 from public.device_wallet_bindings where user_id = target_user_uuid and released_at is null) then
        raise exception ''recovery_target_already_has_profile'';
      end if;
      delete from public.profiles where id = target_user_uuid;
    end if;'
  );
  definition := replace(
    definition,
    'update public.push_tokens set user_id = target_user_uuid where user_id = previous_user;',
    'update public.push_tokens set user_id = target_user_uuid where user_id = previous_user;
  update public.notification_preferences set user_id = target_user_uuid, updated_at = now() where user_id = previous_user;'
  );
  if definition = original_definition
    or position('recovery_target_already_has_profile''; end if;' in definition) > 0
    or position('update public.notification_preferences set user_id = target_user_uuid' in definition) = 0 then
    raise exception 'restore_device_account patch target was not found';
  end if;
  execute definition;
end;
$$;

revoke all on function public.restore_device_account(text) from public, anon;
grant execute on function public.restore_device_account(text) to authenticated;
notify pgrst, 'reload schema';
