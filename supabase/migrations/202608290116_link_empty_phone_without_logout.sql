-- A disposable phone-only shell has no profile, wallet or app data to protect.
-- Let shipped clients proceed directly to fresh Google/Kakao verification;
-- established accounts still require recent source reauthentication.
do $migration$
declare definition text;
  old_clause text:=$old$if not account_private.fresh_identity(source.provider) then return jsonb_build_object('error','link_reauthentication_required'); end if;$old$;
  new_clause text:=$new$if not account_private.fresh_identity(source.provider) and not (
    source.provider='phone' and target_provider in ('google','kakao')
    and not exists(select 1 from public.profiles where id=aid)
    and not exists(select 1 from public.point_wallets where user_id=aid)
    and (select count(*) from account_private.account_identities where account_id=aid)=1
    and (select count(*) from account_private.account_devices where account_id=aid)=1
  ) then return jsonb_build_object('error','link_reauthentication_required'); end if;$new$;
begin
  definition:=pg_get_functiondef('public.begin_account_link_v2(text,text,text,text)'::regprocedure);
  if position(old_clause in definition)=0 then raise exception 'link_source_freshness_clause_missing'; end if;
  execute replace(definition,old_clause,new_clause);
end $migration$;

notify pgrst,'reload schema';
