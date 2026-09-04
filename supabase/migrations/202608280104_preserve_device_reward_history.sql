-- A legacy key can upgrade into a previously recorded native scope. Never lose
-- the key's consumed welcome reward when that destination row already exists.
do $$
declare definition text; old_clause text:=$old$on conflict(scope_hash) do update set retain_until=now()+interval '1 year';$old$;
begin
  definition:=pg_get_functiondef('account_private.authorize_identity(text,text,text,text)'::regprocedure);
  if position(old_clause in definition)=0 then raise exception 'device_history_upgrade_clause_missing'; end if;
  execute replace(definition,old_clause,$new$on conflict(scope_hash) do update set
      welcome_used=account_private.device_enrollment_history.welcome_used or excluded.welcome_used,
      retain_until=now()+interval '1 year';$new$);
end $$;
