-- Keep the recovery transaction compatible with already shipped clients.
-- Older apps require account_id to equal the account that opened the ticket;
-- newer apps read recovered_account_id to show the canonical restored account.
do $migration$
declare definition text;
  old_clause text:=$old$return jsonb_build_object('ok',true,'account_id',other_id,'previous_account_id',r.account_id,
        'recovered_existing_account',true);$old$;
  new_clause text:=$new$return jsonb_build_object('ok',true,'account_id',r.account_id,'recovered_account_id',other_id,
        'previous_account_id',r.account_id,'recovered_existing_account',true);$new$;
begin
  definition:=pg_get_functiondef('public.finish_account_link(text,text,text,text)'::regprocedure);
  if position(old_clause in definition)=0 then raise exception 'social_recovery_response_clause_missing'; end if;
  execute replace(definition,old_clause,new_clause);
end $migration$;

notify pgrst,'reload schema';
