begin;
do $$
declare definition text;
  old_scope_guard text:='if aid is null and provider_name=''phone'' and device_platform<>''web'' then';
  new_scope_guard text:='if aid is null and provider_name=''phone'' then';
  old_conflict text:=$replace$
      if phone_owner is not null and phone_owner<>scope_account then
        return jsonb_build_object('error','phone_identity_conflict');
      end if;$replace$;
  new_conflict text:=$replace$
      if phone_owner is not null and phone_owner<>scope_account then
        if exists(select 1 from account_private.phone_identity_history h
            where h.account_id=scope_account and h.identity_hash=ih) then
          perform account_private.retire_phone_identity(phone_owner,ih,'return_to_known_device');
          phone_owner:=null;
        else
          return jsonb_build_object('error','phone_identity_conflict');
        end if;
      end if;$replace$;
begin
  definition:=pg_get_functiondef('account_private.authorize_identity(text,text,text,text)'::regprocedure);
  if position(old_scope_guard in definition)=0 or position(old_conflict in definition)=0 then
    raise exception 'authorize_identity_known_device_patch_target_missing';
  end if;
  definition:=replace(replace(definition,old_scope_guard,new_scope_guard),old_conflict,new_conflict);
  execute definition;
end $$;
commit;
