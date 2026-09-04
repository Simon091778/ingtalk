begin;

do $migration$
declare
  definition text:=pg_get_functiondef('public.finish_account_link(text,text,text,text)'::regprocedure);
  anchor text:=$old$    update account_private.account_link_requests set used_at=now() where token_hash=r.token_hash;
    return jsonb_build_object($old$;
  replacement text:=$new$    if provider_name='phone' then
      insert into account_private.phone_device_bindings(
        device_scope_hash,phone_identity_hash,account_id,auth_user_id,last_verified_at)
      values(scope,ih,r.account_id,uid,now())
      on conflict(device_scope_hash,phone_identity_hash) do update set
        account_id=excluded.account_id,auth_user_id=excluded.auth_user_id,last_verified_at=now();
    end if;
    update account_private.account_link_requests set used_at=now() where token_hash=r.token_hash;
    return jsonb_build_object($new$;
  tail_anchor text:=$old$  update account_private.account_link_requests set used_at=now() where token_hash=r.token_hash;
  return jsonb_build_object($old$;
  tail_replacement text:=$new$  if provider_name='phone' then
    insert into account_private.phone_device_bindings(
      device_scope_hash,phone_identity_hash,account_id,auth_user_id,last_verified_at)
    values(scope,ih,r.account_id,uid,now())
    on conflict(device_scope_hash,phone_identity_hash) do update set
      account_id=excluded.account_id,auth_user_id=excluded.auth_user_id,last_verified_at=now();
  end if;
  update account_private.account_link_requests set used_at=now() where token_hash=r.token_hash;
  return jsonb_build_object($new$;
begin
  if position(anchor in definition)=0 and position(tail_anchor in definition)=0 then
    raise exception 'finish_account_link success anchor not found';
  end if;
  definition:=replace(definition,anchor,replacement);
  execute replace(definition,tail_anchor,tail_replacement);
end $migration$;

commit;
