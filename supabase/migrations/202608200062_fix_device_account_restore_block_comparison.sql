-- Fix anonymous device-account recovery on PostgreSQL versions where the
-- previous `uuid IN (column, column)` predicate could be resolved as a
-- comparison against a `name[]` value.
do $$
declare
  function_definition text;
  fixed_definition text;
begin
  select pg_get_functiondef('public.restore_device_account(text)'::regprocedure)
  into function_definition;

  fixed_definition := replace(
    function_definition,
    'where previous_user in (blocker_id, blocked_id)',
    'where blocker_id = previous_user or blocked_id = previous_user'
  );

  if fixed_definition = function_definition
     and function_definition not like '%block.blocker_id = previous_user or block.blocked_id = previous_user%' then
    raise exception 'restore_device_account block predicate was not found';
  end if;

  if fixed_definition <> function_definition then
    execute fixed_definition;
  end if;
end;
$$;
