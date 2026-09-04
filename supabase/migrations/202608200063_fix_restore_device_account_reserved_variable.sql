-- `current_user` is a PostgreSQL keyword that evaluates to the current role
-- name (type name). Using it as a UUID PL/pgSQL variable made expressions such
-- as `previous_user = current_user` resolve to `uuid = name` at runtime.
do $$
declare
  function_definition text;
  fixed_definition text;
begin
  select pg_get_functiondef('public.restore_device_account(text)'::regprocedure)
  into function_definition;

  fixed_definition := replace(
    function_definition,
    'current_user',
    'target_user_uuid'
  );

  if fixed_definition = function_definition
     and function_definition not like '%target_user_uuid uuid%' then
    raise exception 'restore_device_account reserved variable was not found';
  end if;

  if fixed_definition <> function_definition then
    execute fixed_definition;
  end if;
end;
$$;
