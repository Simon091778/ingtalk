begin;

do $migration$
declare
  definition text:=pg_get_functiondef('public.finish_account_link(text,text,text,text)'::regprocedure);
  identity_insert text:=$old$  insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash) values(r.account_id,uid,provider_name,ih);$old$;
  replacement text:=$new$  insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash) values(r.account_id,uid,provider_name,ih);
  if provider_name='phone' then
    insert into account_private.phone_device_bindings(
      device_scope_hash,phone_identity_hash,account_id,auth_user_id,last_verified_at)
    values(scope,ih,r.account_id,uid,now())
    on conflict(device_scope_hash,phone_identity_hash) do update set
      account_id=excluded.account_id,auth_user_id=excluded.auth_user_id,last_verified_at=now();
  end if;$new$;
begin
  if position(identity_insert in definition)=0 then raise exception 'simple link identity anchor not found'; end if;
  execute replace(definition,identity_insert,replacement);
end $migration$;

commit;
