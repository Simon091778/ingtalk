begin;

-- Explicit provider linking may discard an unprofiled bootstrap shell, but it
-- must never merge two established canonical accounts.  The verified target
-- identity remains owned by its existing account and neither account is
-- mutated when this guard returns a conflict.
do $$
declare
  definition text:=pg_get_functiondef('public.finish_account_link(text,text,text,text)'::regprocedure);
  anchor text:=$anchor$if identity_count>1 and provider_name<>'phone' then return jsonb_build_object('error','account_link_conflict'); end if;$anchor$;
  replacement text:=$replacement$if identity_count>1 and provider_name<>'phone' then return jsonb_build_object('error','account_link_conflict'); end if;

  if other_id is not null
      and account_private.phone_recovery_disposition(r.account_id)<>'discardable'
      and account_private.phone_recovery_disposition(other_id)<>'discardable' then
    return jsonb_build_object('error','account_link_conflict');
  end if;$replacement$;
begin
  if position(anchor in definition)=0 then
    raise exception 'finish_account_link established-account guard anchor not found';
  end if;
  execute replace(definition,anchor,replacement);
end $$;

commit;
