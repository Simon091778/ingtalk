-- Keep conversation lists and unread badges current while a room is closed.
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';
