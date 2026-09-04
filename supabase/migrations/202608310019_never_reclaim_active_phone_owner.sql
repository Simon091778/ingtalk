begin;

do $$
declare
  definition text:=pg_get_functiondef('account_private.authorize_identity(text,text,text,text)'::regprocedure);
  old_rule text:=$old$if phone_owner is not null and phone_owner<>scope_account then
        if exists(select 1 from account_private.phone_identity_history h
            where h.account_id=scope_account and h.identity_hash=ih) then
          perform account_private.retire_phone_identity(phone_owner,ih,'return_to_known_device');
          phone_owner:=null;
        else
          return jsonb_build_object('error','phone_identity_conflict');
        end if;
      end if;$old$;
  new_rule text:=$new$if phone_owner is not null and phone_owner<>scope_account then
        return jsonb_build_object('error','phone_identity_conflict');
      end if;$new$;
begin
  if position(old_rule in definition)=0 then
    raise exception 'authorize_identity active-phone-owner guard anchor not found';
  end if;
  execute replace(definition,old_rule,new_rule);
end $$;

commit;
