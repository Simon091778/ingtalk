begin;

do $$
declare
  definition text:=pg_get_functiondef('public.finish_account_link(text,text,text,text)'::regprocedure);
  old_branch text:=$old$and account_private.phone_recovery_disposition(r.account_id)<>'discardable' then$old$;
  new_branch text:=$new$and account_private.phone_recovery_disposition(r.account_id)<>'discardable'
      and exists(select 1 from account_private.account_identities source_phone
        where source_phone.account_id=r.account_id
          and source_phone.auth_user_id=r.source_user
          and source_phone.provider='phone'
          and account_private.identity_active(source_phone)) then$new$;
begin
  if position(old_branch in definition)=0 then
    raise exception 'finish_account_link phone-source branch anchor not found';
  end if;
  execute replace(definition,old_branch,new_branch);
end $$;

commit;
