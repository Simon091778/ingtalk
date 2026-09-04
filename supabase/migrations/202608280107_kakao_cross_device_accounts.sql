-- Extend 106's canonical-account recovery to the verified app-scoped Kakao
-- subject. Never use a nickname, email, phone number or device alone to merge.
-- Keep the existing Google flow and all device/session/reward guards unchanged.
do $$
declare definition text;
  old_guard text := $old$if aid is null and provider_name='google' then$old$;
  old_lookup text := $old$where provider='google' and auth_user_id=uid and identity_hash=ih;$old$;
begin
  definition:=pg_get_functiondef('account_private.authorize_identity(text,text,text,text)'::regprocedure);
  if position(old_guard in definition)=0 or position(old_lookup in definition)=0 then
    raise exception 'cross_device_identity_lookup_missing';
  end if;
  definition:=replace(definition,old_guard,$new$if aid is null and provider_name in ('google','kakao') then$new$);
  definition:=replace(definition,old_lookup,$new$where provider=provider_name and auth_user_id=uid and identity_hash=ih;$new$);
  definition:=replace(definition,'if a Google identity already','if a social identity already');
  execute definition;
end $$;
revoke all on function account_private.authorize_identity(text,text,text,text) from public,anon,authenticated;
notify pgrst,'reload schema';
