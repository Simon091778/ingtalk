begin;
do $$
declare definition text;
  marker text:='if attempts>10 then return jsonb_build_object(''error'',''recovery_rate_limited''); end if;';
  replacement text:=$replace$if attempts>10 and not (provider_name='phone' and exists(
          select 1 from account_private.account_devices known_device
          join account_private.phone_identity_history old_phone on old_phone.account_id=known_device.account_id
          where known_device.device_scope_hash=scope and old_phone.identity_hash=ih)) then
        return jsonb_build_object('error','recovery_rate_limited');
      end if;$replace$;
begin
  definition:=pg_get_functiondef('account_private.authorize_identity(text,text,text,text)'::regprocedure);
  if position(marker in definition)=0 then raise exception 'authorize_identity_recovery_limit_target_missing'; end if;
  execute replace(definition,marker,replacement);
end $$;
commit;
