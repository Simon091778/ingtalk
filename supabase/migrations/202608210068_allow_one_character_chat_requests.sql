-- Allow a non-blank, one-character opening message for both request paths.

alter table public.chat_requests
drop constraint if exists chat_requests_opening_message_check;

alter table public.chat_requests
add constraint chat_requests_opening_message_check
check (char_length(opening_message) between 1 and 200);

do $$
declare
  function_signature regprocedure;
  previous_definition text;
  next_definition text;
begin
  foreach function_signature in array array[
    'public.create_chat_request(uuid,text)'::regprocedure,
    'public.create_board_chat_request(uuid,uuid,text)'::regprocedure
  ] loop
    previous_definition := pg_get_functiondef(function_signature);
    next_definition := replace(
      previous_definition,
      'char_length(trim(opening_text)) < 2',
      'char_length(trim(opening_text)) < 1'
    );

    if next_definition = previous_definition then
      raise exception 'opening message validation was not found in %', function_signature;
    end if;

    execute next_definition;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
