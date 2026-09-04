begin;
do $$
declare definition text;
  marker text:=$replace$
    if scope_matches=1 then
      if phone_owner is not null and phone_owner<>scope_account then$replace$;
  replacement text:=$replace$
    if scope_matches=1 then
      select account_id,device_id into previous_id,previous_device
        from account_private.sessions where session_id=sid;
      if previous_id is not null and (previous_id<>scope_account or previous_device is distinct from
          (select v.id from account_private.account_devices v where v.account_id=scope_account and v.device_scope_hash=scope)) then
        return jsonb_build_object('error','reauthenticate_required');
      end if;
      if phone_owner is not null and phone_owner<>scope_account then$replace$;
begin
  definition:=pg_get_functiondef('account_private.authorize_identity(text,text,text,text)'::regprocedure);
  if position(marker in definition)=0 then raise exception 'authorize_identity_session_guard_target_missing'; end if;
  execute replace(definition,marker,replacement);
end $$;
commit;
